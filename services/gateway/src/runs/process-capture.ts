import { readFile, realpath, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

import { sha256Text as hash } from '@farmslot/agent-runtime';
import {
  deriveProcessActivity,
  hasProcessRootCause,
} from '@farmslot/agent-runtime/native/process-activity';
import type {
  ProcessCaptureRequest,
  ProcessCaptureResult,
} from '@farmslot/agent-runtime/native/process-capture';
import {
  type AgentContext,
  type ArtifactRef,
  type EvidenceManifest,
  isRecord,
  primaryRoleForFlow,
  type ProcessActivityField,
  type Run,
  type RunActivityRecord,
  type RunArtifactBundleRef,
} from '@farmslot/protocol';

import { BASELINE_MARKER_DIR } from '../core/artifact-copy-policy.js';
import {
  getOrchestratorTaskRoot,
  loadProjectVars,
  loadSlotVars,
  resolveProjectRuntimeDir,
  resolveProjectTaskDirName,
  resolveTaskRelDir,
} from '../core/config.js';
import { execArgvOnSlot } from '../core/exec.js';
import { isSourceCodePath } from '../core/source-diff-filter.js';
import { readSlotField } from '../core/state.js';
import { validateEvidenceManifest } from '../run-completion/evidence-manifest.js';
import type { ResolvedPublicationManifest } from '../run-completion/publication-artifacts.js';
import { resolveProjectSourceDiffFilter } from '../run-engine/diff-artifacts.js';
import { getRunnerSessionUsageProvider } from '../runners/registry.js';
import { agentRuntimeScriptForSlot } from '../tasks/agent-runtime-script.js';
import { parseChecklistTiming } from '../tasks/checklist-timing.js';
import { WORKER_MIRROR_SUFFIX } from '../tasks/sidecars.js';
import { terminalWorkerSignalFromRaw } from '../tasks/worker-signals.js';

import { activityForRun } from './process-activity.js';
import { observeProcessBaselines } from './process-baseline.js';

interface ChecklistParser {
  parseChecklist(markdown: string): { items: Array<{ checked: boolean }> };
}
const checklistParser: ChecklistParser = createRequire(import.meta.url)(
  '@farmslot/agent-runtime/scripts/mark-io.cjs',
);

export interface CapturedProcessActivity {
  activity: RunActivityRecord;
  artifacts: ArtifactRef[];
}

/** Attach the qualified capture and record metadata which could not be retained. */
export function bindProcessActivityBundle(
  captured: CapturedProcessActivity,
  ref: RunArtifactBundleRef,
  missingPaths: ReadonlySet<string>,
): RunActivityRecord {
  const original = captured.activity.process;
  if (!original.attempt.contextId) return captured.activity;
  const process = { ...original, sourceBundle: ref, coverage: { ...original.coverage } };
  const invalidated = new Set<ProcessActivityField>();
  for (const source of process.sources) {
    if (!source.path || !missingPaths.has(source.path)) continue;
    const fields: ProcessActivityField[] = [];
    if (
      source.id === process.checklist.source?.sourceId ||
      source.id === process.checklist.documentSource?.sourceId
    )
      fields.push('checklist');
    if (source.id === process.rootCause.source?.sourceId) fields.push('rootCause');
    if (source.id.startsWith('baseline')) fields.push('baseline');
    if (source.id.startsWith('marker:')) fields.push('productEdits', 'commits');
    for (const field of fields) {
      invalidated.add(field);
      process.coverage[field] = { status: 'partial', reason: 'FROZEN_SOURCE_NOT_RETAINED' };
    }
  }
  const unknown = { value: null, reason: 'FROZEN_SOURCE_NOT_RETAINED', references: [] };
  process.labels = {
    ...original.labels,
    ...(invalidated.has('checklist') || invalidated.has('productEdits')
      ? { skipped_checklist: unknown }
      : {}),
    ...(invalidated.has('baseline') || invalidated.has('productEdits')
      ? { fix_before_baseline: unknown }
      : {}),
  };
  return { schemaVersion: 1, process };
}

const MAX_TEXT = 1024 * 1024;
const CAPTURE_PROGRAM = `import {pathToFileURL} from 'node:url';
const {captureProcessSources}=await import(pathToFileURL(process.argv[2]).href);
process.stdout.write(JSON.stringify(await captureProcessSources(JSON.parse(process.argv[1]))));`;

function processSourceReason(error: unknown): string {
  return error instanceof SyntaxError
    ? 'INVALID_STRUCTURED_PROCESS_SOURCE'
    : error instanceof Error && /^[A-Z_]+$/.test(error.message)
      ? error.message
      : 'PROCESS_SOURCE_UNAVAILABLE';
}

/** Only the original worker owns process facts; the current active role is irrelevant. */
export function originalProcessContext(run: Run): AgentContext | undefined {
  const contexts = (run.agentContexts ?? []).filter(
    (context) => context.role === primaryRoleForFlow(run.flowType) && context.runId === run.id,
  );
  if (contexts.length <= 1) return contexts[0];
  if (
    contexts.some(
      (context) => !context.startedAt || !Number.isFinite(Date.parse(context.startedAt)),
    )
  )
    return;
  return [...contexts].sort((a, b) => Date.parse(a.startedAt!) - Date.parse(b.startedAt!))[0];
}

async function smallText(root: string, relative: string): Promise<string | null> {
  const file = path.resolve(root, relative);
  const rel = path.relative(root, file);
  if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel))
    throw new Error('PROCESS_SOURCE_ESCAPE');
  try {
    const resolved = await realpath(file);
    const within = path.relative(await realpath(root), resolved);
    if (within === '..' || within.startsWith(`..${path.sep}`) || path.isAbsolute(within))
      throw new Error('PROCESS_SOURCE_ESCAPE');
    const info = await stat(resolved);
    if (!info.isFile() || info.size > MAX_TEXT) throw new Error('PROCESS_SOURCE_SIZE');
    return await readFile(resolved, 'utf8');
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
      return null;
    throw error;
  }
}

/** Freeze during output acquisition, before terminal analytics or any role/slot replacement. */
export async function captureOriginalProcessActivity(
  run: Run,
  selection: ResolvedPublicationManifest | null,
  inventory: readonly ArtifactRef[],
): Promise<CapturedProcessActivity> {
  const captured: CapturedProcessActivity = { activity: activityForRun(run), artifacts: [] };
  if (run.metrics.activity || run.output?.workerFinished || !run.taskFile || !run.slotId)
    return captured;
  const context = originalProcessContext(run);
  if (
    !context ||
    (run.agentContexts ?? []).some(
      (other) => other.role !== context.role && other.startedAt && other.role !== 'subtask',
    )
  )
    return captured;
  const process = captured.activity.process;
  const taskDir = path.dirname(run.taskFile);
  const optional = async <T>(
    field: ProcessActivityField,
    read: () => Promise<T>,
  ): Promise<T | undefined> => {
    try {
      return await read();
    } catch (error) {
      process.coverage[field] = { status: 'unavailable', reason: processSourceReason(error) };
      return undefined;
    }
  };
  try {
    if ((await readSlotField(run.slotId, 'current_run_id')) !== run.id) return captured;
    const vars = await loadSlotVars(run.slotId);
    const project = await loadProjectVars(run.project);
    const relative = resolveTaskRelDir(
      run.taskFile,
      getOrchestratorTaskRoot(run.project, project.projectJson),
    );
    if (relative === null) return captured;
    const workerTaskDir = path.join(
      vars.remoteRepo,
      resolveProjectTaskDirName(project.projectJson),
      relative,
    );
    const node = context.nativeSession?.executionNodeId ?? vars.machine;
    const retained = async (file: string, id: string) => {
      const bytes = await smallText(taskDir, file);
      if (bytes === null) return null;
      captured.artifacts.push({
        path: file,
        purpose: 'task-input',
        sha256: hash(bytes),
        sizeBytes: Buffer.byteLength(bytes),
      });
      process.sources.push({
        id,
        kind: id === 'signal' ? 'signal' : 'task-artifact',
        contextId: context.id,
        executionNodeId: node,
        clockId: `node:${node}`,
        path: file,
        sha256: hash(bytes),
      });
      return bytes;
    };
    const signalBytes = await retained(`SIGNAL.json${WORKER_MIRROR_SUFFIX}`, 'signal');
    const signal = signalBytes ? terminalWorkerSignalFromRaw(signalBytes) : undefined;
    if (
      !signal ||
      !context.signalAttemptId ||
      signal.attemptId !== context.signalAttemptId ||
      (signal.contextId && signal.contextId !== context.id) ||
      (signal.role && signal.role !== context.role)
    )
      return captured;
    const end = Date.parse(signal.timestamp);
    if (!Number.isFinite(end)) return captured;
    process.attempt = {
      runId: run.id,
      contextId: context.id,
      attemptId: signal.attemptId ?? null,
      role: context.role,
      engineGeneration: run.engineState?.generation ?? null,
      startedAt: context.attemptStartedAt ?? context.startedAt ?? null,
      frozenAt: signal.timestamp,
      executionNodeId: node,
    };
    process.sources = process.sources.filter((source) => source.id !== 'run-metrics');
    process.checklist = { events: null, expectedSteps: null, complete: null, source: null };
    process.coverage.checklist = {
      status: 'unavailable',
      reason: 'WORKER_CHECKLIST_SOURCE_UNAVAILABLE',
    };
    const workerDocument = await optional('rootCause', () =>
      retained(`TASK.md${WORKER_MIRROR_SUFFIX}`, 'worker-document'),
    );
    if (typeof workerDocument === 'string') {
      process.rootCause = {
        present: hasProcessRootCause(workerDocument),
        source: { sourceId: 'worker-document' },
      };
      process.coverage.rootCause = { status: 'complete', reason: 'FROZEN_WORKER_DOCUMENT' };
    }
    const timing = parseChecklistTiming(signal.checklistTiming);
    const checklistFile =
      timing?.source === 'TASK.md'
        ? `TASK.md${WORKER_MIRROR_SUFFIX}`
        : `CHECKLIST.md${WORKER_MIRROR_SUFFIX}`;
    const legacyChecklist = checklistFile === `TASK.md${WORKER_MIRROR_SUFFIX}`;
    const checklist = legacyChecklist
      ? workerDocument
      : await optional('checklist', () => retained(checklistFile, 'checklist'));
    if (
      timing &&
      typeof checklist === 'string' &&
      ['TASK.md', 'CHECKLIST.md'].includes(timing.source ?? '')
    ) {
      const parsed = checklistParser.parseChecklist(checklist);
      process.checklist = {
        events: timing.events,
        expectedSteps: parsed.items.length,
        complete: parsed.items.every((item) => item.checked),
        source: { sourceId: 'signal' },
        documentSource: { sourceId: legacyChecklist ? 'worker-document' : 'checklist' },
        workerStatus: signal.status,
      };
      process.coverage.checklist = { status: 'complete', reason: 'MATCHED_WORKER_ATTEMPT_SIGNAL' };
    }
    const baseline = await optional('baseline', async () => {
      let declaration = selection?.manifest;
      let bytes = selection?.sourceBytes;
      const file = selection?.sourcePath ?? 'artifacts/evidence-manifest.json';
      if (!declaration) {
        bytes = (await smallText(taskDir, file)) ?? undefined;
        const parsed: unknown = bytes ? JSON.parse(bytes) : null;
        if (parsed && validateEvidenceManifest(parsed).length === 0)
          declaration = parsed as EvidenceManifest;
      }
      const found = await observeProcessBaselines({
        manifest: declaration,
        inventory,
        contextId: context.id,
        node,
        readText: (file) => smallText(taskDir, file),
      });
      if (declaration && bytes) {
        found.sources.push({
          id: 'baseline-declaration',
          kind: 'task-artifact',
          contextId: context.id,
          executionNodeId: node,
          clockId: `node:${node}`,
          path: file,
          sha256: hash(bytes),
        });
        if (inventory.find((artifact) => artifact.path === file)?.sha256 !== hash(bytes))
          found.complete = false;
      }
      return found;
    });
    if (baseline) {
      process.firstBaselineRun = baseline.first;
      process.sources.push(...baseline.sources);
      process.coverage.baseline = {
        status: baseline.complete ? 'complete' : 'partial',
        reason: baseline.complete
          ? 'TASK_DECLARED_RECORDED_BASELINES'
          : 'BASELINE_DECLARATION_OR_RECORDED_METADATA_INCOMPLETE',
      };
    }
    const markers: string[] = [];
    let markerSourcesIncomplete = false;
    const markerArtifacts = inventory.filter(
      (item) =>
        item.path.startsWith(`artifacts/${BASELINE_MARKER_DIR}/`) && item.path.endsWith('.json'),
    );
    if (markerArtifacts.length > 32) markerSourcesIncomplete = true;
    for (const artifact of markerArtifacts.slice(0, 32)) {
      const receipt: unknown = await optional('productEdits', async () => {
        const bytes = await smallText(taskDir, artifact.path);
        if (!bytes || hash(bytes) !== artifact.sha256) return null;
        process.sources.push({
          id: `marker:${artifact.sha256}`,
          kind: 'task-artifact',
          contextId: context.id,
          executionNodeId: node,
          clockId: `node:${node}`,
          path: artifact.path,
          sha256: artifact.sha256,
        });
        return JSON.parse(bytes);
      });
      if (receipt === undefined || receipt === null) markerSourcesIncomplete = true;
      if (
        isRecord(receipt) &&
        receipt.version === 1 &&
        receipt.runId === run.id &&
        receipt.ticket === run.ticketOrPr &&
        typeof receipt.baseSha === 'string' &&
        typeof receipt.markerSha === 'string'
      )
        markers.push(receipt.markerSha);
      else markerSourcesIncomplete = true;
    }
    const acceptance = context.promptAcceptance;
    const provider = getRunnerSessionUsageProvider(context.runner)?.id;
    const binding = context.nativeSession;
    const request: ProcessCaptureRequest = {
      contextId: context.id,
      executionNodeId: node,
      repo: vars.remoteRepo,
      taskDir: workerTaskDir,
      excludedRoots: [
        path.join(vars.remoteRepo, resolveProjectTaskDirName(project.projectJson)),
        path.join(vars.remoteRepo, await resolveProjectRuntimeDir(run.project)),
        path.join(vars.remoteRepo, 'node_modules'),
      ],
      baseSha: run.worktreeHeadAtDispatch ?? run.startRef?.resolvedSha,
      verifiedMarkerShas: markers,
      endAtMs: end,
      ...(provider === 'claude-jsonl' || provider === 'pi-jsonl' || provider === 'codex-jsonl'
        ? { format: provider }
        : {}),
      sessionId: context.runnerSessionId ?? undefined,
      sessionPath: context.runnerSessionPath ?? undefined,
      allowInitialTaskPrompt: !context.adoptedAt && !context.nativeSessionHistory?.length,
      ...(acceptance &&
      acceptance.sessionId === context.runnerSessionId &&
      acceptance.sessionPath === context.runnerSessionPath
        ? { startAtMs: acceptance.observedAt }
        : {}),
      ...(binding
        ? {
            nativeSession: {
              sessionId: binding.sessionId,
              generation: binding.generation,
              executionNodeId: binding.executionNodeId,
              ownerPrincipalId: binding.ownerPrincipalId,
              leaseId: binding.leaseId,
              commandId: binding.commandId,
              stateDirectory: binding.stateDirectory,
            },
          }
        : {}),
    };
    const runtime = await agentRuntimeScriptForSlot(vars, 'task-init-cli.mjs');
    const module = path.posix.join(
      path.posix.dirname(runtime),
      '../dist/native/process-capture.js',
    );
    const response = await execArgvOnSlot(
      vars,
      ['node', '--input-type=module', '-e', CAPTURE_PROGRAM, JSON.stringify(request), module],
      { timeout: 20000, maxBuffer: 1024 * 1024, noRetry: true },
    );
    if (response.exitCode !== 0) throw new Error('PROCESS_RUNTIME_SOURCE_UNAVAILABLE');
    if ((await readSlotField(run.slotId, 'current_run_id')) !== run.id)
      throw new Error('PROCESS_SLOT_OWNER_CHANGED');
    const facts: ProcessCaptureResult = JSON.parse(response.stdout);
    if (
      facts.schemaVersion !== 1 ||
      facts.contextId !== context.id ||
      !Array.isArray(facts.sources) ||
      facts.sources.some(
        (source) => source.contextId !== context.id || source.executionNodeId !== node,
      )
    )
      throw new Error('PROCESS_CAPTURE_BINDING_MISMATCH');
    const filter = (await resolveProjectSourceDiffFilter(run.project)).sourceFilter;
    const edits = facts.edits?.filter((edit) => isSourceCodePath(edit.path, filter)) ?? null;
    process.commits = facts.commits;
    process.markCalls = facts.markCalls;
    process.sources.push(...facts.sources);
    process.coverage.commits = facts.gitCoverage;
    if (markerSourcesIncomplete && process.coverage.commits.status === 'complete')
      process.coverage.commits = { status: 'partial', reason: 'MARKER_SOURCES_UNAVAILABLE' };
    process.coverage.markCalls =
      facts.historyCoverage.status === 'complete' && facts.uncertainMarks
        ? { status: 'partial', reason: 'NESTED_OR_UNCLASSIFIED_COMMANDS' }
        : facts.historyCoverage;
    process.coverage.productEdits =
      facts.gitCoverage.status === 'unavailable'
        ? facts.gitCoverage
        : facts.historyCoverage.status !== 'complete'
          ? facts.historyCoverage
          : {
              status: facts.uncertainWrites || markerSourcesIncomplete ? 'partial' : 'complete',
              reason: markerSourcesIncomplete
                ? 'MARKER_SOURCES_UNAVAILABLE'
                : facts.uncertainWrites
                  ? 'UNCLASSIFIED_OR_SHELL_WRITES'
                  : 'STRUCTURED_PRODUCT_EDITS',
            };
    if (context.nativeSessionHistory?.length || run.recoveryAttempts?.length) {
      process.coverage.checklist = {
        status: 'partial',
        reason: 'EARLIER_WORKER_ATTEMPTS_UNCAPTURED',
      };
      process.coverage.productEdits = {
        status: 'partial',
        reason: 'EARLIER_WORKER_ATTEMPTS_UNCAPTURED',
      };
      process.coverage.baseline = {
        status: 'partial',
        reason: 'EARLIER_WORKER_ATTEMPTS_UNCAPTURED',
      };
    }
    captured.activity = {
      schemaVersion: 1,
      process: deriveProcessActivity({ ...process, productEdits: edits }),
    };
  } catch (error) {
    // Advisory capture has an explicit missing-data outcome; lifecycle and verdicts are untouched.
    const reason = processSourceReason(error);
    process.coverage.productEdits = { status: 'unavailable', reason };
    process.coverage.markCalls = { status: 'unavailable', reason };
    captured.activity = {
      schemaVersion: 1,
      process: deriveProcessActivity({ ...process, productEdits: null }),
    };
  }
  return captured;
}
