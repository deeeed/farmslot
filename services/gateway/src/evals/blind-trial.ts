import { readFile } from 'node:fs/promises';
import path from 'node:path';

import {
  type EvalBlindTrial,
  isFamilyDiffProvenance,
  isRecord,
  isTerminalRunStatus,
  type Run,
} from '@farmslot/protocol';

import { loadSlotVars, type SlotVars } from '../core/config.js';
import { execLocal, execOnSlot } from '../core/exec.js';
import { ownsRunSlotCleanup, readSlotRow } from '../core/state.js';
import { atomicWriteTextFile } from '../run-engine/diff-artifact-utils.js';
import { captureRunDiffSnapshot } from '../run-engine/diff-artifacts.js';
import { getRun, persistRunNow, updateRun } from '../runs/store.js';

import { type BlindGitSpec, buildBlindGitCommand } from './blind-git.js';
import {
  assertBlindProblem,
  buildBlindInputAuditCommand,
  FULL_COMMIT,
  stablePatchId,
} from './blind-inputs.js';
import { sha256Text } from './package-store.js';

function blindFor(run: Run): EvalBlindTrial {
  const blind = run.engineState?.evalExperiment?.blind;
  if (!blind)
    throw new Error(
      'This eval lacks blind-trial provenance. Create a new blind trial before executing a worker.',
    );
  return blind;
}

async function ownedEpoch(run: Run, expected?: number): Promise<number> {
  if (!run.slotId) throw new Error('Blind trial has no assigned slot.');
  const row = await readSlotRow(run.slotId);
  const epoch = Number(row?.slot_epoch);
  if (
    !row ||
    !Number.isInteger(epoch) ||
    !ownsRunSlotCleanup(row, run.id) ||
    row.phase === 'releasing' ||
    (expected !== undefined && epoch !== expected)
  )
    throw new Error('Blind trial no longer owns its slot epoch.');
  return epoch;
}

function gitSpec(
  run: Run,
  vars: SlotVars,
  blind: EvalBlindTrial,
  epoch: number,
  capsule: string,
): BlindGitSpec {
  if (!run.branch || run.slotId !== vars.slotId)
    throw new Error('Blind trial branch/slot identity is missing.');
  return {
    slotId: vars.slotId,
    slotEpoch: epoch,
    repo: vars.remoteRepo,
    capsule,
    runId: run.id,
    branch: run.branch,
    baseSha: blind.baseSha,
    referenceCommits: blind.referenceCommits,
  };
}

async function executeGit(
  action: Parameters<typeof buildBlindGitCommand>[0],
  vars: SlotVars,
  spec: BlindGitSpec,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const result = await execOnSlot(vars, buildBlindGitCommand(action, spec), {
    timeout: 15 * 60_000,
    signal,
  });
  if (result.exitCode !== 0)
    throw new Error(
      `Blind trial Git ${action} failed: ${result.stderr.trim() || result.stdout.trim()}`,
    );
  const value: unknown = JSON.parse(result.stdout);
  if (!isRecord(value) || typeof value.status !== 'string')
    throw new Error('Invalid blind trial Git receipt.');
  if (
    (action === 'isolate' || action === 'verify') &&
    (value.status !== 'isolated' || value.runId !== spec.runId || value.baseSha !== spec.baseSha)
  )
    throw new Error('Blind trial Git receipt does not match its execution.');
  return value;
}

function updateBlind(runId: string, blind: EvalBlindTrial): Run {
  const run = getRun(runId);
  const link = run?.engineState?.evalExperiment;
  if (!run || !link) throw new Error('Blind trial disappeared during its operation.');
  return updateRun(runId, {
    engineState: { ...run.engineState, evalExperiment: { ...link, blind } },
  });
}

export async function prepareBlindTrialGit(runId: string, signal?: AbortSignal): Promise<void> {
  const run = getRun(runId);
  if (!run?.engineState?.evalExperiment) return;
  const blind = blindFor(run);
  if (!run.slotId) throw new Error('Blind trial has no assigned slot.');
  const vars = await loadSlotVars(run.slotId);
  const epoch = await ownedEpoch(run);
  let isolation = blind.isolation;
  if (isolation && isolation.slotId !== vars.slotId)
    throw new Error('Blind trial isolation belongs to a different slot.');
  if (!isolation) {
    const planned = await executeGit('plan', vars, gitSpec(run, vars, blind, epoch, ''), signal);
    if (typeof planned.capsule !== 'string')
      throw new Error('Blind trial capsule location is missing.');
    await ownedEpoch(run, epoch);
    isolation = { slotId: vars.slotId, slotEpoch: epoch, capsulePath: planned.capsule };
    await persistRunNow(
      updateBlind(runId, { ...blind, isolation }),
      'blind trial isolation intent',
    );
  }
  await executeGit(
    'isolate',
    vars,
    gitSpec(run, vars, blind, isolation.slotEpoch, isolation.capsulePath),
    signal,
  );
  await ownedEpoch(run, epoch);
  await persistRunNow(
    updateBlind(runId, {
      ...blind,
      isolation: { ...isolation, verifiedAt: new Date().toISOString() },
    }),
    'blind trial Git isolated',
  );
}

export async function auditBlindTrialTask(
  run: Run,
  taskRoot: string,
  vars?: SlotVars,
): Promise<void> {
  if (!run.engineState?.evalExperiment) return;
  const blind = blindFor(run);
  const problem = assertBlindProblem(run.ticketData?.description, blind.forbiddenInputs);
  if (sha256Text(problem) !== blind.problemDigest)
    throw new Error('Blind trial problem statement changed.');
  const command = buildBlindInputAuditCommand(taskRoot, blind.forbiddenInputs);
  const result = vars
    ? await execOnSlot(vars, command, { timeout: 30_000 })
    : await execLocal(command, { timeout: 30_000 });
  if (result.exitCode !== 0)
    throw new Error(
      `Blind trial worker inputs are invalid: ${result.stderr.trim() || result.stdout.trim()}`,
    );
}

async function verifyBlindTrialGit(run: Run): Promise<void> {
  if (!run.engineState?.evalExperiment) return;
  const blind = blindFor(run);
  const isolation = blind.isolation;
  if (!isolation?.verifiedAt) throw new Error('Blind trial Git preparation has not been verified.');
  // Prepare and dispatch legitimately claim successive epochs for this same run.
  // Fence each operation on its current epoch; keep the capsule's creation identity.
  const epoch = await ownedEpoch(run);
  const vars = await loadSlotVars(isolation.slotId);
  await executeGit(
    'verify',
    vars,
    gitSpec(run, vars, blind, isolation.slotEpoch, isolation.capsulePath),
  );
  await ownedEpoch(run, epoch);
}

export async function verifyBlindTrialForDispatch(run: Run, retained = false): Promise<void> {
  if (!run.engineState?.evalExperiment) return;
  await verifyBlindTrialGit(run);
  // The same retained worker may have candidate commits; isolation still applies.
  if (retained) return;
  const blind = blindFor(run);
  const vars = await loadSlotVars(blind.isolation!.slotId);
  const checkout = await execOnSlot(vars, `git rev-parse HEAD && git status --porcelain`, {
    timeout: 30_000,
  });
  if (checkout.exitCode !== 0 || checkout.stdout.trim() !== blind.baseSha)
    throw new Error('Blind trial checkout differs from its base before worker launch.');
}

const firstOutputCaptures = new Map<string, Promise<void>>();

export function freezeBlindTrialFirstOutput(runId: string): Promise<void> {
  const active = firstOutputCaptures.get(runId);
  if (active) return active;
  const capture = captureFirstOutput(runId).finally(() => firstOutputCaptures.delete(runId));
  firstOutputCaptures.set(runId, capture);
  return capture;
}

async function captureFirstOutput(runId: string): Promise<void> {
  const run = getRun(runId);
  const link = run?.engineState?.evalExperiment;
  if (!run || !link) return;
  const blind = blindFor(run);
  if (blind.firstOutput) {
    if (
      sha256Text(await readFile(blind.firstOutput.diffPath, 'utf8')) !==
      blind.firstOutput.diffSha256
    )
      throw new Error('Frozen first-output diff changed.');
    return;
  }
  const isolation = blind.isolation;
  if (!isolation?.verifiedAt) throw new Error('Blind first output lacks verified isolation.');
  const captureEpoch = await ownedEpoch(run);
  const assertOwner = async () => {
    const current = getRun(runId);
    if (!current || isTerminalRunStatus(current.status) || current.slotId !== run.slotId)
      throw new Error('Blind first output lost its active run.');
    await ownedEpoch(current, captureEpoch);
  };
  await assertOwner();
  const diffPath = path.join(path.dirname(link.packagePath), 'first-output.diff');
  const checkpointPath = path.join(path.dirname(link.packagePath), 'first-output.json');
  let checkpoint: unknown;
  try {
    checkpoint = JSON.parse(await readFile(checkpointPath, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  let firstOutput: NonNullable<EvalBlindTrial['firstOutput']>;
  let diffText: string;
  let invalidReason: string | undefined;
  if (checkpoint !== undefined) {
    if (
      !isRecord(checkpoint) ||
      checkpoint.runId !== runId ||
      typeof checkpoint.slotEpoch !== 'number' ||
      checkpoint.slotEpoch < isolation.slotEpoch ||
      checkpoint.baseSha !== blind.baseSha ||
      typeof checkpoint.diffText !== 'string' ||
      !isRecord(checkpoint.firstOutput)
    )
      throw new Error('Blind first-output checkpoint has a different owner.');
    const output = checkpoint.firstOutput;
    if (
      typeof output.headSha !== 'string' ||
      !FULL_COMMIT.test(output.headSha) ||
      typeof output.capturedAt !== 'string' ||
      output.diffPath !== diffPath ||
      typeof output.diffSha256 !== 'string' ||
      output.diffSha256 !== sha256Text(checkpoint.diffText) ||
      typeof output.patchId !== 'string' ||
      output.patchId !== (await stablePatchId(checkpoint.diffText)) ||
      !isFamilyDiffProvenance(output.diff) ||
      output.diff.baseSha !== blind.baseSha ||
      output.diff.headSha !== output.headSha ||
      (checkpoint.invalidReason !== undefined && typeof checkpoint.invalidReason !== 'string')
    )
      throw new Error('Frozen first-output checkpoint changed.');
    firstOutput = {
      headSha: output.headSha,
      capturedAt: output.capturedAt,
      diffPath,
      diffSha256: output.diffSha256,
      patchId: output.patchId,
      diff: output.diff,
    };
    diffText = checkpoint.diffText;
    invalidReason = checkpoint.invalidReason;
  } else {
    if (run.steps.some((step) => step.name === 'review' && step.startedAt))
      invalidReason = 'First output was not frozen before review started.';
    try {
      await verifyBlindTrialGit(run);
    } catch (error) {
      // Retain failed isolation as invalid evidence, but never cross an ownership boundary.
      invalidReason ??= (error as Error).message;
    }
    await assertOwner();
    const snapshot = await captureRunDiffSnapshot(run);
    await assertOwner();
    if (!snapshot.headSha || snapshot.baseSha !== blind.baseSha || snapshot.diffText === undefined)
      throw new Error('First-output contribution could not be captured against the blind base.');
    const { diffText: capturedDiff, ...diff } = snapshot;
    diffText = capturedDiff;
    firstOutput = {
      headSha: snapshot.headSha,
      capturedAt: new Date().toISOString(),
      diffPath,
      diffSha256: sha256Text(diffText),
      patchId: await stablePatchId(diffText),
      diff,
    };
    await assertOwner();
    // One atomic checkpoint binds bytes and provenance before the run JSON write.
    // A restart reuses this exact first output rather than recapturing a later fix.
    await atomicWriteTextFile(
      checkpointPath,
      JSON.stringify({
        runId,
        slotEpoch: captureEpoch,
        baseSha: blind.baseSha,
        firstOutput,
        diffText,
        invalidReason,
      }),
    );
  }
  await assertOwner();
  await atomicWriteTextFile(diffPath, diffText);
  await assertOwner();
  await persistRunNow(
    updateBlind(runId, { ...blind, invalidReason, firstOutput }),
    'blind trial first output frozen',
  );
}

export async function restoreBlindTrialGit(
  run: Run,
  vars: SlotVars,
  epoch: number,
  assertOwnership: () => Promise<void>,
): Promise<void> {
  const blind = run.engineState?.evalExperiment?.blind;
  const isolation = blind?.isolation;
  if (!blind || !isolation) return;
  if (isolation.slotId !== vars.slotId)
    throw new Error('Blind trial restoration does not own this slot.');
  await assertOwnership();
  if (Number((await readSlotRow(vars.slotId))?.slot_epoch) !== epoch)
    throw new Error('Blind trial restoration lost its entry epoch.');
  const receipt = await executeGit(
    'restore',
    vars,
    gitSpec(run, vars, blind, isolation.slotEpoch, isolation.capsulePath),
  );
  if (
    (receipt.status !== 'restored' && receipt.status !== 'absent') ||
    (receipt.status === 'absent' && isolation.verifiedAt)
  )
    throw new Error('Blind trial Git restoration was not confirmed.');
  await assertOwnership();
}
