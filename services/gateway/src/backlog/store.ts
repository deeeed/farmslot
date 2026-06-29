// backlog-store.ts — durable backlog intake layer with handoff into dispatch queue

import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  type BacklogAutoDispatchTickParams,
  type BacklogAutoDispatchTickResult,
  type BacklogBlockedItem,
  type BacklogCreateParams,
  type BacklogEnqueueResult,
  type BacklogItem,
  type BacklogListParams,
  type BacklogListResult,
  type BacklogMarkReadyParams,
  type BacklogSourceKind,
  type BacklogStatus,
  type BacklogUpcomingParams,
  type BacklogUpcomingResult,
  type BacklogUpdateParams,
  type BacklogUpdateResult,
  Events,
  isTerminalRunStatus,
  normalizeRunTags,
  type OkResult,
  parseGitHubRef,
  PR_BOUND_FLOW_TYPES,
  type QueueItem,
  type Run,
  type RunStatus,
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
import { getAllRuns } from '../runs/store.js';

import { addItem, getQueueSnapshot, persistQueueNow, tryDispatchNext } from './dispatch-queue.js';

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
]);

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
  return {
    id,
    project,
    title,
    sourceKind: sourceKind as BacklogSourceKind,
    sourceRef,
    ...(typeof raw.sourceUrl === 'string' && raw.sourceUrl ? { sourceUrl: raw.sourceUrl } : {}),
    flowType: flowType as BacklogItem['flowType'],
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

function applyRunObservation(item: BacklogItem, run: Run): boolean {
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

function reconcileBacklogLinks(): boolean {
  let changed = false;
  const queueItems = getQueueSnapshot();
  const queueByBacklogId = new Map<string, QueueItem>();
  for (const queueItem of queueItems) {
    if (queueItem.backlogItemId) queueByBacklogId.set(queueItem.backlogItemId, queueItem);
  }
  const runsById = new Map(getAllRuns().map((run) => [run.id, run]));

  for (const item of items) {
    if (item.runId) {
      const run = runsById.get(item.runId);
      if (run) {
        if (!TERMINAL_STATUSES.has(item.status) && applyRunObservation(item, run)) changed = true;
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
    if (reconcileBacklogLinks()) schedulePersist('load-reconcile');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return;
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

async function assertAllowedSlotsBelongToProject(item: BacklogItem): Promise<void> {
  if (!item.allowedSlots || item.allowedSlots.length === 0) return;
  const fleet = await loadFleetStatus();
  for (const slotId of item.allowedSlots) {
    const slot = fleet.slots.find((candidate) => candidate.slot === slotId);
    if (!slot) throw new Error(`allowed slot not found: ${slotId}`);
    if (slot.project !== item.project) {
      throw new Error(
        `allowed slot ${slotId} belongs to project ${slot.project}, not ${item.project}`,
      );
    }
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
      createdAt: now,
      updatedAt: now,
    };
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
      }
    : null;
}

export function listBacklogItemSnapshots(): BacklogItem[] {
  return items.map((item) => ({
    ...item,
    tags: item.tags ? [...item.tags] : undefined,
    allowedSlots: item.allowedSlots ? [...item.allowedSlots] : undefined,
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
    delete item.lastDispatchError;
    schedulePersist('mark-ready');
    broadcastBacklog();
    return { item };
  });
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
      const existingQueueItem = getQueueSnapshot().find(
        (queueItem) => queueItem.backlogItemId === item.id,
      );
      if (existingQueueItem) {
        item.status = 'queued';
        item.queuedQueueItemId = existingQueueItem.id;
        delete item.lastDispatchError;
        item.updatedAt = new Date().toISOString();
        await persistNow('enqueue-existing');
        broadcastBacklog();
        return { item, queueItem: existingQueueItem };
      }
      const queueParams: InternalDispatchQueueAddParams = {
        backlogItemId: item.id,
        workGraphId: options.workGraphId,
        workNodeId: options.workNodeId,
        label: `Backlog: ${item.title}`,
        flowType: item.flowType,
        project: item.project,
        ticketOrPr: item.sourceRef,
        priority: item.priority,
        tags: item.tags,
        initialContext: await buildInitialContext(item),
        ticketData: await buildManualTicketData(item),
        allowedSlots: item.allowedSlots,
        // Backlog handoff persists queue+backlog links before dispatch can consume the queue item.
        autoDispatch: false,
      };
      const queueItem = addItem(queueParams);
      await persistQueueNow();
      item.status = 'queued';
      item.queuedQueueItemId = queueItem.id;
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

export async function markBacklogRunStarted(
  backlogItemId: string | undefined,
  runId: string,
): Promise<void> {
  if (!backlogItemId) return;
  await withBacklogMutation(async () => {
    const item = items.find((candidate) => candidate.id === backlogItemId);
    if (!item) return;
    if (TERMINAL_STATUSES.has(item.status)) return;
    item.status = 'running';
    item.runId = runId;
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
    if (TERMINAL_STATUSES.has(item.status) && item.runId === run.id) return;
    if (applyRunObservation(item, run)) {
      schedulePersist('run-observed');
      broadcastBacklog();
    }
  }).catch((err) => {
    console.error(`[backlog] failed to observe run: ${(err as Error).message}`);
  });
}
