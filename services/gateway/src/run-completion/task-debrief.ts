import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import path from 'node:path';

import {
  type AgentContext,
  type ArtifactRef,
  Events,
  type ManagedTaskDebrief,
  type Run,
  type RunArtifactBundleRef,
  TASK_DIRECTORY_LAYOUT as layout,
  type TaskDebrief,
} from '@farmslot/protocol';
import {
  readRetainedRunBundle,
  readRunBundleDebrief,
  resolveRetainedRunBundleRef,
  retainRunBundleDebrief,
} from '@farmslot/run-bundle';

import {
  collectTaskDebrief,
  completeTaskDebrief,
  debriefPath,
  resolveDebriefScrubOptions,
  scrubDebriefText,
  settleTaskDebrief,
  type TaskDebriefOptions,
  type TaskDebriefRequest,
  validateTaskDebrief,
} from '../../../../packages/handoff/src/debrief/index.js';
import { selectAgentContext } from '../agents/contexts.js';
import { assertHeavyWriteRoom } from '../core/heavy-write-room.js';
import { ownsRunSlotCleanup, readSlotRow } from '../core/index.js';
import { resolveAuth } from '../llm/auth-resolve.js';
import { callLLM, piModels } from '../llm/index.js';
import { readRetainedDebriefConversation } from '../runners/debrief-context.js';
import { commitRunTaskDebrief, getAllRuns, getRun } from '../runs/store.js';

import { retentionPolicy, runBundleStore, runBundleStoreRoot } from './retained-artifacts.js';

type TaskDebriefPreparation = Extract<ManagedTaskDebrief, { status: 'preparing' }>;
type PreparedTaskDebrief = Exclude<ManagedTaskDebrief, TaskDebriefPreparation>;
type TaskDebriefAcceptancePatch = Pick<Run, 'taskDebrief' | 'priorTaskDebriefBundles'>;

const TIMEOUT_MS = 60_000;
const active = new Set<string>();
const acceptedFiles = [
  layout.checklist.relativePath,
  layout.signal.relativePath,
  layout.terminalContract.relativePath,
  layout.report.relativePath,
  layout.prDescription.relativePath,
  layout.noChangeReport.relativePath,
];

function sameSubject(run: Run | undefined, journal: ManagedTaskDebrief): boolean {
  const accepted = run?.taskDebrief;
  return (
    accepted !== undefined &&
    accepted.debriefId === journal.debriefId &&
    accepted.attemptId === journal.attemptId &&
    accepted.contextId === journal.contextId &&
    accepted.generation === journal.generation &&
    accepted.manifestDigest === journal.manifestDigest &&
    accepted.bundle.bundleDigest === journal.bundle.bundleDigest
  );
}

function assertSubject(run: Run | undefined, journal: ManagedTaskDebrief): void {
  if (!sameSubject(run, journal))
    throw new Error('A later accepted worker result superseded the debrief.');
}

export function presentTaskDebriefHistory(run: Run): Run {
  if (!run.priorTaskDebriefBundles) return run;
  return {
    ...run,
    priorTaskDebriefs: Object.values(run.priorTaskDebriefBundles).map((bundle) => ({
      bundle: resolveRetainedRunBundleRef(run, bundle),
      status: 'stale',
    })),
  };
}

export function taskDebriefEvidenceBundle(
  run: Run,
  selected: RunArtifactBundleRef,
  pinned: boolean,
): RunArtifactBundleRef {
  const journal = run.taskDebrief;
  return !pinned && journal?.status === 'settled'
    ? resolveRetainedRunBundleRef(run, journal.bundle)
    : selected;
}

function readSidecar(run: Run, ref: RunArtifactBundleRef): TaskDebrief | undefined {
  const sidecar = readRunBundleDebrief(runBundleStoreRoot(), run.id, ref.bundleDigest);
  return sidecar && validateTaskDebrief(JSON.parse(sidecar.bytes.toString('utf8')));
}

export function readTaskDebriefSidecar(
  run: Run,
  ref: RunArtifactBundleRef,
):
  | {
      artifact: ArtifactRef;
      bytes: string;
      record: TaskDebrief;
    }
  | undefined {
  const record = readSidecar(run, ref);
  if (!record) return undefined;
  if (record.identity.runId !== run.id) throw new Error('Debrief sidecar run identity mismatch.');
  const bytes = JSON.stringify(record, null, 2) + '\n';
  return {
    bytes,
    record,
    artifact: {
      path: debriefPath,
      purpose: 'evidence',
      availability: 'available',
      bundleDigest: ref.bundleDigest,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      sizeBytes: Buffer.byteLength(bytes),
    },
  };
}

async function retainedRequest(
  run: Run,
  subject: Pick<ManagedTaskDebrief, 'bundle' | 'manifestDigest' | 'attemptId' | 'reportPath'>,
): Promise<{ request: TaskDebriefRequest; options: TaskDebriefOptions }> {
  const ref = resolveRetainedRunBundleRef(run, subject.bundle);
  const bundle = await readRetainedRunBundle(await runBundleStore(), ref, run.id);
  const files = [...acceptedFiles, ...(subject.reportPath ? [subject.reportPath] : [])];
  const fileDigests = new Map<string, string>();
  const mirroredPaths = new Map<string, string>();
  const mirrors = new Map<string, string>([
    [layout.checklist.relativePath, layout.checklistWorkerMirror.relativePath],
    [layout.signal.relativePath, layout.workerSignalMirror.relativePath],
  ]);
  for (const relative of files) {
    const mirror = mirrors.get(relative);
    const mirrored = mirror && bundle.manifest.entries[`tasks/${ref.taskKey}/${mirror}`];
    if (mirrored) {
      fileDigests.set(relative, mirrored.sha256);
      mirroredPaths.set(relative, mirror);
    } else {
      const entry = bundle.manifest.entries[`tasks/${ref.taskKey}/${relative}`];
      if (entry) fileDigests.set(relative, entry.sha256);
    }
  }
  const options: TaskDebriefOptions = {
    scrub: resolveDebriefScrubOptions(),
    retained: {
      runId: run.id,
      attemptId: subject.attemptId,
      manifestDigest: subject.manifestDigest,
      reportPath: subject.reportPath,
      fileDigests,
      mirroredPaths,
    },
    template: run.executionTemplate,
    tokens: {
      home: homedir(),
      farmslotHome: process.env.FARMSLOT_HOME,
      workspace: run.taskFile ? path.dirname(run.taskFile) : undefined,
    },
  };
  return { request: collectTaskDebrief(bundle.taskDir, options), options };
}

export function acceptedTaskDebriefPatch(run: Run): TaskDebriefAcceptancePatch {
  if (run.executionTemplate?.postRunDebrief !== true || run.readOnly) return {};
  const context = selectAgentContext(run);
  const output = run.output;
  const prior = run.taskDebrief;
  const bundle = output?.workerFinished && !output.captureError ? output.artifactBundle : undefined;
  const attemptId = context?.signalAttemptId;
  // A recapture can change gateway-owned metadata. Keep the original bundle for this accepted attempt.
  if (
    bundle &&
    attemptId &&
    prior?.attemptId === attemptId &&
    prior.contextId === context?.id &&
    prior.manifestDigest === output?.manifestDigest
  )
    return {};
  const taskDebrief: TaskDebriefPreparation | undefined =
    bundle && output && context && attemptId
      ? {
          status: 'preparing',
          bundle,
          manifestDigest: output.manifestDigest,
          reportPath: output.reportPath,
          attemptId,
          generation: run.engineState?.generation ?? 0,
          contextId: context.id,
          runner: context.runner ?? undefined,
          sessionId: context.runnerSessionId ?? undefined,
        }
      : undefined;
  if (!taskDebrief && !prior) return {};
  return {
    taskDebrief,
    priorTaskDebriefBundles:
      prior && prior.bundle.bundleDigest !== taskDebrief?.bundle.bundleDigest
        ? { ...run.priorTaskDebriefBundles, [prior.bundle.bundleDigest]: prior.bundle }
        : run.priorTaskDebriefBundles,
  };
}

export async function prepareDebriefForAcceptedResult(run: Run): Promise<void> {
  const patch = acceptedTaskDebriefPatch(run);
  const subject = patch.taskDebrief;
  if (subject?.status !== 'preparing') return;
  const prior = run.taskDebrief;
  try {
    const { request } = await retainedRequest(run, subject);
    const prepared: PreparedTaskDebrief = {
      ...subject,
      status: 'prepared',
      debriefId: request.requestId,
    };
    await commitRunTaskDebrief(
      run.id,
      () => ({ ...patch, taskDebrief: prepared }),
      (latest) => {
        const current = selectAgentContext(latest);
        if (
          !latest.output?.workerFinished ||
          latest.output.captureError ||
          latest.output.manifestDigest !== subject.manifestDigest ||
          latest.output.artifactBundle?.bundleDigest !== subject.bundle.bundleDigest ||
          current?.id !== subject.contextId ||
          current.signalAttemptId !== subject.attemptId ||
          (latest.engineState?.generation ?? 0) !== subject.generation ||
          (prior ? !sameSubject(latest, prior) : latest.taskDebrief !== undefined)
        )
          throw new Error('Accepted worker result changed during debrief preparation.');
      },
    );
  } catch (error) {
    // Optional collection can fail independently of acceptance and slot release.
    console.warn(`[debrief] collection failed for ${run.id}: ${(error as Error).message}`);
  }
}

async function awaitAnswer(
  run: Run,
  journal: PreparedTaskDebrief,
  request: TaskDebriefRequest,
  options: TaskDebriefOptions,
  context: AgentContext,
): Promise<TaskDebrief> {
  let conversation: Awaited<ReturnType<typeof readRetainedDebriefConversation>>;
  try {
    conversation = await readRetainedDebriefConversation(run, context, journal);
  } catch (error) {
    // A missing or damaged archive cannot authorize a continuation.
    request.record.collection.coverage.retainedConversation = { status: 'invalid' };
    console.warn(`[debrief] retained conversation refused for ${run.id}: ${(error as Error).name}`);
  }
  if (conversation)
    request.record.collection.coverage.retainedConversation = {
      status: 'present',
      sha256: conversation.sha256,
    };
  const route = conversation?.route;
  const excerpt = conversation && scrubDebriefText(conversation.lines.join('\n'), options);
  if (!route || excerpt === undefined || !excerpt || run.metrics.providerAccountLabel) {
    return settleTaskDebrief(
      request,
      'unsupported',
      'Matching conversation and provider authorization are required.',
    );
  }
  const models = await piModels();
  if (!models.getModel(route.provider, route.model) || !(await resolveAuth(route.provider)))
    return settleTaskDebrief(
      request,
      'unsupported',
      'The original model is unavailable through an authorized text provider.',
    );
  await commitRunTaskDebrief(
    run.id,
    () => ({ taskDebrief: { ...journal, status: 'submitted' } }),
    (current) => {
      assertSubject(current, journal);
      if (current.taskDebrief?.status !== 'prepared')
        throw new Error('Task debrief dispatch intent already exists.');
    },
  );
  const dispatch = getRun(run.id);
  assertSubject(dispatch, journal);
  if (dispatch?.taskDebrief?.status !== 'submitted')
    throw new Error('Task debrief dispatch intent was superseded.');
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  try {
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error('Task debrief provider deadline exceeded.'));
      }, TIMEOUT_MS);
    });
    const result = await Promise.race([
      callLLM({
        ...route,
        userPrompt: `${request.prompt}\n\nQuoted retained conversation (JSON lines):\n${excerpt}`,
        usageRole: 'task-debrief',
        maxTokens: 2400,
        allowCliFallback: false,
        signal: controller.signal,
      }),
      deadline,
    ]);
    if (Buffer.byteLength(result.text) > 128 * 1024)
      return settleTaskDebrief(request, 'failed', 'The worker answer exceeded the response limit.');
    const value: unknown = JSON.parse(result.text);
    return completeTaskDebrief(request, value, options);
  } catch (error) {
    // The accepted result stands even when the optional provider response fails.
    return controller.signal.aborted
      ? settleTaskDebrief(request, 'timeout', 'The provider exceeded the debrief deadline.')
      : settleTaskDebrief(
          request,
          'failed',
          `The provider response could not be used (${(error as Error).name}).`,
        );
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function settleAfterRelease(
  run: Run,
  journal: PreparedTaskDebrief,
  { request, options }: Awaited<ReturnType<typeof retainedRequest>>,
): Promise<void> {
  const ref = resolveRetainedRunBundleRef(run, journal.bundle);
  if (request.requestId !== journal.debriefId)
    throw new Error('Accepted task evidence changed before debrief settlement.');
  let record = readSidecar(run, ref);
  if (record) {
    // A restart between sealing bytes and persisting the terminal journal recovers the receipt.
    validateTaskDebrief(record, request);
  } else {
    const context = selectAgentContext(run, { contextId: journal.contextId });
    if (!request.record.requestedObservationIds.length)
      record = settleTaskDebrief(request, 'no-observations');
    else if (request.record.identity.binding !== 'hosted' || !context)
      record = settleTaskDebrief(
        request,
        'unsupported',
        'Accepted-result evidence could not be verified.',
      );
    else if (journal.status === 'submitted')
      record = settleTaskDebrief(
        request,
        'failed',
        'Provider dispatch was uncertain after restart.',
      );
    else record = await awaitAnswer(run, journal, request, options, context);
    await assertHeavyWriteRoom(runBundleStoreRoot());
    await retainRunBundleDebrief(await runBundleStore(), ref, record, await retentionPolicy(), () =>
      assertSubject(getRun(run.id), journal),
    );
  }
  const outcome = record.outcome.status;
  await commitRunTaskDebrief(
    run.id,
    () => ({ taskDebrief: { ...journal, status: 'settled', outcome } }),
    (current) => assertSubject(current, journal),
  );
  const { broadcastEvent } = await import('../server.js');
  broadcastEvent(Events.RUN_UPDATED, { run: getRun(run.id) });
}

export function continueTaskDebriefAfterRelease(runId: string): void {
  continueTaskDebrief(runId, false);
}

function continueTaskDebrief(runId: string, recoverRelease: boolean): void {
  const run = getRun(runId);
  const initial = run?.taskDebrief;
  if (
    !run ||
    !initial ||
    initial.status === 'settled' ||
    initial.status === 'stale' ||
    active.has(runId)
  )
    return;
  active.add(runId);
  let journal = initial;
  void (async () => {
    let slot = run.slotId && (await readSlotRow(run.slotId));
    if (!sameSubject(getRun(runId), journal)) return;
    if (
      recoverRelease &&
      journal.status === 'preparing' &&
      run.status === 'done' &&
      run.resultDecisionReceipt?.action === 'accept-result' &&
      ownsRunSlotCleanup(slot || null, runId)
    ) {
      // Acceptance can be durable before its owner-bound teardown starts.
      const { releaseCompletedRunSlot } = await import('../methods/run/lifecycle-control.js');
      if (!sameSubject(getRun(runId), journal)) return;
      await releaseCompletedRunSlot(run);
      slot = run.slotId && (await readSlotRow(run.slotId));
    }
    if (run.slotId && (!slot || ownsRunSlotCleanup(slot, run.id) || slot.handoff_run_id === run.id))
      return;
    if (!sameSubject(getRun(runId), journal)) return;
    const preparedInput = await retainedRequest(run, journal);
    if (journal.status === 'preparing') {
      const pending = journal;
      const prepared: PreparedTaskDebrief = {
        ...pending,
        debriefId: preparedInput.request.requestId,
        status: 'prepared',
      };
      await commitRunTaskDebrief(
        runId,
        () => ({ taskDebrief: prepared }),
        (latest) => assertSubject(latest, pending),
      );
      journal = prepared;
    }
    await settleAfterRelease(run, journal, preparedInput);
  })()
    .catch((error: unknown) => {
      // Keep the durable intent available for reconciliation and leave completion alone.
      console.warn(`[debrief] settlement failed for ${runId}: ${(error as Error).message}`);
    })
    .finally(() => {
      active.delete(runId);
      const latest = getRun(runId);
      if (latest?.taskDebrief && !sameSubject(latest, journal))
        continueTaskDebriefAfterRelease(runId);
    });
}

export function resumeAcceptedTaskDebriefs(): void {
  for (const run of getAllRuns()) if (run.taskDebrief) continueTaskDebrief(run.id, true);
}

export async function currentTaskDebriefForCuration(run: Run): Promise<TaskDebrief | undefined> {
  const journal = run.taskDebrief;
  if (journal?.status !== 'settled') return undefined;
  try {
    const acceptedRef = resolveRetainedRunBundleRef(run, journal.bundle);
    const record = readSidecar(run, acceptedRef);
    if (!record) throw new Error('Settled task debrief is missing.');
    if (
      record.identity.binding !== 'hosted' ||
      !record.identity.template ||
      !record.workflowCandidates.length
    )
      return undefined;
    const { request } = await retainedRequest(run, journal);
    if (!sameSubject(getRun(run.id), journal)) return undefined;
    return validateTaskDebrief(record, request);
  } catch (error) {
    // Optional evidence must never suppress the established Learnings path.
    console.warn(`[debrief] invalid curation evidence for ${run.id}: ${(error as Error).name}`);
    return undefined;
  }
}

export async function admitTaskDebriefCandidates(
  runId: string,
  decisionId: string,
  debriefId: string,
  keys: readonly string[],
): Promise<ReadonlySet<string>> {
  const none: ReadonlySet<string> = new Set();
  const journal = getRun(runId)?.taskDebrief;
  if (journal?.status !== 'settled' || journal.debriefId !== debriefId || !keys.length) return none;
  const decisionAdmission = (run: Run) => {
    const payload = run.decisions.find(({ id }) => id === decisionId)?.payload;
    return payload?.kind === 'improvement' && payload.analysisStatus === 'analyzing'
      ? payload
      : undefined;
  };
  const run = getRun(runId)!;
  const job = decisionAdmission(run);
  if (!job) return none;
  if (job.debriefAdmission)
    return job.debriefAdmission.debriefId === debriefId
      ? new Set(job.debriefAdmission.candidateKeys)
      : none;
  if (keys.every((key) => journal.admittedCandidateKeys?.includes(key))) return none;
  try {
    const committed = await commitRunTaskDebrief(
      runId,
      (current) => {
        const payload = decisionAdmission(current)!;
        if (payload.debriefAdmission) return {};
        const accepted = current.taskDebrief;
        if (accepted?.status !== 'settled') return {};
        const previous = new Set(accepted.admittedCandidateKeys);
        const candidateKeys = keys.filter((key) => !previous.has(key));
        if (!candidateKeys.length) return {};
        return {
          taskDebrief: { ...accepted, admittedCandidateKeys: [...previous, ...candidateKeys] },
          decisions: current.decisions.map((decision) =>
            decision.id === decisionId
              ? {
                  ...decision,
                  payload: { ...payload, debriefAdmission: { debriefId, candidateKeys } },
                }
              : decision,
          ),
        };
      },
      (current) => {
        assertSubject(current, journal);
        if (!decisionAdmission(current)) throw new Error('Improvement decision stopped analyzing.');
      },
    );
    const latest = getRun(runId);
    const receipt =
      latest && sameSubject(latest, journal)
        ? decisionAdmission(committed)?.debriefAdmission
        : undefined;
    return receipt?.debriefId === debriefId ? new Set(receipt.candidateKeys) : none;
  } catch (error) {
    // Keep the established Learnings path available if ownership changed during admission.
    console.warn(`[debrief] curation admission refused for ${runId}: ${(error as Error).name}`);
    return none;
  }
}
