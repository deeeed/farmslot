import { createHash } from 'node:crypto';
import { lstatSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

import {
  collectTaskDebrief,
  completeTaskDebrief,
  debriefPath,
  readTaskDebrief,
  scrubDebriefText,
  settleTaskDebrief,
  type TaskDebriefOptions,
  type TaskDebriefRequest,
  validateTaskDebrief,
  writeTaskDebrief,
} from '@farmslot/handoff';
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
  resolveRetainedRunBundleRef,
  runBundleDebriefDirectory,
} from '@farmslot/run-bundle';

import { selectAgentContext } from '../agents/contexts.js';
import { assertHeavyWriteRoom } from '../core/heavy-write-room.js';
import { ownsRunSlotCleanup, readSlotRow } from '../core/index.js';
import { resolveAuth } from '../llm/auth-resolve.js';
import { callLLM, piModels } from '../llm/index.js';
import { readRetainedDebriefConversation } from '../runners/debrief-context.js';
import { getAllRuns, getRun, persistRunNow, updateRun } from '../runs/store.js';

import { runBundleStore, runBundleStoreRoot } from './retained-artifacts.js';

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

function sameSubject(run: Run, journal: ManagedTaskDebrief): boolean {
  const context = selectAgentContext(run, { contextId: journal.contextId });
  return context?.runId === run.id && context.signalAttemptId === journal.attemptId;
}

export function taskDebriefRunStatus(run: Run): ManagedTaskDebrief['status'] | undefined {
  const journal = run.taskDebrief;
  return journal && (sameSubject(run, journal) ? journal.status : 'stale');
}

export function taskDebriefEvidenceBundle(
  run: Run,
  selected: RunArtifactBundleRef,
  pinned: boolean,
): RunArtifactBundleRef {
  const journal = run.taskDebrief;
  return !pinned && journal && sameSubject(run, journal)
    ? resolveRetainedRunBundleRef(run, journal.bundle)
    : selected;
}

function readSidecar(run: Run, ref: RunArtifactBundleRef): TaskDebrief | undefined {
  try {
    const directory = runBundleDebriefDirectory(runBundleStoreRoot(), run.id, ref.bundleDigest);
    lstatSync(path.join(directory, debriefPath));
    return readTaskDebrief(directory);
  } catch (error) {
    // A first-time or opted-out run has no sidecar.
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
    throw error;
  }
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
    [layout.checklist.relativePath, layout.workerChecklistMirror.relativePath],
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

async function patchJournal(run: Run, journal: ManagedTaskDebrief, reason: string): Promise<void> {
  const previous = run.taskDebrief;
  const archived =
    previous && previous.bundle.bundleDigest !== journal.bundle.bundleDigest
      ? { ...run.priorTaskDebriefBundles, [previous.bundle.bundleDigest]: previous.bundle }
      : run.priorTaskDebriefBundles;
  await persistRunNow(
    updateRun(run.id, { taskDebrief: journal, priorTaskDebriefBundles: archived })!,
    reason,
  );
}

export async function prepareAcceptedTaskDebrief(run: Run): Promise<void> {
  if (
    run.executionTemplate?.postRunDebrief !== true ||
    !run.output?.workerFinished ||
    !run.output.artifactBundle ||
    run.output.captureError ||
    run.readOnly
  )
    return;
  const context = selectAgentContext(run);
  if (!context?.signalAttemptId) return;
  const prior = run.taskDebrief;
  if (prior && sameSubject(run, prior)) return;
  const subject = {
    bundle: run.output.artifactBundle,
    manifestDigest: run.output.manifestDigest,
    attemptId: context.signalAttemptId,
    reportPath: run.output.reportPath,
  };
  const { request } = await retainedRequest(run, subject);
  const latest = getRun(run.id);
  if (
    !latest ||
    latest.output?.manifestDigest !== subject.manifestDigest ||
    selectAgentContext(latest)?.signalAttemptId !== subject.attemptId ||
    (latest.engineState?.generation ?? 0) !== (run.engineState?.generation ?? 0)
  )
    return;
  if (latest.taskDebrief && sameSubject(latest, latest.taskDebrief)) return;
  await patchJournal(
    latest,
    {
      ...subject,
      debriefId: request.requestId,
      generation: latest.engineState?.generation ?? 0,
      contextId: context.id,
      runner: context.runner ?? undefined,
      sessionId: context.runnerSessionId ?? undefined,
      status: 'prepared',
    },
    'accepted task debrief prepared',
  );
}

async function awaitAnswer(
  run: Run,
  journal: ManagedTaskDebrief,
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
  const latest = getRun(run.id);
  if (
    !latest ||
    latest.taskDebrief?.debriefId !== journal.debriefId ||
    !sameSubject(latest, journal)
  ) {
    return settleTaskDebrief(request, 'failed', 'A later worker attempt superseded the request.');
  }

  await patchJournal(latest, { ...journal, status: 'submitted' }, 'task debrief dispatch intent');
  const dispatch = getRun(run.id);
  if (
    !dispatch ||
    dispatch.taskDebrief?.debriefId !== journal.debriefId ||
    !sameSubject(dispatch, journal)
  )
    return settleTaskDebrief(request, 'failed', 'A later worker attempt superseded the request.');
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

async function settleAfterRelease(run: Run, journal: ManagedTaskDebrief): Promise<void> {
  const ref = resolveRetainedRunBundleRef(run, journal.bundle);
  const { request, options } = await retainedRequest(run, journal);
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
    const directory = runBundleDebriefDirectory(runBundleStoreRoot(), run.id, ref.bundleDigest);
    await assertHeavyWriteRoom(directory);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    writeTaskDebrief(directory, record);
  }
  const latest = getRun(run.id);
  if (latest?.taskDebrief?.debriefId !== journal.debriefId) return;
  await patchJournal(
    latest,
    {
      ...journal,
      status: sameSubject(latest, journal) ? 'settled' : 'stale',
      outcome: record.outcome.status,
    },
    'task debrief settled',
  );
  const { broadcastEvent } = await import('../server.js');
  broadcastEvent(Events.RUN_UPDATED, { run: getRun(run.id) });
}

export function continueTaskDebriefAfterRelease(runId: string): void {
  const run = getRun(runId);
  const journal = run?.taskDebrief;
  if (
    !run ||
    !journal ||
    journal.status === 'settled' ||
    journal.status === 'stale' ||
    active.has(runId)
  )
    return;
  active.add(runId);
  void (async () => {
    const slot = run.slotId && (await readSlotRow(run.slotId));
    if (run.slotId && (!slot || ownsRunSlotCleanup(slot, run.id) || slot.handoff_run_id === run.id))
      return;
    if (!sameSubject(run, journal)) {
      const current = getRun(runId);
      if (current?.taskDebrief?.debriefId === journal.debriefId)
        await patchJournal(current, { ...journal, status: 'stale' }, 'task debrief superseded');
      return;
    }
    await settleAfterRelease(run, journal);
  })()
    .catch((error: unknown) => {
      // Keep the durable intent available for reconciliation and leave completion alone.
      console.warn(`[debrief] settlement failed for ${runId}: ${(error as Error).message}`);
    })
    .finally(() => {
      active.delete(runId);
      const next = getRun(runId)?.taskDebrief;
      if (next && next.debriefId !== journal.debriefId) continueTaskDebriefAfterRelease(runId);
    });
}

export function resumeAcceptedTaskDebriefs(): void {
  for (const run of getAllRuns()) if (run.taskDebrief) continueTaskDebriefAfterRelease(run.id);
}

export async function currentTaskDebriefForCuration(run: Run): Promise<TaskDebrief | undefined> {
  const journal = run.taskDebrief;
  if (!journal || taskDebriefRunStatus(run) !== 'settled') return undefined;
  const acceptedRef = resolveRetainedRunBundleRef(run, journal.bundle);
  const record = readSidecar(run, acceptedRef);
  if (
    !record ||
    record.identity.binding !== 'hosted' ||
    !record.identity.template ||
    !record.workflowCandidates.length
  )
    return undefined;
  const { request } = await retainedRequest(run, journal);
  return validateTaskDebrief(record, request);
}
