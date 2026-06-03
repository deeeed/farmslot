// methods/operator.ts — read-only operator-facing intelligence snapshots

import { createReadStream, existsSync, realpathSync } from 'node:fs';
import { lstat, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

import {
  type ChatNextStep,
  type ChatSuggestedAction,
  type FailureCategory,
  type OperatorSnapshotResult,
  RECOVERABLE_FAILURE_CATEGORIES,
  type Run,
  type RunContextBundleParams,
  type RunContextBundleResult,
  type RunRecoveryEvidence,
  type RunRecoveryProposal,
  type RunRecoveryProposalParams,
  type RunRecoveryProposalResult,
  type RunStep,
} from '@farmslot/protocol';

import { listItems } from '../backlog/dispatch-queue.js';
import { getRecentEvents, readObserverEvidence } from '../chat/copilot-observer.js';
import { isPathInside } from '../core/path.js';
import { getAllMachineHealth } from '../fleet/node-health.js';
import { farmslotRoot, getCachedFleet } from '../fleet/state.js';
import {
  findRegisteredLogEntry,
  listLogRegistryEntries,
  redactLogContent,
} from '../observability/log-registry.js';
import { getRun, listRuns } from '../runs/store.js';

import { decisionList } from './decisions.js';

const TEXT_PREVIEW_LIMIT = 12_000;
const RECOVERY_EXCERPT_LIMIT = 600;
const REGISTERED_LOG_PREVIEW_LIMIT = 20_000;
const LOG_PATH_RE = /(?:\.log|\.out|\.err|farmslot-dev\.log)/;
const realFarmslotRoot = realpathSync(farmslotRoot);

export async function operatorSnapshot(): Promise<OperatorSnapshotResult> {
  const generatedAt = new Date().toISOString();
  const fleet = getCachedFleet();
  const activeRuns = listRuns({ active: true, limit: 50 }).runs;
  const queueItems = listItems();
  const { decisions } = await decisionList();
  const recentEvents = getRecentEvents();

  return {
    generatedAt,
    sources: {
      fleet: 'fleet.status cached',
      machines: 'node.health.all',
      activeRuns: 'run.list active=true',
      queue: 'dispatch.queue.list',
      pendingDecisions: 'decision.list',
      recentEvents: 'copilot-observer recent events',
    },
    counts: {
      totalSlots: fleet?.summary.total ?? 0,
      readySlots: fleet?.summary.ready ?? 0,
      busySlots: fleet?.summary.busy ?? 0,
      heldSlots: fleet?.summary.held ?? 0,
      activeRuns: activeRuns.length,
      queuedItems: queueItems.length,
      pendingDecisions: decisions.length,
      recentEvents: recentEvents.length,
    },
    fleet: {
      checkedAt: fleet?.checkedAt,
      summary: fleet?.summary,
    },
    machines: getAllMachineHealth().map((m) => ({
      machine: m.machine,
      online: m.online,
      headroom: m.headroom,
      ...(m.system
        ? {
            cpuPercent: m.system.cpuPercent,
            memoryPercent: m.system.memoryPercent,
            diskPercent: m.system.diskPercent,
            loadAvg1: m.system.loadAvg1,
          }
        : {}),
    })),
    activeRuns: activeRuns.map((run) => ({
      id: run.id,
      flowType: run.flowType,
      status: run.status,
      step: run.steps.find((step) => step.status === 'running')?.name,
      slotId: run.slotId,
      ticketOrPr: run.ticketOrPr,
      pendingDecisions: run.decisions?.filter((d) => !d.resolvedAt).length ?? 0,
    })),
    queue: queueItems.map((item) => ({
      id: item.id,
      flowType: item.flowType,
      project: item.project,
      ticketOrPr: item.ticketOrPr,
      slotId: item.slotId,
      priority: item.priority,
      createdAt: item.createdAt,
    })),
    pendingDecisions: decisions.map((decision) => ({
      id: decision.id,
      type: decision.type,
      title: decision.title,
      runId: decision.context?.runId ? String(decision.context.runId) : null,
      slotId: decision.slotId,
      ticketOrPr: decision.context?.ticketOrPr
        ? String(decision.context.ticketOrPr)
        : (decision.runMeta?.ticketOrPr ?? null),
      createdAt: decision.createdAt,
      actions: decision.actions.map((action) => action.id),
    })),
    recentEvents: recentEvents.slice(-20).map((event) => ({ ...event })),
  };
}

export async function runContextBundle(
  params: RunContextBundleParams,
): Promise<RunContextBundleResult> {
  const run = resolveRun(params.runId);
  if (!run) throw new Error(`Run not found: ${params.runId}`);

  const taskCandidates = [
    ['taskFile', run.taskFile],
    ['activeTaskFile', run.activeTaskFile],
  ] as const;
  const taskDir = run.taskFile ? path.dirname(run.taskFile) : null;
  const artifactCandidates = taskDir
    ? ([
        ['report', path.join(taskDir, 'artifacts/report.md')],
        ['grade', path.join(taskDir, 'artifacts/grade.json')],
        ['comments-report', path.join(taskDir, 'artifacts/comments-report.md')],
      ] as const)
    : [];

  return {
    generatedAt: new Date().toISOString(),
    sources: {
      run: 'run.get',
      taskFiles: 'run.taskFile / run.activeTaskFile',
      artifacts: 'task artifacts under run task directory',
    },
    run: {
      id: run.id,
      familyId: run.familyId,
      parentRunId: run.parentRunId,
      flowType: run.flowType,
      status: run.status,
      project: run.project,
      ticketOrPr: run.ticketOrPr,
      slotId: run.slotId,
      branch: run.branch,
      prNumber: run.prNumber,
      summary: run.summary,
      error: run.error,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
      completedAt: run.completedAt,
    },
    currentSteps: run.steps
      .filter((step) => step.status === 'running' || step.status === 'failed' || step.detail)
      .map((step) => ({
        name: step.name,
        status: step.status,
        detail: step.detail,
        startedAt: step.startedAt,
        completedAt: step.completedAt,
        durationMs: step.durationMs,
      })),
    pendingDecisions: (run.decisions ?? [])
      .filter((decision) => !decision.resolvedAt)
      .map((decision) => ({
        id: decision.id,
        type: decision.type,
        title: decision.title,
        createdAt: decision.createdAt,
        actions: decision.actions.map((action) => action.id),
      })),
    taskFiles: (
      await Promise.all(taskCandidates.map(([label, filePath]) => readPreview(label, filePath)))
    ).filter(Boolean) as RunContextBundleResult['taskFiles'],
    artifacts: (
      await Promise.all(artifactCandidates.map(([label, filePath]) => readPreview(label, filePath)))
    ).filter(Boolean) as RunContextBundleResult['artifacts'],
  };
}

export async function runRecoveryProposal(
  params: RunRecoveryProposalParams,
): Promise<RunRecoveryProposalResult> {
  const run = resolveRun(params.runId);
  if (!run) {
    return {
      proposal: {
        status: 'unavailable',
        target: { runId: params.runId, ...(params.stepName ? { stepName: params.stepName } : {}) },
        finding: `Run ${params.runId} is not available in the gateway run store.`,
        evidence: [],
        confidence: 'low',
        inferenceNotes: ['No run state was available, so no diagnosis was inferred.'],
        nextSteps: recoveryNextSteps(params.runId, params.stepName, 'unavailable'),
      },
    };
  }

  const target = {
    runId: run.id,
    ...(params.stepName ? { stepName: params.stepName } : {}),
    flowType: run.flowType,
    status: run.status,
    project: run.project,
    ticketOrPr: run.ticketOrPr,
    slotId: run.slotId,
  } satisfies RunRecoveryProposal['target'];
  const evidence: RunRecoveryEvidence[] = [];
  const inferenceNotes: string[] = [];

  let bundle: RunContextBundleResult | null = null;
  try {
    bundle = await runContextBundle({ runId: run.id });
    evidence.push({
      id: 'run-context-bundle',
      source: 'run-context-bundle',
      label: 'Run context bundle resolved',
      provenance: 'run.contextBundle',
      excerpt: [
        `status=${bundle.run.status}`,
        `steps=${bundle.currentSteps.map((step) => `${step.name}:${step.status}`).join(', ') || 'none'}`,
        `artifacts=${bundle.artifacts.map((artifact) => artifact.label).join(', ') || 'none'}`,
      ].join('; '),
    });
  } catch (err) {
    inferenceNotes.push(`run.contextBundle could not be read: ${(err as Error).message}`);
  }

  const selectedStep = selectRecoveryStep(run, params.stepName);
  if (selectedStep) {
    if (params.stepName && selectedStep.name !== params.stepName) {
      inferenceNotes.push(
        `Requested step "${params.stepName}" was not found; selected "${selectedStep.name}" from current run state.`,
      );
    }
    target.stepName = selectedStep.name;
    const stepSummary = selectedStep.detail ?? summarizeDiagnosticStepOutputs(selectedStep);
    if (stepSummary) {
      evidence.push({
        id: `step-${safeEvidenceId(selectedStep.name)}`,
        source: 'run-state',
        label: `Step ${selectedStep.name} is ${selectedStep.status}`,
        provenance: 'run.get steps[]',
        excerpt: compactEvidenceText(stepSummary),
      });
    } else if (selectedStep.status === 'failed') {
      evidence.push({
        id: `step-${safeEvidenceId(selectedStep.name)}`,
        source: 'run-state',
        label: `Step ${selectedStep.name} failed`,
        provenance: 'run.get steps[]',
      });
    }
  }

  if (run.error) {
    evidence.push({
      id: 'run-error',
      source: 'run-state',
      label: 'Run error',
      provenance: 'run.get error',
      excerpt: compactEvidenceText(run.error),
    });
  }

  for (const decision of run.decisions.filter((decision) => !decision.resolvedAt).slice(0, 2)) {
    evidence.push({
      id: `pending-decision-${safeEvidenceId(decision.id)}`,
      source: 'run-state',
      label: `Pending decision: ${decision.title}`,
      provenance: 'run.get decisions[]',
      excerpt: compactEvidenceText(decision.description ?? decision.title),
    });
  }

  if (bundle) {
    const artifactEvidence = bundle.artifacts
      .map((artifact) => ({ artifact, excerpt: pickDiagnosticExcerpt(artifact.content) }))
      .filter((item) => item.excerpt)
      .slice(0, 2);
    for (const item of artifactEvidence) {
      evidence.push({
        id: `artifact-${safeEvidenceId(item.artifact.label)}`,
        source: 'task-artifact',
        label: `Artifact: ${item.artifact.label}`,
        provenance: 'run.contextBundle artifacts[]',
        path: item.artifact.path,
        excerpt: item.excerpt,
      });
    }
  }

  const structuredEvidenceCount = evidence.filter(
    (item) =>
      item.source === 'run-state' ||
      item.source === 'run-context-bundle' ||
      item.source === 'task-artifact',
  ).length;

  if (structuredEvidenceCount <= 2) {
    const observer = readObserverEvidence({ runId: run.id, limit: 3 });
    for (const event of observer.events.slice(0, 2)) {
      evidence.push({
        id: `observer-${safeEvidenceId(event.id)}`,
        source: 'observer-evidence',
        label: `${event.severity}: ${event.type}`,
        provenance: 'copilot-observer:event-log',
        excerpt: compactEvidenceText(event.summary),
      });
    }
    if (params.screenContext && Object.keys(params.screenContext).length > 0) {
      evidence.push({
        id: 'screen-context',
        source: 'screen-context',
        label: 'Client screen context',
        provenance: 'ui-client-context',
        excerpt: compactEvidenceText(JSON.stringify(params.screenContext)),
      });
    }
  }

  if (!hasActionableEvidence(evidence) || shouldReadRegisteredLogEvidence(evidence, selectedStep)) {
    const logEvidence = await readRegisteredLogFallback(run, selectedStep);
    if (logEvidence) evidence.push(logEvidence);
  }

  const actionable = hasActionableEvidence(evidence);
  const status: RunRecoveryProposal['status'] = actionable ? 'ready' : 'insufficient-evidence';
  const confidence = confidenceFor(run, selectedStep, evidence, status);
  const finding = buildRecoveryFinding(run, selectedStep, evidence, status);
  if (status === 'insufficient-evidence') {
    inferenceNotes.push(
      'Structured run state, task artifacts, observer evidence, and registered log fallback did not contain a clear failure cause.',
    );
  } else if (!evidence.some((item) => item.source === 'registered-log')) {
    inferenceNotes.push(
      'Logs were not used because structured run/context evidence was sufficient.',
    );
  }

  return {
    proposal: {
      status,
      target,
      finding,
      evidence: evidence.slice(0, 6),
      confidence,
      inferenceNotes: inferenceNotes.length ? inferenceNotes : ['none'],
      nextSteps: recoveryNextSteps(run.id, target.stepName, status),
      ...(status === 'ready'
        ? {
            remediationDescriptors: recoveryDescriptors(
              run,
              selectedStep,
              deriveFailureCategory(selectedStep),
            ),
          }
        : {}),
    },
  };
}

function resolveRun(id: string) {
  return getRun(id) ?? listRuns({ limit: 500 }).runs.find((run) => run.id.startsWith(id));
}

function selectRecoveryStep(run: Run, stepName: string | undefined): RunStep | null {
  if (stepName) {
    return run.steps.find((step) => step.name === stepName) ?? null;
  }
  return (
    run.steps.find((step) => step.status === 'failed') ??
    run.steps.find((step) => step.status === 'running') ??
    run.steps.find((step) => step.detail) ??
    null
  );
}

function summarizeDiagnosticStepOutputs(step: RunStep): string | null {
  if (!step.outputs) return null;
  const entries = Object.entries(step.outputs)
    .filter(
      ([, value]) =>
        typeof value === 'string' &&
        !LOG_PATH_RE.test(value) &&
        /\b(error|failed|failure|exception|blocked|timeout|refused|denied)\b/i.test(value),
    )
    .slice(0, 3)
    .map(([key, value]) => `${key}=${String(value)}`);
  return entries.length ? entries.join('; ') : null;
}

function safeEvidenceId(value: string): string {
  return (
    value
      .replace(/[^A-Za-z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80) || 'evidence'
  );
}

function compactEvidenceText(value: string): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, RECOVERY_EXCERPT_LIMIT);
}

function pickDiagnosticExcerpt(content: string): string | undefined {
  const lines = content.split(/\r?\n/);
  const index = lines.findIndex((line) =>
    /\b(error|failed|failure|exception|blocked|timeout|refused|denied)\b/i.test(line),
  );
  const excerptLines =
    index >= 0
      ? lines.slice(Math.max(0, index - 1), Math.min(lines.length, index + 3))
      : lines.slice(0, 3);
  const excerpt = compactEvidenceText(excerptLines.join('\n'));
  return excerpt ? excerpt.slice(0, RECOVERY_EXCERPT_LIMIT) : undefined;
}

function hasActionableEvidence(evidence: RunRecoveryEvidence[]): boolean {
  return evidence.some(
    (item) =>
      item.id !== 'run-context-bundle' &&
      Boolean(item.excerpt?.trim()) &&
      item.source !== 'screen-context',
  );
}

function shouldReadRegisteredLogEvidence(
  evidence: RunRecoveryEvidence[],
  step: RunStep | null,
): boolean {
  if (!findCandidateLogPath(step)) return false;
  return !evidence.some(
    (item) =>
      item.source === 'task-artifact' ||
      item.id === 'run-error' ||
      (item.source === 'run-state' && item.id.startsWith('step-') && Boolean(item.excerpt?.trim())),
  );
}

function confidenceFor(
  run: Run,
  step: RunStep | null,
  evidence: RunRecoveryEvidence[],
  status: RunRecoveryProposal['status'],
): RunRecoveryProposal['confidence'] {
  if (status !== 'ready') return 'low';
  const hasStructuredCause =
    evidence.some((item) => item.source === 'run-state' && item.id !== 'run-context-bundle') ||
    evidence.some((item) => item.source === 'task-artifact');
  if (
    (run.status === 'failed' || run.status === 'blocked') &&
    step?.status === 'failed' &&
    hasStructuredCause
  )
    return 'high';
  if (hasStructuredCause || evidence.some((item) => item.source === 'observer-evidence'))
    return 'medium';
  return 'low';
}

function buildRecoveryFinding(
  run: Run,
  step: RunStep | null,
  evidence: RunRecoveryEvidence[],
  status: RunRecoveryProposal['status'],
): string {
  if (status === 'insufficient-evidence') {
    return `Run ${run.id.slice(0, 8)} is ${run.status}, but the available evidence is too thin to identify a specific recovery path.`;
  }
  const primary =
    evidence.find((item) => item.source === 'task-artifact') ??
    evidence.find((item) => item.id === 'run-error') ??
    evidence.find((item) => item.source === 'registered-log') ??
    evidence.find((item) => item.source === 'run-state' && item.id.startsWith('step-')) ??
    evidence.find((item) => item.source === 'observer-evidence') ??
    evidence[0];
  const stepPart = step ? ` at step "${step.name}"` : '';
  return `Run ${run.id.slice(0, 8)} appears blocked or failed${stepPart}: ${primary?.excerpt ?? primary?.label ?? 'see evidence'}`;
}

function recoveryNextSteps(
  runId: string,
  stepName: string | undefined,
  status: RunRecoveryProposal['status'],
): ChatNextStep[] {
  const scoped = stepName ? `step "${stepName}" in run ${runId}` : `run ${runId}`;
  const steps: ChatNextStep[] = [
    {
      id: 'inspect-run-bundle',
      label: 'Inspect run bundle',
      kind: 'read',
      safety: 'read-only',
      params: {
        prompt: `Read run_context_bundle for ${scoped} and summarize the highest-confidence failure evidence.`,
      },
    },
    {
      id: 'review-observer-evidence',
      label: 'Review observer evidence',
      kind: 'read',
      safety: 'read-only',
      params: {
        prompt: `Read recent observer evidence for ${runId} and compare it with the proposal finding.`,
      },
    },
  ];
  if (status !== 'unavailable') {
    steps.push({
      id: 'explain-safe-recovery',
      label: 'Explain safe recovery',
      kind: 'prompt',
      safety: 'read-only',
      params: {
        prompt: `Explain operator-confirmed recovery options for ${scoped} without executing writes.`,
      },
    });
  }
  return steps.slice(0, 3);
}

function recoveryDescriptors(
  run: Run,
  step: RunStep | null,
  failureCategory?: FailureCategory,
): RunRecoveryProposal['remediationDescriptors'] {
  const descriptors: NonNullable<RunRecoveryProposal['remediationDescriptors']> = [];
  // Evidence gate: only attach proposedActions when the SELECTED step is the
  // failed one (failureCategory is derived from selectedStep — gating on any
  // failed step in the run would attach a category to descriptors built around
  // a different step, e.g. a running step prioritised by selectRecoveryStep).
  const evidenceSupportsActions =
    step?.status === 'failed' &&
    Boolean(run.slotId) &&
    failureCategory !== undefined &&
    RECOVERABLE_FAILURE_CATEGORIES.has(failureCategory);

  if (step?.status === 'failed') {
    const proposedActions: ChatSuggestedAction[] = [];
    if (evidenceSupportsActions && (step.name === 'prepare' || step.name === 'run')) {
      proposedActions.push({
        type: 'run.replayStep',
        label: `Replay step: ${step.name}`,
        params: { runId: run.id, step: step.name },
      });
    }
    descriptors.push({
      id: 'operator-review-step',
      label: 'Operator reviews failed step',
      description: `Review evidence for step "${step.name}" before choosing any retry or cancellation path.`,
      ...(failureCategory ? { failureCategory } : {}),
      ...(proposedActions.length ? { proposedActions } : {}),
    });
  }

  // Orphaned slot: terminal run still bound to a slot — propose release.
  // Slot binding is conceptually independent of WHY the step failed, so this
  // gate is intentionally NOT routed through evidenceSupportsActions
  // (which couples on selected-step failure + recoverable category). A
  // dispatch-step failure with category=undefined still leaves an orphaned
  // slot the operator can free.
  const runIsTerminal =
    run.status === 'failed' || run.status === 'cancelled' || run.status === 'done';
  if (runIsTerminal && run.slotId) {
    descriptors.push({
      id: 'release-orphaned-slot',
      label: 'Release orphaned slot',
      description: `Run is terminal (${run.status}) but slot ${run.slotId} is still bound; release to free the slot.`,
      proposedActions: [
        {
          type: 'slot.release',
          label: `Release slot ${run.slotId}`,
          params: { slotId: run.slotId },
        },
      ],
    });
  }

  if (run.status === 'blocked' || run.decisions.some((decision) => !decision.resolvedAt)) {
    descriptors.push({
      id: 'resolve-existing-decision',
      label: 'Use existing decision path',
      description:
        'If a pending decision is the blocker, resolve it through the existing confirmed decision UI.',
      policyRef: 'decision.resolve',
    });
  }
  return descriptors.slice(0, 3);
}

// v1 heuristic — no upstream classifier yet, so derive category from step shape.
// Conservative buckets only; unknown failures stay undefined and skip proposedActions.
function deriveFailureCategory(step: RunStep | null): FailureCategory | undefined {
  if (!step || step.status !== 'failed') return undefined;
  const detail = step.detail ?? '';
  // Word-bounded: avoid matching phrases like "did NOT time out" by accident.
  if (/\btimed?\s*out\b|\bTIMEOUT\b/i.test(detail)) return 'timeout';
  if (step.name === 'prepare') return 'infra';
  if (step.name === 'run') return 'flake';
  return undefined;
}

async function readRegisteredLogFallback(
  run: Run,
  step: RunStep | null,
): Promise<RunRecoveryEvidence | null> {
  const candidatePath = findCandidateLogPath(step);
  if (!candidatePath) return null;
  const entries = await listLogRegistryEntries();
  const entry = await findRegisteredLogEntry(candidatePath, entries);
  if (!entry || !entry.exists) {
    return {
      id: 'registered-log-missing',
      source: 'registered-log',
      label: 'Log path was not registered',
      provenance: 'ADR-029 log registry lookup',
      excerpt: compactEvidenceText(
        `A step output referenced ${candidatePath}, but the path was not readable through the registered log registry.`,
      ),
    };
  }
  const { content, truncated } = await readRegisteredLogPrefix(entry.path);
  return {
    id: `registered-log-${safeEvidenceId(entry.id)}`,
    source: 'registered-log',
    label: `Registered log: ${entry.label}`,
    provenance: 'ADR-029 log registry',
    path: entry.displayPath,
    excerpt:
      pickDiagnosticExcerpt(redactLogContent(content)) ??
      compactEvidenceText(
        `Registered log ${entry.displayPath} was readable for run ${run.id.slice(0, 8)}${truncated ? ' (bounded preview truncated)' : ''}.`,
      ),
  };
}

function findCandidateLogPath(step: RunStep | null): string | null {
  const candidateValues = Object.values(step?.outputs ?? {}).filter(
    (value): value is string => typeof value === 'string' && value.trim().length > 0,
  );
  return candidateValues.find((value) => LOG_PATH_RE.test(value)) ?? null;
}

async function readRegisteredLogPrefix(
  absPath: string,
): Promise<{ content: string; truncated: boolean }> {
  const info = await stat(absPath);
  if (info.size === 0) return { content: '', truncated: false };
  const bytesToRead = Math.min(info.size, REGISTERED_LOG_PREVIEW_LIMIT + 1);
  const stream = createReadStream(absPath, {
    encoding: 'utf8',
    start: 0,
    end: Math.max(0, bytesToRead - 1),
  });
  let content = '';
  for await (const chunk of stream) {
    content += chunk;
    if (content.length > REGISTERED_LOG_PREVIEW_LIMIT) {
      stream.destroy();
      break;
    }
  }
  return {
    content: content.slice(0, REGISTERED_LOG_PREVIEW_LIMIT),
    truncated: info.size > bytesToRead || content.length > REGISTERED_LOG_PREVIEW_LIMIT,
  };
}

async function readPreview(label: string, filePath: string | null | undefined) {
  if (!filePath) return null;
  const absPath = path.resolve(filePath);
  if (!isReadableRunPreviewPath(absPath)) return null;
  if (!existsSync(absPath)) return null;
  const { content, truncated } = await readPreviewPrefix(absPath);
  return {
    label,
    path: absPath.replace(`${farmslotRoot}/`, ''),
    content,
    truncated,
  };
}

export function isReadableRunPreviewPath(absPath: string): boolean {
  const candidate = existsSync(absPath) ? realpathSync(absPath) : path.resolve(absPath);
  const relative = path.relative(realFarmslotRoot, candidate);
  return (
    !!relative &&
    !relative.startsWith(`..${path.sep}`) &&
    relative !== '..' &&
    !path.isAbsolute(relative) &&
    relative.split(path.sep).includes('tasks')
  );
}

async function readPreviewPrefix(
  absPath: string,
): Promise<{ content: string; truncated: boolean }> {
  const linkInfo = await lstat(absPath);
  if (linkInfo.isSymbolicLink()) throw new Error('Refusing to read symbolic link');
  const realPath = await realpath(absPath);
  const realRelative = path.relative(realFarmslotRoot, realPath);
  if (
    !isPathInside(realFarmslotRoot, realPath) ||
    !realRelative.split(path.sep).includes('tasks')
  ) {
    throw new Error('Resolved preview path outside approved run context scope');
  }
  const info = await stat(realPath);
  if (info.size === 0) return { content: '', truncated: false };
  const bytesToRead = Math.min(info.size, TEXT_PREVIEW_LIMIT + 1);
  const stream = createReadStream(realPath, {
    encoding: 'utf8',
    start: 0,
    end: Math.max(0, bytesToRead - 1),
  });
  let content = '';
  for await (const chunk of stream) {
    content += chunk;
    if (content.length > TEXT_PREVIEW_LIMIT) {
      stream.destroy();
      break;
    }
  }
  return {
    content: content.slice(0, TEXT_PREVIEW_LIMIT),
    truncated: info.size > bytesToRead || content.length > TEXT_PREVIEW_LIMIT,
  };
}
