// backlog-store.ts — durable backlog intake layer with handoff into dispatch queue

import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  ARCHIVABLE_BACKLOG_STATUSES,
  assertBacklogLaunchPlan,
  type BacklogAutoDispatchTickParams,
  type BacklogAutoDispatchTickResult,
  type BacklogBlockedItem,
  type BacklogCreateParams,
  type BacklogEnqueueResult,
  type BacklogItem,
  type BacklogLaunchCandidate,
  type BacklogLaunchCandidateProjection,
  type BacklogLaunchPlan,
  type BacklogLaunchSlotPolicy,
  type BacklogListParams,
  type BacklogListResult,
  type BacklogMarkReadyParams,
  type BacklogSourceKind,
  type BacklogSpecGetParams,
  type BacklogSpecGetResult,
  type BacklogStatus,
  type BacklogUpcomingParams,
  type BacklogUpcomingResult,
  type BacklogUpdateParams,
  type BacklogUpdateResult,
  type DevInteractiveProfile,
  Events,
  isReviewValidationDepth,
  isTerminalRunStatus,
  normalizeRunTags,
  type OkResult,
  parseGitHubRef,
  PR_BOUND_FLOW_TYPES,
  type QueueItem,
  type ReviewDepthPolicy,
  type ReviewLoopRequest,
  type ReviewRunnerId,
  type Run,
  type RunStatus,
  type TaskTemplateSelection,
} from '@farmslot/protocol';

import { loadProjectVars } from '../core/config.js';
import type { InternalDispatchQueueAddParams } from '../core/queue-types.js';
import { farmslotRoot, loadFleetStatus, loadProjectConfig } from '../fleet/state.js';
import {
  assertTicketRefMatchesProjectRepo,
  JIRA_KEY_RE,
  normalizeTicketRef,
  validateTicketRef,
} from '../methods/dispatch/ticket-ref.js';
import { normalizeRunner, runnerSupportsModel } from '../runners/registry.js';
import { getAllRuns } from '../runs/store.js';
import {
  normalizeTaskTemplateSelection,
  resolveWorkerTemplateSelection,
} from '../tasks/worker-template-options.js';

import {
  addItem,
  getQueueSnapshot,
  persistQueueNow,
  removeQueueItemInternal,
  tryDispatchNext,
} from './dispatch-queue.js';

type BroadcastFn = (event: string, payload: unknown) => void;

const VALID_STATUSES = new Set<BacklogStatus>([
  'candidate',
  'ready',
  'queued',
  'dispatching',
  'running',
  'done',
  'failed',
  'needs-attention',
  'archived',
]);
const VALID_SOURCE_KINDS = new Set<BacklogSourceKind>(['jira', 'github', 'manual']);
const MANUAL_REF_RE = /^MANUAL-\d+$/;
const TERMINAL_STATUSES = new Set<BacklogStatus>(['done', 'failed', 'needs-attention', 'archived']);
const REDISPATCH_AFTER_RUN_RELEASE = new Set<BacklogStatus>([
  'failed',
  'needs-attention',
  'running',
  'queued',
  'dispatching',
]);
const HANDOFF_ACTIVE_STATUSES = new Set<BacklogStatus>(['queued', 'dispatching', 'running']);
const GRAPH_ENQUEUE_ERROR =
  'Backlog item is linked to a work graph; use workGraph.schedulerTick or detach it first';
const BACKLOG_UPDATE_KEYS = new Set([
  'itemId',
  'title',
  'sourceKind',
  'sourceRef',
  'sourceUrl',
  'flowType',
  'notes',
  'tags',
  'roadmapItemId',
  'specPath',
  'priority',
  'allowedSlots',
  'autoDispatch',
  'runner',
  'model',
  'scripted',
  'effort',
  'taskTemplate',
  'app',
  'prepareProfile',
  'mode',
  'devInteractiveProfile',
  'reviewDepth',
  'pendingReviewPlan',
  'launchPlan',
]);

const DISPATCH_MODES = new Set(['interactive', 'autonomous']);
const DEV_INTERACTIVE_PROFILES = new Set(['lightweight', 'reviewed']);
const REVIEW_RUNNERS = new Set<ReviewRunnerId>(['claude', 'codex', 'cursor', 'grok', 'opencode']);

let _broadcast: BroadcastFn | null = null;
const items: BacklogItem[] = [];
let backlogPersistChain: Promise<void> = Promise.resolve();
let backlogMutationTail: Promise<void> = Promise.resolve();
const autoDispatchTickInFlight = new Set<string>();

async function withBacklogMutation<T>(operation: () => Promise<T>): Promise<T> {
  const previous = backlogMutationTail;
  let release!: () => void;
  backlogMutationTail = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    return await operation();
  } finally {
    release();
  }
}

function shouldUseIsolatedBacklogFile(env: NodeJS.ProcessEnv, argv: readonly string[]): boolean {
  if (env.FARMSLOT_TEST_TMP === '1' || env.NODE_TEST_CONTEXT) return true;
  return argv.some((arg) => /(?:^|[/\\])[^/\\]+\.test\.(?:ts|tsx|js|mjs|cjs)$/.test(arg));
}

function resolveBacklogFile(): string {
  if (process.env.FARMSLOT_BACKLOG_FILE) return process.env.FARMSLOT_BACKLOG_FILE;
  if (shouldUseIsolatedBacklogFile(process.env, process.argv)) {
    return path.join(os.tmpdir(), `farmslot-test-backlog-${process.pid}.json`);
  }
  return path.join(farmslotRoot, '.backlog.json');
}

const BACKLOG_FILE = resolveBacklogFile();
const BACKLOG_SPEC_ROOT =
  process.env.FARMSLOT_BACKLOG_SPEC_DIR ?? path.join(farmslotRoot, '.backlog', 'specs');

export function initBacklogStore(broadcast: BroadcastFn): void {
  _broadcast = broadcast;
}

export function isOrphanedBacklogQueueItem(queueItem: QueueItem): boolean {
  return (
    queueItem.status !== 'dispatching' &&
    Boolean(queueItem.backlogItemId) &&
    !items.some((item) => item.id === queueItem.backlogItemId)
  );
}

export function listOrphanedBacklogQueueItems(): QueueItem[] {
  return getQueueSnapshot().filter((queueItem) => isOrphanedBacklogQueueItem(queueItem));
}

export async function removeOrphanBacklogQueueItem(params: { itemId: string }): Promise<OkResult> {
  const queueItem = getQueueSnapshot().find((candidate) => candidate.id === params.itemId);
  if (!queueItem) throw new Error(`Queue item not found: ${params.itemId}`);
  if (!isOrphanedBacklogQueueItem(queueItem)) {
    throw new Error(
      'Cannot remove queue item as orphan: backlog record exists or item is not backlog-linked',
    );
  }
  removeQueueItemInternal(queueItem.id, 'orphan-remove');
  await persistQueueNow();
  return { ok: true };
}

async function persist(): Promise<void> {
  await mkdir(path.dirname(BACKLOG_FILE), { recursive: true });
  const tmpFile = `${BACKLOG_FILE}.tmp`;
  await writeFile(tmpFile, JSON.stringify(items, null, 2), 'utf-8');
  await rename(tmpFile, BACKLOG_FILE);
}

function enqueuePersist(reason: string): Promise<void> {
  backlogPersistChain = backlogPersistChain
    .catch(() => undefined)
    .then(() => persist())
    .catch((err) => {
      console.error(`[backlog] persist failed after ${reason}: ${(err as Error).message}`);
      throw err;
    });
  return backlogPersistChain;
}

function schedulePersist(reason: string): void {
  enqueuePersist(reason).catch(() => undefined);
}

async function persistNow(reason: string): Promise<void> {
  await enqueuePersist(reason);
}

export async function flushBacklogForTests(): Promise<void> {
  await persistNow('test-flush');
}

function broadcastBacklog(): void {
  _broadcast?.(Events.BACKLOG_UPDATED, {
    items: listBacklogItems({ includeArchived: true }).items,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out = value.filter(
    (entry): entry is string => typeof entry === 'string' && entry.length > 0,
  );
  return out.length > 0 ? out : undefined;
}

function normalizeOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function normalizeExecutionHint(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new Error(`${field} must be a string`);
  const normalized = value.trim();
  if (!normalized) throw new Error(`${field} cannot be empty`);
  return normalized;
}

function normalizeRunnerHint(value: unknown): string | undefined {
  const runner = normalizeExecutionHint(value, 'runner');
  return runner ? normalizeRunner(runner) : undefined;
}

function normalizeDispatchMode(value: unknown): BacklogItem['mode'] | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || !DISPATCH_MODES.has(value)) {
    throw new Error('mode must be interactive or autonomous');
  }
  return value as BacklogItem['mode'];
}

function normalizeDevInteractiveProfile(value: unknown): DevInteractiveProfile | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || !DEV_INTERACTIVE_PROFILES.has(value)) {
    throw new Error('devInteractiveProfile must be lightweight or reviewed');
  }
  return value as DevInteractiveProfile;
}

function normalizeBacklogTaskTemplate(
  flowType: BacklogItem['flowType'],
  value: unknown,
): TaskTemplateSelection | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) throw new Error('taskTemplate must be an object');
  return normalizeTaskTemplateSelection(flowType, {
    fileName: normalizeExecutionHint(value.fileName, 'taskTemplate.fileName') ?? '',
    variant:
      value.variant === null || value.variant === undefined
        ? null
        : normalizeExecutionHint(value.variant, 'taskTemplate.variant'),
  });
}

function normalizeReviewDepth(value: unknown): ReviewDepthPolicy | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) throw new Error('reviewDepth must be an object');
  const minimumIndependentReviews = Number(value.minimumIndependentReviews);
  const extraLoopsRequested = Number(value.extraLoopsRequested);
  if (!Number.isInteger(minimumIndependentReviews) || minimumIndependentReviews < 0) {
    throw new Error('reviewDepth.minimumIndependentReviews must be a non-negative integer');
  }
  if (!Number.isInteger(extraLoopsRequested) || extraLoopsRequested < 0) {
    throw new Error('reviewDepth.extraLoopsRequested must be a non-negative integer');
  }
  if (typeof value.requireCrossRunner !== 'boolean') {
    throw new Error('reviewDepth.requireCrossRunner must be a boolean');
  }
  if (
    value.requestedBy !== 'dispatch' &&
    value.requestedBy !== 'human-gate' &&
    value.requestedBy !== 'agent-gate'
  ) {
    throw new Error('reviewDepth.requestedBy is invalid');
  }
  return {
    minimumIndependentReviews,
    requireCrossRunner: value.requireCrossRunner,
    extraLoopsRequested,
    requestedBy: value.requestedBy,
  };
}

function normalizePendingReviewPlan(value: unknown): ReviewLoopRequest[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) throw new Error('pendingReviewPlan must be an array');
  const plan = value.slice(0, 5).map((entry, index): ReviewLoopRequest => {
    if (!isRecord(entry)) throw new Error(`pendingReviewPlan[${index}] must be an object`);
    const runner = normalizeExecutionHint(entry.runner, `pendingReviewPlan[${index}].runner`);
    if (runner !== 'same' && !REVIEW_RUNNERS.has(runner as ReviewRunnerId)) {
      throw new Error(`pendingReviewPlan[${index}].runner is invalid`);
    }
    const order = Number(entry.order ?? index + 1);
    if (!Number.isInteger(order) || order < 1) {
      throw new Error(`pendingReviewPlan[${index}].order must be a positive integer`);
    }
    const validationDepth =
      entry.validationDepth === undefined || entry.validationDepth === null
        ? undefined
        : entry.validationDepth;
    if (validationDepth !== undefined && !isReviewValidationDepth(validationDepth)) {
      throw new Error(`pendingReviewPlan[${index}].validationDepth is invalid`);
    }
    return {
      order,
      runner: runner as ReviewLoopRequest['runner'],
      ...(typeof entry.model === 'string' && entry.model.trim()
        ? { model: entry.model.trim() }
        : {}),
      ...(validationDepth ? { validationDepth } : {}),
    };
  });
  return plan.length > 0 ? plan : undefined;
}

function assertExecutionHintsCompatible(item: BacklogItem): void {
  if (item.runner && item.model && !runnerSupportsModel(item.runner, item.model)) {
    throw new Error(`model ${item.model} is not compatible with runner ${item.runner}`);
  }
  if (item.taskTemplate) {
    normalizeBacklogTaskTemplate(item.flowType, item.taskTemplate);
  }
  for (const candidate of item.launchPlan?.candidates ?? []) {
    const runner = candidate.runner ?? item.runner;
    const model = candidate.model ?? item.model;
    if (runner && model && !runnerSupportsModel(runner, model)) {
      throw new Error(`model ${model} is not compatible with runner ${runner}`);
    }
  }
}

function normalizeOptionalSpecPath(value: unknown): string | undefined {
  const specPath = normalizeOptionalString(value);
  if (!specPath) return undefined;
  if (specPath.includes('\0')) throw new Error('specPath cannot contain null bytes');
  return specPath;
}

function resolveSpecPath(specPath: string): string {
  const resolved = path.resolve(farmslotRoot, specPath);
  const root = path.resolve(BACKLOG_SPEC_ROOT);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error('specPath must stay within the configured backlog spec directory');
  }
  return resolved;
}

async function readBacklogSpecMarkdown(item: BacklogItem): Promise<string | null> {
  if (!item.specPath) return null;
  return readFile(resolveSpecPath(item.specPath), 'utf-8');
}

export function extractBacklogAcceptanceCriteria(markdown: string): string[] {
  const lines = markdown.split(/\r?\n/);
  const headingIndex = lines.findIndex((line) => /^##\s+Acceptance Criteria\s*$/i.test(line));
  if (headingIndex < 0) return [];
  const body: string[] = [];
  for (const line of lines.slice(headingIndex + 1)) {
    if (/^#{1,2}\s+\S/.test(line)) break;
    body.push(line);
  }
  return body
    .join('\n')
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*[-*]\s+/, '').trim())
    .filter(Boolean);
}

async function assertBacklogSpecReady(item: BacklogItem): Promise<void> {
  if (!item.specPath) return;
  if (item.sourceKind !== 'manual') {
    throw new Error('Markdown-backed backlog specs must use manual sourceKind');
  }
  const markdown = await readBacklogSpecMarkdown(item);
  const acceptanceCriteria = extractBacklogAcceptanceCriteria(markdown ?? '');
  if (acceptanceCriteria.length === 0) {
    throw new Error(
      'Markdown-backed backlog specs require a non-empty ## Acceptance Criteria section',
    );
  }
}

function normalizeStoredItem(raw: unknown): BacklogItem | null {
  if (!isRecord(raw)) return null;
  const id = typeof raw.id === 'string' && raw.id ? raw.id : null;
  const project = typeof raw.project === 'string' && raw.project ? raw.project : null;
  const title = typeof raw.title === 'string' && raw.title ? raw.title : null;
  const sourceKind = typeof raw.sourceKind === 'string' ? raw.sourceKind : null;
  const sourceRef = typeof raw.sourceRef === 'string' && raw.sourceRef ? raw.sourceRef : null;
  const flowType = typeof raw.flowType === 'string' && raw.flowType ? raw.flowType : null;
  const status = typeof raw.status === 'string' ? raw.status : null;
  const createdAt = typeof raw.createdAt === 'string' && raw.createdAt ? raw.createdAt : null;
  const updatedAt = typeof raw.updatedAt === 'string' && raw.updatedAt ? raw.updatedAt : null;
  if (
    !id ||
    !project ||
    !title ||
    !sourceKind ||
    !VALID_SOURCE_KINDS.has(sourceKind as BacklogSourceKind) ||
    !sourceRef ||
    !flowType ||
    !status ||
    !VALID_STATUSES.has(status as BacklogStatus) ||
    !createdAt ||
    !updatedAt
  ) {
    return null;
  }
  const tags = normalizeRunTags(normalizeStringArray(raw.tags));
  const roadmapItemId = normalizeOptionalString(raw.roadmapItemId);
  const rawSpecPath = normalizeOptionalString(raw.specPath);
  const specPath = rawSpecPath && !rawSpecPath.includes('\0') ? rawSpecPath : undefined;
  const workGraphId = normalizeOptionalString(raw.workGraphId);
  const workNodeId = normalizeOptionalString(raw.workNodeId);
  const runner = normalizeOptionalString(raw.runner)
    ? normalizeRunner(normalizeOptionalString(raw.runner))
    : undefined;
  const model = normalizeOptionalString(raw.model);
  const effort = normalizeOptionalString(raw.effort);
  const parsedFlowType = flowType as BacklogItem['flowType'];
  const taskTemplate = normalizeBacklogTaskTemplate(parsedFlowType, raw.taskTemplate);
  const app = normalizeOptionalString(raw.app);
  const prepareProfile = normalizeOptionalString(raw.prepareProfile);
  const mode = normalizeDispatchMode(raw.mode);
  const devInteractiveProfile = normalizeDevInteractiveProfile(raw.devInteractiveProfile);
  const reviewDepth = normalizeReviewDepth(raw.reviewDepth);
  const pendingReviewPlan = normalizePendingReviewPlan(raw.pendingReviewPlan);
  const launchPlan = normalizeLaunchPlan(raw.launchPlan);
  const launchPlanState = isRecord(raw.launchPlanState)
    ? {
        launchGroupId: normalizeOptionalString(raw.launchPlanState.launchGroupId) ?? '',
        ...(normalizeOptionalString(raw.launchPlanState.baselineRunId)
          ? { baselineRunId: normalizeOptionalString(raw.launchPlanState.baselineRunId) }
          : {}),
        ...(normalizeOptionalString(raw.launchPlanState.baselineQueueItemId)
          ? {
              baselineQueueItemId: normalizeOptionalString(raw.launchPlanState.baselineQueueItemId),
            }
          : {}),
        candidates: Array.isArray(raw.launchPlanState.candidates)
          ? raw.launchPlanState.candidates
              .filter(isRecord)
              .map((candidate): BacklogLaunchCandidateProjection | null => {
                const candidateId = normalizeOptionalString(candidate.candidateId);
                const status = normalizeOptionalString(candidate.status);
                if (!candidateId || !status) return null;
                return {
                  candidateId,
                  status: status as BacklogLaunchCandidateProjection['status'],
                  ...(normalizeOptionalString(candidate.queueItemId)
                    ? { queueItemId: normalizeOptionalString(candidate.queueItemId) }
                    : {}),
                  ...(normalizeOptionalString(candidate.runId)
                    ? { runId: normalizeOptionalString(candidate.runId) }
                    : {}),
                  ...(normalizeOptionalString(candidate.slotId)
                    ? { slotId: normalizeOptionalString(candidate.slotId) }
                    : {}),
                  ...(normalizeOptionalString(candidate.waitingReason)
                    ? { waitingReason: normalizeOptionalString(candidate.waitingReason) }
                    : {}),
                };
              })
              .filter((candidate): candidate is BacklogLaunchCandidateProjection =>
                Boolean(candidate),
              )
          : [],
      }
    : undefined;
  return {
    id,
    project,
    title,
    sourceKind: sourceKind as BacklogSourceKind,
    sourceRef,
    ...(typeof raw.sourceUrl === 'string' && raw.sourceUrl ? { sourceUrl: raw.sourceUrl } : {}),
    flowType: parsedFlowType,
    status: status as BacklogStatus,
    ...(typeof raw.notes === 'string' ? { notes: raw.notes } : {}),
    ...(tags.length > 0 ? { tags } : {}),
    ...(roadmapItemId ? { roadmapItemId } : {}),
    ...(specPath ? { specPath } : {}),
    ...(workGraphId ? { workGraphId } : {}),
    ...(workNodeId ? { workNodeId } : {}),
    priority: typeof raw.priority === 'number' && Number.isFinite(raw.priority) ? raw.priority : 10,
    ...(normalizeStringArray(raw.allowedSlots)
      ? { allowedSlots: normalizeStringArray(raw.allowedSlots) }
      : {}),
    ...(typeof raw.autoDispatch === 'boolean' ? { autoDispatch: raw.autoDispatch } : {}),
    ...(runner ? { runner } : {}),
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
    ...(taskTemplate ? { taskTemplate } : {}),
    ...(app ? { app } : {}),
    ...(prepareProfile ? { prepareProfile } : {}),
    ...(mode ? { mode } : {}),
    ...(devInteractiveProfile ? { devInteractiveProfile } : {}),
    ...(reviewDepth ? { reviewDepth } : {}),
    ...(pendingReviewPlan ? { pendingReviewPlan } : {}),
    ...(launchPlan ? { launchPlan } : {}),
    ...(launchPlanState?.launchGroupId ? { launchPlanState } : {}),
    createdAt,
    updatedAt,
    ...(typeof raw.queuedQueueItemId === 'string'
      ? { queuedQueueItemId: raw.queuedQueueItemId }
      : {}),
    ...(typeof raw.runId === 'string' ? { runId: raw.runId } : {}),
    ...(typeof raw.lastObservedRunStatus === 'string'
      ? { lastObservedRunStatus: raw.lastObservedRunStatus as RunStatus }
      : {}),
    ...(typeof raw.lastDispatchAttempt === 'string'
      ? { lastDispatchAttempt: raw.lastDispatchAttempt }
      : {}),
    ...(typeof raw.lastDispatchError === 'string'
      ? { lastDispatchError: raw.lastDispatchError }
      : {}),
  };
}

function ensureLaunchPlanState(item: BacklogItem): NonNullable<BacklogItem['launchPlanState']> {
  if (!item.launchPlan) throw new Error('launchPlanState requires launchPlan');
  if (!item.launchPlanState) {
    item.launchPlanState = {
      launchGroupId: `${item.id}:${item.launchPlan.id}`,
      candidates: item.launchPlan.candidates.map((candidate) => ({
        candidateId: candidate.id,
        status: 'planned',
      })),
    };
  }
  return item.launchPlanState;
}

function projectionForCandidate(
  item: BacklogItem,
  candidateId: string,
): BacklogLaunchCandidateProjection | null {
  const state = item.launchPlanState;
  if (!state) return null;
  let projection = state.candidates.find((candidate) => candidate.candidateId === candidateId);
  if (!projection) {
    projection = { candidateId, status: 'planned' };
    state.candidates.push(projection);
  }
  return projection;
}

function statusFromRun(run: Run): BacklogLaunchCandidateProjection['status'] {
  if (run.status === 'done') return 'succeeded';
  if (run.status === 'failed') return 'failed';
  if (run.status === 'cancelled') return 'cancelled';
  if (run.status === 'human-gating') return 'gated';
  if (run.status === 'blocked') return 'blocked';
  return 'running';
}

function rollUpLaunchPlanStatus(item: BacklogItem): void {
  const projections = item.launchPlanState?.candidates ?? [];
  if (projections.length === 0) return;
  if (projections.some((candidate) => candidate.status === 'failed')) item.status = 'failed';
  else if (
    projections.some(
      (candidate) => candidate.status === 'cancelled' || candidate.status === 'blocked',
    )
  ) {
    item.status = 'needs-attention';
  } else if (projections.every((candidate) => candidate.status === 'succeeded')) {
    item.status = 'done';
  } else if (
    projections.some((candidate) => candidate.status === 'running' || candidate.status === 'gated')
  ) {
    item.status = 'running';
  } else if (projections.some((candidate) => candidate.status === 'queued')) {
    item.status = 'queued';
  }
}

function applyLaunchPlanRunObservation(item: BacklogItem, run: Run): boolean {
  if (!item.launchPlan || !run.launchCandidateId) return false;
  const previous = JSON.stringify({
    status: item.status,
    state: item.launchPlanState,
    runId: item.runId,
  });
  ensureLaunchPlanState(item);
  const projection = projectionForCandidate(item, run.launchCandidateId);
  if (!projection) return false;
  projection.runId = run.id;
  projection.slotId = run.slotId ?? undefined;
  delete projection.queueItemId;
  projection.status = statusFromRun(run);
  if (run.launchCandidateId === launchCandidateByRole(item, 'baseline')?.id) {
    item.runId = run.id;
    item.lastObservedRunStatus = run.status;
    item.launchPlanState!.baselineRunId = run.id;
    delete item.queuedQueueItemId;
  }
  rollUpLaunchPlanStatus(item);
  const changed =
    previous !==
    JSON.stringify({
      status: item.status,
      state: item.launchPlanState,
      runId: item.runId,
    });
  if (changed) item.updatedAt = new Date().toISOString();
  return changed;
}

function releaseBacklogRunLink(item: BacklogItem, runId: string): boolean {
  let touched = false;
  if (item.launchPlanState) {
    if (item.launchPlanState.baselineRunId === runId) {
      delete item.launchPlanState.baselineRunId;
      touched = true;
    }
    for (const projection of item.launchPlanState.candidates) {
      if (projection.runId !== runId) continue;
      delete projection.runId;
      if (projection.status !== 'planned') {
        projection.status = 'planned';
      }
      touched = true;
    }
  }
  if (item.runId !== runId) {
    if (touched) {
      rollUpLaunchPlanStatus(item);
      item.updatedAt = new Date().toISOString();
    }
    return touched;
  }

  delete item.runId;
  delete item.lastObservedRunStatus;
  delete item.lastDispatchError;
  touched = true;
  if (REDISPATCH_AFTER_RUN_RELEASE.has(item.status)) {
    item.status = 'ready';
  }
  if (item.launchPlanState) rollUpLaunchPlanStatus(item);
  item.updatedAt = new Date().toISOString();
  return touched;
}

function shouldApplyLinkedRunObservation(item: BacklogItem, run: Run): boolean {
  if (!TERMINAL_STATUSES.has(item.status)) return true;
  if (item.status === 'done' || item.status === 'archived') return false;
  if (item.status === 'needs-attention' || item.status === 'failed') {
    return isTerminalRunStatus(run.status);
  }
  return false;
}

function applyRunObservation(item: BacklogItem, run: Run): boolean {
  if (item.launchPlan && run.launchCandidateId) return applyLaunchPlanRunObservation(item, run);
  const previousStatus = item.status;
  const previousRunId = item.runId;
  const previousObservedStatus = item.lastObservedRunStatus;
  item.runId = run.id;
  item.lastObservedRunStatus = run.status;
  if (run.status === 'cancelled' && run.redirectedToRunId) return false;
  if (['done', 'failed', 'cancelled', 'blocked'].includes(run.status)) {
    delete item.queuedQueueItemId;
  }
  if (run.status === 'done') item.status = 'done';
  else if (run.status === 'failed') item.status = 'failed';
  else if (run.status === 'cancelled' || run.status === 'blocked') item.status = 'needs-attention';
  else item.status = 'running';
  const changed =
    previousStatus !== item.status ||
    previousRunId !== item.runId ||
    previousObservedStatus !== item.lastObservedRunStatus;
  if (changed) item.updatedAt = new Date().toISOString();
  return changed;
}

async function reconcileBacklogLinks(): Promise<boolean> {
  let changed = false;
  const queueItems = getQueueSnapshot();
  const queueByBacklogId = new Map<string, QueueItem>();
  const queueByCandidate = new Map<string, QueueItem>();
  for (const queueItem of queueItems) {
    if (queueItem.backlogItemId) queueByBacklogId.set(queueItem.backlogItemId, queueItem);
    if (queueItem.backlogItemId && queueItem.launchPlanId && queueItem.launchCandidateId) {
      queueByCandidate.set(
        launchCandidateKey(
          queueItem.backlogItemId,
          queueItem.launchPlanId,
          queueItem.launchCandidateId,
        ),
        queueItem,
      );
    }
  }
  const allRuns = getAllRuns();
  const runsById = new Map(allRuns.map((run) => [run.id, run]));
  const runByCandidate = new Map<string, Run>();
  for (const run of allRuns) {
    if (run.backlogItemId && run.launchPlanId && run.launchCandidateId) {
      runByCandidate.set(
        launchCandidateKey(run.backlogItemId, run.launchPlanId, run.launchCandidateId),
        run,
      );
    }
  }

  for (const item of items) {
    if (item.launchPlan) {
      ensureLaunchPlanState(item);
      let baselineRun: Run | undefined;
      for (const candidate of item.launchPlan.candidates) {
        const projection = projectionForCandidate(item, candidate.id);
        const key = launchCandidateKey(item.id, item.launchPlan.id, candidate.id);
        const run = runByCandidate.get(key);
        if (run) {
          if (candidate.role === 'baseline') baselineRun = run;
          if (applyLaunchPlanRunObservation(item, run)) changed = true;
          continue;
        }
        if (projection?.runId && !runsById.has(projection.runId)) {
          if (releaseBacklogRunLink(item, projection.runId)) changed = true;
          continue;
        }
        const queued = queueByCandidate.get(key);
        if (queued && projection && projection.queueItemId !== queued.id) {
          projection.status = 'queued';
          projection.queueItemId = queued.id;
          if (candidate.role === 'baseline') {
            item.queuedQueueItemId = queued.id;
            item.launchPlanState!.baselineQueueItemId = queued.id;
          }
          changed = true;
        }
      }
      if (baselineRun && (await materializeMissingComparisonCandidates(item, baselineRun))) {
        changed = true;
      }
      rollUpLaunchPlanStatus(item);
      continue;
    }
    if (item.runId) {
      const run = runsById.get(item.runId);
      if (run) {
        if (shouldApplyLinkedRunObservation(item, run) && applyRunObservation(item, run))
          changed = true;
      } else if (REDISPATCH_AFTER_RUN_RELEASE.has(item.status)) {
        if (releaseBacklogRunLink(item, item.runId)) changed = true;
      } else if (!TERMINAL_STATUSES.has(item.status)) {
        item.status = 'needs-attention';
        item.lastDispatchError = `Linked run ${item.runId} was not found after restart`;
        delete item.runId;
        delete item.lastObservedRunStatus;
        item.updatedAt = new Date().toISOString();
        changed = true;
      }
      continue;
    }

    const queued = queueByBacklogId.get(item.id);
    if (queued) {
      if (item.status !== 'queued' || item.queuedQueueItemId !== queued.id) {
        item.status = 'queued';
        item.queuedQueueItemId = queued.id;
        item.updatedAt = new Date().toISOString();
        delete item.lastDispatchError;
        changed = true;
      }
      continue;
    }

    if (item.queuedQueueItemId && (item.status === 'queued' || item.status === 'dispatching')) {
      item.status = 'needs-attention';
      item.lastDispatchError = `Linked queue item ${item.queuedQueueItemId} was not found after restart`;
      delete item.queuedQueueItemId;
      item.updatedAt = new Date().toISOString();
      changed = true;
    }
  }
  return changed;
}

export async function loadBacklog(): Promise<void> {
  items.length = 0;
  try {
    const raw = await readFile(BACKLOG_FILE, 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error('backlog file must contain an array');
    for (const entry of parsed) {
      const normalized = normalizeStoredItem(entry);
      if (normalized) items.push(normalized);
    }
    console.log(`[backlog] loaded ${items.length} items from disk`);
    if (await reconcileBacklogLinks()) schedulePersist('load-reconcile');
    const orphans = listOrphanedBacklogQueueItems();
    if (orphans.length > 0) {
      console.warn(
        `[backlog] ${orphans.length} queue item(s) reference missing backlog records; remove explicitly from the queue or Doctor`,
      );
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      const orphans = listOrphanedBacklogQueueItems();
      if (orphans.length > 0) {
        console.warn(
          `[backlog] backlog file missing with ${orphans.length} orphaned queue item(s); remove explicitly from the queue or Doctor`,
        );
      }
      return;
    }
    throw new Error(`[backlog] failed to load backlog: ${(err as Error).message}`);
  }
}

function sortedBacklog(source: readonly BacklogItem[]): BacklogItem[] {
  return [...source].sort(
    (a, b) => a.priority - b.priority || a.createdAt.localeCompare(b.createdAt),
  );
}

export function listBacklogItems(params: BacklogListParams = {}): BacklogListResult {
  const tagFilter = normalizeRunTags(params.tags);
  const filtered = items.filter((item) => {
    if (params.project && item.project !== params.project) return false;
    if (params.status && item.status !== params.status) return false;
    if (tagFilter.length > 0) {
      const itemTags = new Set(normalizeRunTags(item.tags));
      if (!tagFilter.every((tag) => itemTags.has(tag))) return false;
    }
    if (!params.includeArchived && params.status !== 'archived' && item.status === 'archived') {
      return false;
    }
    return true;
  });
  return { items: sortedBacklog(filtered) };
}

function nextManualRef(): string {
  let max = 0;
  for (const item of items) {
    const match = item.sourceRef.match(/^MANUAL-(\d+)$/);
    if (match) max = Math.max(max, Number(match[1]));
  }
  return `MANUAL-${String(max + 1).padStart(6, '0')}`;
}

function normalizeManualRef(ref: string): string {
  const normalized = ref.trim().toUpperCase();
  const match = normalized.match(/^MANUAL-(\d+)$/);
  if (!match) return normalized;
  return `MANUAL-${String(Number(match[1])).padStart(6, '0')}`;
}

function normalizeAllowedSlots(value: string[] | null | undefined): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const unique = [...new Set(value.map((slot) => slot.trim()).filter(Boolean))];
  if (unique.length === 0) throw new Error('allowedSlots must contain at least one slot when set');
  return unique;
}

function cloneLaunchPlan(plan: BacklogLaunchPlan): BacklogLaunchPlan {
  return {
    ...plan,
    candidates: plan.candidates.map((candidate) => ({
      ...candidate,
      ...(candidate.variant !== undefined ? { variant: candidate.variant.trim() } : {}),
      slotPolicy:
        candidate.slotPolicy.kind === 'exact'
          ? { kind: 'exact', slotId: candidate.slotPolicy.slotId }
          : candidate.slotPolicy.kind === 'pool'
            ? { kind: 'pool', allowedSlots: [...candidate.slotPolicy.allowedSlots] }
            : {
                kind: 'spread',
                ...(candidate.slotPolicy.allowedSlots
                  ? { allowedSlots: [...candidate.slotPolicy.allowedSlots] }
                  : {}),
              },
    })),
  };
}

function normalizeLaunchPlan(value: unknown): BacklogLaunchPlan | undefined {
  if (value === undefined || value === null) return undefined;
  assertBacklogLaunchPlan(value);
  return cloneLaunchPlan(value);
}

function slotsForLaunchPolicy(policy: BacklogLaunchSlotPolicy): string[] | undefined {
  if (policy.kind === 'exact') return [policy.slotId];
  if (policy.kind === 'pool') return policy.allowedSlots;
  return policy.allowedSlots;
}

function launchCandidateByRole(item: BacklogItem, role: BacklogLaunchCandidate['role']) {
  return item.launchPlan?.candidates.find((candidate) => candidate.role === role);
}

async function assertSlotsBelongToProject(project: string, allowedSlots?: string[]): Promise<void> {
  if (!allowedSlots || allowedSlots.length === 0) return;
  const fleet = await loadFleetStatus();
  for (const slotId of allowedSlots) {
    const slot = fleet.slots.find((candidate) => candidate.slot === slotId);
    if (!slot) throw new Error(`allowed slot not found: ${slotId}`);
    if (slot.project !== project) {
      throw new Error(`allowed slot ${slotId} belongs to project ${slot.project}, not ${project}`);
    }
  }
}

async function assertAllowedSlotsBelongToProject(item: BacklogItem): Promise<void> {
  await assertSlotsBelongToProject(item.project, item.allowedSlots);
  for (const candidate of item.launchPlan?.candidates ?? []) {
    await assertSlotsBelongToProject(item.project, slotsForLaunchPolicy(candidate.slotPolicy));
  }
}

async function normalizeSourceFields(
  sourceKind: BacklogSourceKind,
  sourceRef: string | undefined,
  flowType: BacklogItem['flowType'],
  project: string,
): Promise<string> {
  await loadProjectVars(project);
  if (sourceKind === 'manual') {
    if (PR_BOUND_FLOW_TYPES.has(flowType)) {
      throw new Error(`Manual backlog items cannot use PR-bound flow '${flowType}'`);
    }
    if (!sourceRef?.trim()) return nextManualRef();
    const normalized = normalizeManualRef(sourceRef);
    if (!MANUAL_REF_RE.test(normalized)) {
      throw new Error('Manual backlog sourceRef must use MANUAL-<numeric-sequence>');
    }
    return normalized;
  }

  const normalized = normalizeTicketRef(sourceRef ?? '');
  validateTicketRef(normalized, flowType);
  const projectConfig = await loadProjectConfig(project);
  assertTicketRefMatchesProjectRepo(normalized, project, projectConfig?.ci?.repo);
  if (sourceKind === 'jira' && !JIRA_KEY_RE.test(normalized)) {
    throw new Error('Jira backlog items require a Jira key or Jira URL sourceRef');
  }
  if (sourceKind === 'github' && !parseGitHubRef(normalized)) {
    throw new Error('GitHub backlog items require a GitHub issue/PR ref or URL sourceRef');
  }
  return normalized;
}

export async function createBacklogItem(
  params: BacklogCreateParams,
): Promise<{ item: BacklogItem }> {
  return withBacklogMutation(async () => {
    if (!params.project?.trim()) throw new Error('Backlog item project is required');
    if (!params.title?.trim()) throw new Error('Backlog item title is required');
    if (!VALID_SOURCE_KINDS.has(params.sourceKind)) throw new Error('Invalid backlog source kind');
    const sourceRef = await normalizeSourceFields(
      params.sourceKind,
      params.sourceRef,
      params.flowType,
      params.project,
    );
    const allowedSlots = normalizeAllowedSlots(params.allowedSlots);
    const tags = normalizeRunTags(params.tags);
    const roadmapItemId = normalizeOptionalString(params.roadmapItemId);
    const specPath = normalizeOptionalSpecPath(params.specPath);
    const runner = normalizeRunnerHint(params.runner);
    const model = normalizeExecutionHint(params.model, 'model');
    const effort = normalizeExecutionHint(params.effort, 'effort');
    const taskTemplate = normalizeBacklogTaskTemplate(params.flowType, params.taskTemplate);
    const app = normalizeOptionalString(params.app);
    const prepareProfile = normalizeOptionalString(params.prepareProfile);
    const mode = normalizeDispatchMode(params.mode);
    const devInteractiveProfile = normalizeDevInteractiveProfile(params.devInteractiveProfile);
    const reviewDepth = normalizeReviewDepth(params.reviewDepth);
    const pendingReviewPlan = normalizePendingReviewPlan(params.pendingReviewPlan);
    const launchPlan = normalizeLaunchPlan(params.launchPlan);
    const now = new Date().toISOString();
    const item: BacklogItem = {
      id: randomUUID(),
      project: params.project.trim(),
      title: params.title.trim(),
      sourceKind: params.sourceKind,
      sourceRef,
      ...(params.sourceUrl?.trim() ? { sourceUrl: params.sourceUrl.trim() } : {}),
      flowType: params.flowType,
      status: params.status === 'ready' ? 'ready' : 'candidate',
      ...(params.notes !== undefined ? { notes: params.notes } : {}),
      ...(tags.length > 0 ? { tags } : {}),
      ...(roadmapItemId ? { roadmapItemId } : {}),
      ...(specPath ? { specPath } : {}),
      priority: params.priority ?? 10,
      ...(allowedSlots ? { allowedSlots } : {}),
      ...(typeof params.autoDispatch === 'boolean' ? { autoDispatch: params.autoDispatch } : {}),
      ...(runner ? { runner } : {}),
      ...(model ? { model } : {}),
      ...(params.scripted ? { scripted: params.scripted } : {}),
      ...(effort ? { effort } : {}),
      ...(taskTemplate ? { taskTemplate } : {}),
      ...(app ? { app } : {}),
      ...(prepareProfile ? { prepareProfile } : {}),
      ...(mode ? { mode } : {}),
      ...(devInteractiveProfile ? { devInteractiveProfile } : {}),
      ...(reviewDepth ? { reviewDepth } : {}),
      ...(pendingReviewPlan ? { pendingReviewPlan } : {}),
      ...(launchPlan ? { launchPlan } : {}),
      createdAt: now,
      updatedAt: now,
    };
    assertExecutionHintsCompatible(item);
    if (item.status === 'ready') await assertBacklogSpecReady(item);
    items.push(item);
    schedulePersist('create');
    broadcastBacklog();
    return { item };
  });
}

function getItem(itemId: string): BacklogItem {
  const item = items.find((candidate) => candidate.id === itemId);
  if (!item) throw new Error(`Backlog item not found: ${itemId}`);
  return item;
}

export function getBacklogItemSnapshot(itemId: string): BacklogItem | null {
  const item = items.find((candidate) => candidate.id === itemId);
  return item
    ? {
        ...item,
        tags: item.tags ? [...item.tags] : undefined,
        allowedSlots: item.allowedSlots ? [...item.allowedSlots] : undefined,
        launchPlan: item.launchPlan ? cloneLaunchPlan(item.launchPlan) : undefined,
        launchPlanState: item.launchPlanState
          ? {
              ...item.launchPlanState,
              candidates: item.launchPlanState.candidates.map((candidate) => ({ ...candidate })),
            }
          : undefined,
      }
    : null;
}

export function listBacklogItemSnapshots(): BacklogItem[] {
  return items.map((item) => ({
    ...item,
    tags: item.tags ? [...item.tags] : undefined,
    allowedSlots: item.allowedSlots ? [...item.allowedSlots] : undefined,
    launchPlan: item.launchPlan ? cloneLaunchPlan(item.launchPlan) : undefined,
    launchPlanState: item.launchPlanState
      ? {
          ...item.launchPlanState,
          candidates: item.launchPlanState.candidates.map((candidate) => ({ ...candidate })),
        }
      : undefined,
  }));
}

function assertBacklogItemWorkNodeLink(params: {
  itemId: string;
  graphId: string;
  nodeId: string;
}): BacklogItem {
  const item = getItem(params.itemId);
  if (item.workGraphId !== params.graphId || item.workNodeId !== params.nodeId) {
    throw new Error(
      `Backlog item ${params.itemId} is not linked to work graph ${params.graphId}/${params.nodeId}`,
    );
  }
  return item;
}

export function assertBacklogItemAttachedToWorkNode(params: {
  itemId: string;
  graphId: string;
  nodeId: string;
}): void {
  assertBacklogItemWorkNodeLink(params);
}

export async function attachBacklogItemToWorkNode(params: {
  itemId: string;
  graphId: string;
  nodeId: string;
}): Promise<BacklogItem> {
  return withBacklogMutation(async () => {
    const item = getItem(params.itemId);
    if (
      item.workGraphId &&
      (item.workGraphId !== params.graphId || item.workNodeId !== params.nodeId)
    ) {
      throw new Error(
        `Backlog item ${params.itemId} is already linked to work graph ${item.workGraphId}`,
      );
    }
    item.workGraphId = params.graphId;
    item.workNodeId = params.nodeId;
    item.updatedAt = new Date().toISOString();
    await persistNow('work-graph-attach');
    broadcastBacklog();
    return item;
  });
}

export async function detachBacklogItemFromWorkNode(params: {
  itemId: string;
  graphId: string;
  nodeId: string;
}): Promise<BacklogItem> {
  return withBacklogMutation(async () => {
    const item = assertBacklogItemWorkNodeLink(params);
    delete item.workGraphId;
    delete item.workNodeId;
    item.updatedAt = new Date().toISOString();
    await persistNow('work-graph-detach');
    broadcastBacklog();
    return item;
  });
}

export async function updateBacklogItem(params: BacklogUpdateParams): Promise<BacklogUpdateResult> {
  return withBacklogMutation(async () => {
    const unknownKeys = Object.keys(params).filter((key) => !BACKLOG_UPDATE_KEYS.has(key));
    if (unknownKeys.length > 0) {
      throw new Error('backlog.update cannot mutate lifecycle, run linkage, or dispatch errors');
    }
    const itemIndex = items.findIndex((candidate) => candidate.id === params.itemId);
    if (itemIndex < 0) throw new Error(`Backlog item not found: ${params.itemId}`);
    const item = items[itemIndex]!;
    const snapshot: BacklogItem = { ...item };
    const nextSourceKind = params.sourceKind ?? item.sourceKind;
    const nextFlowType = params.flowType ?? item.flowType;
    if (!VALID_SOURCE_KINDS.has(nextSourceKind)) throw new Error('Invalid backlog source kind');
    try {
      if (params.title !== undefined) {
        if (!params.title.trim()) throw new Error('Backlog item title is required');
        item.title = params.title.trim();
      }
      if (
        params.sourceKind !== undefined ||
        params.sourceRef !== undefined ||
        params.flowType !== undefined
      ) {
        item.sourceKind = nextSourceKind;
        item.flowType = nextFlowType;
        item.sourceRef = await normalizeSourceFields(
          nextSourceKind,
          params.sourceRef ?? item.sourceRef,
          nextFlowType,
          item.project,
        );
      }
      if (params.sourceUrl !== undefined) {
        if (params.sourceUrl === null || !params.sourceUrl.trim()) delete item.sourceUrl;
        else item.sourceUrl = params.sourceUrl.trim();
      }
      if (params.notes !== undefined) {
        if (params.notes === null) delete item.notes;
        else item.notes = params.notes;
      }
      if (params.tags !== undefined) {
        const tags = params.tags === null ? [] : normalizeRunTags(params.tags);
        if (tags.length === 0) delete item.tags;
        else item.tags = tags;
      }
      if (params.roadmapItemId !== undefined) {
        const roadmapItemId =
          params.roadmapItemId === null ? undefined : normalizeOptionalString(params.roadmapItemId);
        if (!roadmapItemId) delete item.roadmapItemId;
        else item.roadmapItemId = roadmapItemId;
      }
      if (params.specPath !== undefined) {
        const specPath =
          params.specPath === null ? undefined : normalizeOptionalSpecPath(params.specPath);
        if (!specPath) delete item.specPath;
        else item.specPath = specPath;
      }
      if (params.priority !== undefined) item.priority = params.priority;
      if (params.allowedSlots !== undefined) {
        if (params.allowedSlots === null) delete item.allowedSlots;
        else item.allowedSlots = normalizeAllowedSlots(params.allowedSlots);
      }
      if (params.autoDispatch !== undefined) item.autoDispatch = params.autoDispatch;
      if (params.runner !== undefined) {
        const runner = params.runner === null ? undefined : normalizeRunnerHint(params.runner);
        if (runner) item.runner = runner;
        else delete item.runner;
      }
      if (params.model !== undefined) {
        const model =
          params.model === null ? undefined : normalizeExecutionHint(params.model, 'model');
        if (model) item.model = model;
        else delete item.model;
      }
      if (params.scripted !== undefined) {
        if (params.scripted === null) delete item.scripted;
        else item.scripted = params.scripted;
      }
      if (params.effort !== undefined) {
        const effort =
          params.effort === null ? undefined : normalizeExecutionHint(params.effort, 'effort');
        if (effort) item.effort = effort;
        else delete item.effort;
      }
      if (params.taskTemplate !== undefined) {
        const taskTemplate =
          params.taskTemplate === null
            ? undefined
            : normalizeBacklogTaskTemplate(item.flowType, params.taskTemplate);
        if (taskTemplate) item.taskTemplate = taskTemplate;
        else delete item.taskTemplate;
      } else if (item.taskTemplate) {
        item.taskTemplate = normalizeBacklogTaskTemplate(item.flowType, item.taskTemplate);
      }
      if (params.app !== undefined) {
        const app = params.app === null ? undefined : normalizeOptionalString(params.app);
        if (app) item.app = app;
        else delete item.app;
      }
      if (params.prepareProfile !== undefined) {
        const prepareProfile =
          params.prepareProfile === null
            ? undefined
            : normalizeOptionalString(params.prepareProfile);
        if (prepareProfile) item.prepareProfile = prepareProfile;
        else delete item.prepareProfile;
      }
      if (params.mode !== undefined) {
        const mode = params.mode === null ? undefined : normalizeDispatchMode(params.mode);
        if (mode) item.mode = mode;
        else delete item.mode;
      }
      if (params.devInteractiveProfile !== undefined) {
        const devInteractiveProfile =
          params.devInteractiveProfile === null
            ? undefined
            : normalizeDevInteractiveProfile(params.devInteractiveProfile);
        if (devInteractiveProfile) item.devInteractiveProfile = devInteractiveProfile;
        else delete item.devInteractiveProfile;
      }
      if (params.reviewDepth !== undefined) {
        const reviewDepth =
          params.reviewDepth === null ? undefined : normalizeReviewDepth(params.reviewDepth);
        if (reviewDepth) item.reviewDepth = reviewDepth;
        else delete item.reviewDepth;
      }
      if (params.pendingReviewPlan !== undefined) {
        const pendingReviewPlan =
          params.pendingReviewPlan === null
            ? undefined
            : normalizePendingReviewPlan(params.pendingReviewPlan);
        if (pendingReviewPlan) item.pendingReviewPlan = pendingReviewPlan;
        else delete item.pendingReviewPlan;
      }
      if (params.launchPlan !== undefined) {
        if (params.launchPlan === null) {
          delete item.launchPlan;
          delete item.launchPlanState;
        } else {
          item.launchPlan = normalizeLaunchPlan(params.launchPlan);
          delete item.launchPlanState;
        }
      }
      assertExecutionHintsCompatible(item);
      if (item.status === 'ready') await assertBacklogSpecReady(item);
      item.updatedAt = new Date().toISOString();
    } catch (err) {
      items[itemIndex] = snapshot;
      throw err;
    }
    schedulePersist('update');
    broadcastBacklog();
    return { item };
  });
}

export async function deleteBacklogItem(itemId: string): Promise<OkResult> {
  return withBacklogMutation(async () => {
    const idx = items.findIndex((candidate) => candidate.id === itemId);
    if (idx < 0) throw new Error(`Backlog item not found: ${itemId}`);
    const item = items[idx];
    const hasQueueLink = getQueueSnapshot().some((queueItem) => queueItem.backlogItemId === itemId);
    const runs = getAllRuns();
    const runById = new Map(runs.map((run) => [run.id, run]));
    const linkedRun = item.runId ? runById.get(item.runId) : undefined;
    const hasActiveItemRunLink = Boolean(
      item.runId && (!linkedRun || !isTerminalRunStatus(linkedRun.status)),
    );
    const hasActiveRunLink = runs.some(
      (run) => run.backlogItemId === itemId && !isTerminalRunStatus(run.status),
    );
    if (item.workGraphId || item.workNodeId) {
      throw new Error('Cannot delete backlog item linked to a work graph');
    }
    if (hasQueueLink || hasActiveItemRunLink || hasActiveRunLink) {
      throw new Error('Cannot delete backlog item linked to active queue/run');
    }
    items.splice(idx, 1);
    schedulePersist('delete');
    broadcastBacklog();
    return { ok: true };
  });
}

export async function markBacklogItemReady(
  params: BacklogMarkReadyParams,
): Promise<{ item: BacklogItem }> {
  return withBacklogMutation(async () => {
    const item = getItem(params.itemId);
    await normalizeSourceFields(item.sourceKind, item.sourceRef, item.flowType, item.project);
    await assertBacklogSpecReady(item);
    item.status = 'ready';
    item.updatedAt = new Date().toISOString();
    delete item.runId;
    delete item.lastObservedRunStatus;
    delete item.lastDispatchError;
    schedulePersist('mark-ready');
    broadcastBacklog();
    return { item };
  });
}

export async function archiveBacklogItem(params: {
  itemId: string;
}): Promise<{ item: BacklogItem }> {
  return withBacklogMutation(async () => {
    const item = getItem(params.itemId);
    if (!ARCHIVABLE_BACKLOG_STATUSES.has(item.status)) {
      throw new Error(`Cannot archive backlog item in status ${item.status}`);
    }
    item.status = 'archived';
    delete item.queuedQueueItemId;
    item.updatedAt = new Date().toISOString();
    schedulePersist('archive');
    broadcastBacklog();
    return { item };
  });
}

export async function getBacklogSpec(params: BacklogSpecGetParams): Promise<BacklogSpecGetResult> {
  const item = getItem(params.itemId);
  if (!item.specPath) throw new Error(`Backlog item has no attached spec: ${params.itemId}`);
  const absolute = resolveSpecPath(item.specPath);
  const content = await readFile(absolute, 'utf-8');
  return {
    itemId: item.id,
    path: item.specPath,
    content,
    hash: createHash('sha256').update(content).digest('hex'),
  };
}

export async function markBacklogItemNeedsAttention(params: {
  itemId: string;
  reason: string;
  clearQueueLink?: boolean;
}): Promise<{ item: BacklogItem }> {
  return withBacklogMutation(async () => {
    const item = getItem(params.itemId);
    item.status = 'needs-attention';
    item.lastDispatchError = params.reason;
    if (params.clearQueueLink) delete item.queuedQueueItemId;
    item.updatedAt = new Date().toISOString();
    await persistNow('work-graph-needs-attention');
    broadcastBacklog();
    return { item };
  });
}

function launchCandidateKey(
  backlogItemId: string,
  launchPlanId: string,
  candidateId: string,
): string {
  return JSON.stringify([backlogItemId, launchPlanId, candidateId]);
}

async function materializeMissingComparisonCandidates(
  item: BacklogItem,
  baselineRun: Run,
): Promise<boolean> {
  if (!item.launchPlan) return false;
  let changed = false;
  for (const comparison of item.launchPlan.candidates.filter(
    (candidate) => candidate.role === 'comparison',
  )) {
    const existingProjection = projectionForCandidate(item, comparison.id);
    if (existingProjection?.queueItemId || existingProjection?.runId) continue;
    const comparisonQueueItem = addItem(
      await buildBacklogQueueParams(
        item,
        { workGraphId: item.workGraphId, workNodeId: item.workNodeId },
        comparison,
        baselineRun,
      ),
    );
    if (existingProjection) {
      existingProjection.status = 'queued';
      existingProjection.queueItemId = comparisonQueueItem.id;
      changed = true;
    }
    await persistQueueNow();
  }
  return changed;
}

async function buildInitialContext(item: BacklogItem): Promise<string> {
  const specMarkdown = await readBacklogSpecMarkdown(item);
  return [
    specMarkdown?.trim() ? `Backlog markdown spec (${item.specPath}):\n${specMarkdown.trim()}` : '',
    item.notes?.trim() ? `Backlog notes:\n${item.notes.trim()}` : '',
    `Backlog source: ${item.sourceKind} ${item.sourceRef}`,
  ]
    .filter(Boolean)
    .join('\n\n');
}

async function buildManualTicketData(
  item: BacklogItem,
): Promise<QueueItem['ticketData'] | undefined> {
  if (item.sourceKind !== 'manual') return undefined;
  const specMarkdown = await readBacklogSpecMarkdown(item);
  const acceptanceCriteria = specMarkdown ? extractBacklogAcceptanceCriteria(specMarkdown) : [];
  return {
    source: 'manual',
    title: item.title,
    description: specMarkdown?.trim() || item.notes?.trim() || item.title,
    acceptanceCriteria,
    affectedArea: '',
    stepsToReproduce: [],
    screenshots: [],
    labels: normalizeRunTags(['backlog', ...(item.tags ?? [])]),
    comments: [],
    linkedTickets: [],
  };
}

async function resolveBacklogTaskTemplate(
  item: BacklogItem,
): Promise<TaskTemplateSelection | undefined> {
  if (!item.taskTemplate) return undefined;
  const projectVars = await loadProjectVars(item.project);
  const selectedTemplate = await resolveWorkerTemplateSelection(
    projectVars,
    item.flowType,
    item.taskTemplate,
  );
  return {
    fileName: selectedTemplate.fileName,
    variant: selectedTemplate.variant,
  };
}

function queueFieldsForSlotPolicy(policy: BacklogLaunchSlotPolicy): {
  slotId?: string;
  allowedSlots?: string[];
} {
  if (policy.kind === 'exact') return { slotId: policy.slotId, allowedSlots: [policy.slotId] };
  if (policy.kind === 'pool') return { allowedSlots: policy.allowedSlots };
  return policy.allowedSlots ? { allowedSlots: policy.allowedSlots } : {};
}

async function buildBacklogQueueParams(
  item: BacklogItem,
  options: { workGraphId?: string; workNodeId?: string },
  candidate?: BacklogLaunchCandidate,
  baselineRun?: Run,
): Promise<InternalDispatchQueueAddParams> {
  const slotFields = candidate ? queueFieldsForSlotPolicy(candidate.slotPolicy) : {};
  const isComparison = candidate?.role === 'comparison';
  const taskTemplate = candidate ? undefined : await resolveBacklogTaskTemplate(item);
  return {
    backlogItemId: item.id,
    workGraphId: options.workGraphId,
    workNodeId: options.workNodeId,
    launchPlanId: item.launchPlan?.id,
    launchCandidateId: candidate?.id,
    launchGroupId: item.launchPlanState?.launchGroupId,
    launchSlotPolicy: candidate?.slotPolicy.kind,
    label: candidate
      ? `Backlog: ${item.title} — ${candidate.label ?? candidate.id}`
      : `Backlog: ${item.title}`,
    flowType: item.flowType,
    project: item.project,
    ticketOrPr: item.sourceRef,
    familyId: isComparison ? (baselineRun?.familyId ?? baselineRun?.id) : undefined,
    parentRunId: isComparison ? baselineRun?.id : undefined,
    familyRootTicketOrPr: isComparison ? item.sourceRef : undefined,
    lane: isComparison ? 'comparison' : undefined,
    variant: isComparison ? candidate.variant?.trim() : undefined,
    priority: item.priority,
    tags: item.tags,
    initialContext: await buildInitialContext(item),
    ticketData: await buildManualTicketData(item),
    allowedSlots: candidate ? slotFields.allowedSlots : item.allowedSlots,
    slotId: slotFields.slotId,
    runner: candidate?.runner ?? item.runner,
    model: candidate?.model ?? item.model,
    scripted: item.scripted,
    effort: candidate?.effort ?? item.effort,
    taskTemplate,
    app: item.app,
    prepareProfile: item.prepareProfile,
    mode: item.mode,
    devInteractiveProfile: item.devInteractiveProfile,
    reviewDepth: item.reviewDepth,
    pendingReviewPlan: item.pendingReviewPlan,
    // Backlog handoff persists queue+backlog links before dispatch can consume the queue item.
    autoDispatch: false,
  };
}

async function assertAutoDispatchEligible(item: BacklogItem): Promise<void> {
  if (!item.autoDispatch) throw new Error('item autoDispatch is disabled');
  const projectConfig = await loadProjectConfig(item.project);
  if (!projectConfig?.backlog?.autoDispatch?.enabled) {
    throw new Error('project backlog auto-dispatch is disabled');
  }
  if (!item.allowedSlots || item.allowedSlots.length === 0) {
    throw new Error('auto-dispatch requires explicit allowedSlots');
  }
  await assertAllowedSlotsBelongToProject(item);
}

export async function enqueueBacklogItem(
  params: {
    itemId: string;
    auto?: boolean;
  },
  options: { workGraphId?: string; workNodeId?: string } = {},
): Promise<BacklogEnqueueResult> {
  return withBacklogMutation(async () => {
    const item = getItem(params.itemId);
    if (item.status !== 'ready')
      throw new Error(`Cannot enqueue backlog item in status ${item.status}`);
    if (
      item.workGraphId &&
      (item.workGraphId !== options.workGraphId || item.workNodeId !== options.workNodeId)
    ) {
      throw new Error(GRAPH_ENQUEUE_ERROR);
    }
    if (item.queuedQueueItemId || item.runId)
      throw new Error('Backlog item is already linked to queue/run');
    const attemptedAt = new Date().toISOString();
    item.lastDispatchAttempt = attemptedAt;
    try {
      await assertAllowedSlotsBelongToProject(item);
      if (params.auto) await assertAutoDispatchEligible(item);
      item.sourceRef = await normalizeSourceFields(
        item.sourceKind,
        item.sourceRef,
        item.flowType,
        item.project,
      );
      await assertBacklogSpecReady(item);
      if (item.status !== 'ready' || item.queuedQueueItemId || item.runId) {
        throw new Error('Backlog item changed while enqueue validation was running');
      }
      for (const stale of getQueueSnapshot().filter(
        (queueItem) => queueItem.backlogItemId === item.id && queueItem.status === 'cancelled',
      )) {
        removeQueueItemInternal(stale.id, 'backlog-enqueue-purge-cancelled');
      }
      const baselineCandidate = item.launchPlan ? launchCandidateByRole(item, 'baseline') : null;
      if (item.launchPlan) ensureLaunchPlanState(item);
      const existingQueueItem = getQueueSnapshot().find(
        (queueItem) =>
          (baselineCandidate
            ? queueItem.backlogItemId === item.id &&
              queueItem.launchPlanId === item.launchPlan?.id &&
              queueItem.launchCandidateId === baselineCandidate.id
            : queueItem.backlogItemId === item.id) &&
          (queueItem.status === 'queued' || queueItem.status === 'dispatching'),
      );
      if (existingQueueItem) {
        item.status = 'queued';
        item.queuedQueueItemId = existingQueueItem.id;
        if (baselineCandidate) {
          const projection = projectionForCandidate(item, baselineCandidate.id);
          if (projection) {
            projection.status = 'queued';
            projection.queueItemId = existingQueueItem.id;
          }
          item.launchPlanState!.baselineQueueItemId = existingQueueItem.id;
        }
        delete item.lastDispatchError;
        item.updatedAt = new Date().toISOString();
        await persistNow('enqueue-existing');
        broadcastBacklog();
        return { item, queueItem: existingQueueItem };
      }
      const queueParams = await buildBacklogQueueParams(
        item,
        options,
        baselineCandidate ?? undefined,
      );
      const queueItem = addItem(queueParams);
      await persistQueueNow();
      item.status = 'queued';
      item.queuedQueueItemId = queueItem.id;
      if (baselineCandidate) {
        const projection = projectionForCandidate(item, baselineCandidate.id);
        if (projection) {
          projection.status = 'queued';
          projection.queueItemId = queueItem.id;
        }
        item.launchPlanState!.baselineQueueItemId = queueItem.id;
      }
      delete item.lastDispatchError;
      item.updatedAt = new Date().toISOString();
      await persistNow('enqueue');
      broadcastBacklog();
      tryDispatchNext().catch((err) => {
        console.error(`[backlog] queued item auto-dispatch failed: ${(err as Error).message}`);
      });
      return { item, queueItem };
    } catch (err) {
      item.lastDispatchError = (err as Error).message;
      item.updatedAt = new Date().toISOString();
      await persistNow('enqueue-failed');
      broadcastBacklog();
      throw err;
    }
  });
}

export async function dequeueBacklogItem(params: {
  itemId: string;
}): Promise<{ item: BacklogItem }> {
  return withBacklogMutation(async () => {
    const item = getItem(params.itemId);
    if (item.workGraphId || item.workNodeId) {
      throw new Error(
        'Backlog item is linked to a work graph; use work graph controls to cancel queued work',
      );
    }
    if (item.status !== 'queued' && item.status !== 'dispatching') {
      throw new Error(`Cannot dequeue backlog item in status ${item.status}`);
    }
    const linkedRun = item.runId ? getAllRuns().find((run) => run.id === item.runId) : undefined;
    if (linkedRun && !isTerminalRunStatus(linkedRun.status)) {
      throw new Error(`Cannot dequeue backlog item with active run ${linkedRun.id}`);
    }
    const linkedQueueItems = getQueueSnapshot().filter(
      (queueItem) => queueItem.backlogItemId === item.id,
    );
    if (linkedQueueItems.some((queueItem) => queueItem.status === 'dispatching')) {
      throw new Error('Cannot dequeue backlog item while dispatch is in progress');
    }
    for (const queueItem of linkedQueueItems.filter(
      (candidate) => candidate.status === 'queued' || candidate.status === 'cancelled',
    )) {
      removeQueueItemInternal(queueItem.id, 'backlog-dequeue');
    }
    if (item.launchPlan && item.launchPlanState) {
      for (const projection of item.launchPlanState.candidates) {
        if (projection.status === 'queued') projection.status = 'planned';
        delete projection.queueItemId;
      }
      delete item.launchPlanState.baselineQueueItemId;
    }
    delete item.queuedQueueItemId;
    delete item.runId;
    delete item.lastObservedRunStatus;
    item.status = 'ready';
    delete item.lastDispatchError;
    item.updatedAt = new Date().toISOString();
    await persistQueueNow();
    schedulePersist('dequeue');
    broadcastBacklog();
    return { item };
  });
}

function block(item: BacklogItem, reason: string): BacklogBlockedItem {
  return { item, reason };
}

async function blockedReasonForReadyItem(item: BacklogItem): Promise<string | null> {
  try {
    if (item.status !== 'ready') return `status is ${item.status}`;
    if (item.queuedQueueItemId || item.runId) return 'already linked to queue/run';
    if (item.workGraphId) return GRAPH_ENQUEUE_ERROR;
    await assertAutoDispatchEligible(item);
    await normalizeSourceFields(item.sourceKind, item.sourceRef, item.flowType, item.project);
    await assertBacklogSpecReady(item);
    return null;
  } catch (err) {
    return (err as Error).message;
  }
}

export async function autoDispatchBacklogReady(
  params: BacklogAutoDispatchTickParams = {},
): Promise<BacklogAutoDispatchTickResult> {
  const tickKey = params.project ?? '*';
  const overlapsGlobal = tickKey === '*' && autoDispatchTickInFlight.size > 0;
  const overlapsProject = tickKey !== '*' && autoDispatchTickInFlight.has('*');
  if (overlapsGlobal || overlapsProject || autoDispatchTickInFlight.has(tickKey)) {
    return { enqueued: [], blocked: [] };
  }
  autoDispatchTickInFlight.add(tickKey);
  const enqueued: BacklogEnqueueResult[] = [];
  const blocked: BacklogBlockedItem[] = [];
  try {
    const candidates = sortedBacklog(
      items.filter(
        (item) =>
          item.status === 'ready' &&
          !item.workGraphId &&
          (!params.project || item.project === params.project),
      ),
    );
    for (const item of candidates) {
      const reason = await blockedReasonForReadyItem(item);
      if (reason) {
        blocked.push(block(item, reason));
        continue;
      }
      try {
        enqueued.push(await enqueueBacklogItem({ itemId: item.id, auto: true }));
      } catch (err) {
        blocked.push(block(item, (err as Error).message));
      }
    }
    return { enqueued, blocked };
  } finally {
    autoDispatchTickInFlight.delete(tickKey);
  }
}

export async function upcomingBacklogItems(
  params: BacklogUpcomingParams = {},
): Promise<BacklogUpcomingResult> {
  const ready = sortedBacklog(
    items.filter(
      (item) =>
        item.status === 'ready' &&
        !item.workGraphId &&
        (!params.project || item.project === params.project),
    ),
  );
  const limited = ready.slice(0, params.limit ?? ready.length);
  const blocked: BacklogBlockedItem[] = [];
  const eligible: BacklogItem[] = [];
  for (const item of limited) {
    const reason = await blockedReasonForReadyItem(item);
    if (reason) blocked.push(block(item, reason));
    else eligible.push(item);
  }
  return { ready: eligible, blocked };
}

export async function markBacklogRunStarted(queueItem: QueueItem, run: Run): Promise<void> {
  const backlogItemId = queueItem.backlogItemId;
  if (!backlogItemId) return;
  await withBacklogMutation(async () => {
    const item = items.find((candidate) => candidate.id === backlogItemId);
    if (!item) return;
    if (TERMINAL_STATUSES.has(item.status)) return;
    if (item.launchPlan && queueItem.launchCandidateId) {
      ensureLaunchPlanState(item);
      item.launchPlanState!.launchGroupId =
        queueItem.launchGroupId ?? item.launchPlanState!.launchGroupId;
      const projection = projectionForCandidate(item, queueItem.launchCandidateId);
      if (projection) {
        projection.status = 'running';
        projection.runId = run.id;
        projection.slotId = run.slotId ?? queueItem.slotId;
        delete projection.queueItemId;
      }
      if (queueItem.launchCandidateId === launchCandidateByRole(item, 'baseline')?.id) {
        item.runId = run.id;
        item.lastObservedRunStatus = run.status;
        item.launchPlanState!.baselineRunId = run.id;
        delete item.queuedQueueItemId;
        await materializeMissingComparisonCandidates(item, run);
      }
      rollUpLaunchPlanStatus(item);
      item.updatedAt = new Date().toISOString();
      schedulePersist('launch-run-started');
      broadcastBacklog();
      return;
    }
    item.status = 'running';
    item.runId = run.id;
    item.lastObservedRunStatus = 'monitoring';
    delete item.queuedQueueItemId;
    item.updatedAt = new Date().toISOString();
    schedulePersist('run-started');
    broadcastBacklog();
  });
}

export function isValidManualBacklogRunHandoff(
  backlogItemId: string | undefined,
  ticketOrPr: string,
  project: string,
): boolean {
  const normalizedRef = normalizeManualRef(ticketOrPr);
  if (!backlogItemId || !MANUAL_REF_RE.test(normalizedRef)) return false;
  const item = items.find((candidate) => candidate.id === backlogItemId);
  return Boolean(
    item &&
    item.sourceKind === 'manual' &&
    item.sourceRef === normalizedRef &&
    item.project === project &&
    HANDOFF_ACTIVE_STATUSES.has(item.status),
  );
}

export function markBacklogRunObserved(run: Run): void {
  withBacklogMutation(async () => {
    const item =
      items.find((candidate) => candidate.runId === run.id) ??
      (run.backlogItemId
        ? items.find((candidate) => candidate.id === run.backlogItemId)
        : undefined);
    if (!item) return;
    if (!shouldApplyLinkedRunObservation(item, run)) return;
    if (applyRunObservation(item, run)) {
      schedulePersist('run-observed');
      broadcastBacklog();
    }
  }).catch((err) => {
    console.error(`[backlog] failed to observe run: ${(err as Error).message}`);
  });
}

export async function markBacklogRunDeleted(runId: string): Promise<string[]> {
  return withBacklogMutation(async () => {
    let changed = false;
    const graphIds = new Set<string>();
    for (const item of items) {
      if (!releaseBacklogRunLink(item, runId)) continue;
      changed = true;
      if (item.workGraphId) graphIds.add(item.workGraphId);
    }
    if (changed) {
      schedulePersist('run-deleted');
      broadcastBacklog();
    }
    return [...graphIds];
  });
}
