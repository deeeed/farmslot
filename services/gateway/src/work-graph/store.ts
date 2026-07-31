import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  Events,
  isTerminalRunStatus,
  normalizeRunTags,
  type Run,
  type WorkEdge,
  type WorkGraph,
  type WorkGraphActionLedgerEntry,
  type WorkGraphAddEdgeParams,
  type WorkGraphAddNodeParams,
  type WorkGraphCreateParams,
  type WorkGraphListRpcParams,
  type WorkGraphProjection,
  type WorkGraphSnapshot,
  type WorkGraphUpdateNodeParams,
  type WorkNode,
  type WorkNodeReference,
  type WorkReferenceStatus,
} from '@farmslot/protocol';

import {
  cancelGraphQueuedItem,
  getQueueSnapshot,
  persistQueueNow,
  removeQueueItemInternal,
} from '../backlog/dispatch-queue.js';
import {
  assertBacklogItemAttachedToWorkNode,
  attachBacklogItemToWorkNode,
  detachBacklogItemFromWorkNode,
  enqueueBacklogItem,
  getBacklogItemSnapshot,
  markBacklogItemNeedsAttention,
  markBacklogItemReady,
} from '../backlog/store.js';
import { farmslotRoot } from '../fleet/state.js';
import { getAllRuns } from '../runs/store.js';

type BroadcastFn = (event: string, payload: unknown) => void;

const LEASE_MS = 30_000;
const graphs = new Map<string, WorkGraphSnapshot>();
let persistChain: Promise<void> = Promise.resolve();
let mutationTail: Promise<void> = Promise.resolve();
let broadcast: BroadcastFn | null = null;

function shouldUseIsolatedGraphDir(env: NodeJS.ProcessEnv, argv: readonly string[]): boolean {
  if (env.FARMSLOT_TEST_TMP === '1' || env.NODE_TEST_CONTEXT) return true;
  return argv.some((arg) => /(?:^|[/\\])[^/\\]+\.test\.(?:ts|tsx|js|mjs|cjs)$/.test(arg));
}

function resolveGraphDir(): string {
  if (process.env.FARMSLOT_WORK_GRAPH_DIR) return process.env.FARMSLOT_WORK_GRAPH_DIR;
  if (shouldUseIsolatedGraphDir(process.env, process.argv)) {
    return path.join(os.tmpdir(), `farmslot-test-work-graphs-${process.pid}`);
  }
  return path.join(farmslotRoot, '.work-graphs');
}

const GRAPH_DIR = resolveGraphDir();
const SAFE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

export function initWorkGraphStore(fn: BroadcastFn): void {
  broadcast = fn;
}

async function withMutation<T>(operation: () => Promise<T>): Promise<T> {
  const previous = mutationTail;
  let release!: () => void;
  mutationTail = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    return await operation();
  } finally {
    release();
  }
}

async function ensureDir(): Promise<void> {
  await mkdir(GRAPH_DIR, { recursive: true });
}

function graphFile(graphId: string): string {
  if (!isSafeId(graphId)) throw new Error(`Invalid work graph id: ${graphId}`);
  const file = path.resolve(GRAPH_DIR, `${graphId}.json`);
  const graphDir = path.resolve(GRAPH_DIR);
  if (!file.startsWith(`${graphDir}${path.sep}`))
    throw new Error(`Invalid work graph path for id: ${graphId}`);
  return file;
}

async function persistSnapshot(snapshot: WorkGraphSnapshot): Promise<void> {
  await ensureDir();
  const file = graphFile(snapshot.graph.id);
  const tmp = `${file}.tmp.${process.pid}.${randomUUID().slice(0, 8)}`;
  await writeFile(tmp, JSON.stringify(snapshot, null, 2), 'utf-8');
  await rename(tmp, file);
}

function enqueuePersist(snapshot: WorkGraphSnapshot): Promise<void> {
  persistChain = persistChain.catch(() => undefined).then(() => persistSnapshot(snapshot));
  return persistChain;
}

async function persistNow(snapshot: WorkGraphSnapshot): Promise<void> {
  await enqueuePersist(snapshot);
}

function emit(snapshot: WorkGraphSnapshot): void {
  broadcast?.(Events.WORK_GRAPH_UPDATED, { graph: project(snapshot) });
}

function project(snapshot: WorkGraphSnapshot): WorkGraphProjection {
  return {
    graph: { ...snapshot.graph, tags: snapshot.graph.tags ? [...snapshot.graph.tags] : undefined },
    nodes: snapshot.nodes.map((node) => ({
      ...node,
      reference: node.reference ? cloneReference(node.reference) : undefined,
      tags: node.tags ? [...node.tags] : undefined,
      waitingOn: node.waitingOn.map((reason) => ({ ...reason })),
      supersededFamilyIds: node.supersededFamilyIds ? [...node.supersededFamilyIds] : undefined,
      upstreamBaseNodeIds: node.upstreamBaseNodeIds ? [...node.upstreamBaseNodeIds] : undefined,
    })),
    edges: snapshot.edges.map((edge) => ({
      ...edge,
      evidence: edge.evidence ? { ...edge.evidence } : undefined,
    })),
    gates: snapshot.gates.map((gate) => ({ ...gate })),
    ledger: snapshot.ledger.map((entry) => ({ ...entry })),
  };
}

function cloneReference(reference: WorkNodeReference): WorkNodeReference {
  return {
    ...reference,
    labels: reference.labels ? [...reference.labels] : undefined,
  };
}

function isSafeId(input: string): boolean {
  return SAFE_ID_RE.test(input);
}

function normalizeId(prefix: string, input: string | undefined, title = ''): string {
  const explicit = input?.trim();
  if (explicit) {
    if (!isSafeId(explicit)) {
      throw new Error(
        `Invalid identifier ${explicit}; use letters, numbers, underscores, or dashes`,
      );
    }
    return explicit;
  }
  const slugBase = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const slug = slugBase.slice(0, 40);
  const suffix =
    slugBase.length > 40 ? `-${createHash('sha1').update(slugBase).digest('hex').slice(0, 8)}` : '';
  return `${prefix}_${slug || randomUUID().slice(0, 8)}${suffix}`;
}

function requireGraph(graphId: string): WorkGraphSnapshot {
  const snapshot = graphs.get(graphId);
  if (!snapshot) throw new Error(`Work graph not found: ${graphId}`);
  return snapshot;
}

function normalizeStoredSnapshot(raw: unknown): WorkGraphSnapshot | null {
  if (!raw || typeof raw !== 'object') return null;
  const snapshot = raw as WorkGraphSnapshot;
  if (!snapshot.graph?.id || snapshot.graph.version !== 1) return null;
  if (!isSafeId(snapshot.graph.id)) return null;
  if (!Array.isArray(snapshot.nodes) || !Array.isArray(snapshot.edges)) return null;
  return {
    graph: {
      ...snapshot.graph,
      tags: normalizeRunTags(snapshot.graph.tags),
      scheduler: snapshot.graph.scheduler ?? {},
      defaultFailurePolicy: snapshot.graph.defaultFailurePolicy ?? 'halt',
    },
    nodes: snapshot.nodes.map((node) => ({
      ...node,
      kind: node.kind ?? 'backlog',
      reference: node.reference ? cloneReference(node.reference) : undefined,
      waitingOn: node.waitingOn ?? [],
    })),
    edges: snapshot.edges.map((edge) => ({
      ...edge,
      required: edge.required !== false,
      blocks: edge.blocks ?? 'start',
      status: edge.status ?? 'pending',
      unlock: edge.unlock ?? { kind: 'enqueue' },
    })),
    gates: Array.isArray(snapshot.gates) ? snapshot.gates : [],
    ledger: Array.isArray(snapshot.ledger) ? snapshot.ledger : [],
  };
}

export async function loadWorkGraphs(): Promise<void> {
  graphs.clear();
  await ensureDir();
  let files: string[];
  try {
    files = await readdir(GRAPH_DIR);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }
  for (const file of files) {
    if (!file.endsWith('.json') || file.includes('.tmp.')) continue;
    const parsed: unknown = JSON.parse(await readFile(path.join(GRAPH_DIR, file), 'utf-8'));
    const snapshot = normalizeStoredSnapshot(parsed);
    if (snapshot) graphs.set(snapshot.graph.id, snapshot);
  }
}

function wouldCreateCycle(nodes: readonly WorkNode[], edges: readonly WorkEdge[]): string[] {
  const nodeIds = new Set(nodes.map((node) => node.id));
  const adjacency = new Map<string, string[]>();
  for (const node of nodes) adjacency.set(node.id, []);
  for (const edge of edges) {
    if (!nodeIds.has(edge.fromNodeId) || !nodeIds.has(edge.toNodeId)) {
      return [edge.id];
    }
    adjacency.get(edge.fromNodeId)?.push(edge.toNodeId);
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const cycle: string[] = [];
  const visit = (nodeId: string): boolean => {
    if (visiting.has(nodeId)) {
      cycle.push(nodeId);
      return true;
    }
    if (visited.has(nodeId)) return false;
    visiting.add(nodeId);
    for (const next of adjacency.get(nodeId) ?? []) {
      if (visit(next)) {
        cycle.push(nodeId);
        return true;
      }
    }
    visiting.delete(nodeId);
    visited.add(nodeId);
    return false;
  };
  for (const node of nodes) {
    if (visit(node.id)) return cycle.reverse();
  }
  return [];
}

function assertNoCycle(snapshot: WorkGraphSnapshot): void {
  const cycle = wouldCreateCycle(snapshot.nodes, snapshot.edges);
  if (cycle.length > 0) throw new Error(`Work graph contains a cycle: ${cycle.join(' -> ')}`);
}

export async function createWorkGraph(
  params: WorkGraphCreateParams,
): Promise<{ graph: WorkGraphProjection }> {
  return withMutation(async () => {
    if (!params.project?.trim()) throw new Error('workGraph.create requires project');
    if (!params.title?.trim()) throw new Error('workGraph.create requires title');
    const now = new Date().toISOString();
    const id = normalizeId('wg', params.id, params.title);
    if (graphs.has(id)) throw new Error(`Work graph already exists: ${id}`);
    const graph: WorkGraph = {
      id,
      version: 1,
      project: params.project.trim(),
      title: params.title.trim(),
      source: params.source ?? { kind: 'manual' },
      ...(normalizeRunTags(params.tags).length ? { tags: normalizeRunTags(params.tags) } : {}),
      status: 'planning',
      defaultFailurePolicy: params.defaultFailurePolicy ?? 'halt',
      scheduler: {},
      createdAt: now,
      updatedAt: now,
    };
    const snapshot: WorkGraphSnapshot = { graph, nodes: [], edges: [], gates: [], ledger: [] };
    graphs.set(id, snapshot);
    await persistNow(snapshot);
    emit(snapshot);
    return { graph: project(snapshot) };
  });
}

export function listWorkGraphs(params: WorkGraphListRpcParams = {}): {
  graphs: WorkGraphProjection[];
} {
  const tagFilter = normalizeRunTags(params.tags);
  const filtered = [...graphs.values()].filter((snapshot) => {
    if (params.project && snapshot.graph.project !== params.project) return false;
    if (params.status && snapshot.graph.status !== params.status) return false;
    if (!params.includeArchived && snapshot.graph.status === 'archived') return false;
    if (tagFilter.length) {
      const graphTags = new Set(normalizeRunTags(snapshot.graph.tags));
      if (!tagFilter.every((tag) => graphTags.has(tag))) return false;
    }
    return true;
  });
  return { graphs: filtered.map(project) };
}

export function getWorkGraph(params: { graphId: string }): { graph: WorkGraphProjection } {
  return { graph: project(requireGraph(params.graphId)) };
}

function assertBacklogAvailableForNode(backlogItemId: string, graphId: string): void {
  const liveGraphs = [...graphs.values()].filter(
    (snapshot) => snapshot.graph.status !== 'archived',
  );
  for (const snapshot of liveGraphs) {
    if (snapshot.graph.id === graphId) continue;
    const existing = snapshot.nodes.find((node) => node.backlogItemId === backlogItemId);
    if (existing) {
      throw new Error(
        `Backlog item ${backlogItemId} is already attached to work graph ${snapshot.graph.id}`,
      );
    }
  }
}

function isBacklogNode(node: WorkNode): boolean {
  return node.kind === 'backlog';
}

function isReferenceNode(node: WorkNode): boolean {
  return node.kind === 'reference';
}

function referenceStatusToNodeStatus(status: WorkReferenceStatus): WorkNode['status'] {
  if (status === 'satisfied') return 'succeeded';
  if (status === 'waived') return 'skipped';
  if (status === 'failed') return 'failed';
  if (status === 'blocked') return 'needs-attention';
  return 'waiting';
}

function syncReferenceNode(node: WorkNode, now: string): void {
  if (!isReferenceNode(node)) return;
  const status = node.reference?.status ?? 'unknown';
  node.status = referenceStatusToNodeStatus(status);
  node.waitingOn =
    status === 'pending' || status === 'unknown' || status === 'blocked'
      ? [
          {
            kind: 'upstream',
            detail: `Waiting on ${node.reference?.kind ?? 'external'} reference ${
              node.reference?.ref ?? node.id
            }`,
          },
        ]
      : [];
  node.updatedAt = now;
}

export async function addWorkGraphNode(
  params: WorkGraphAddNodeParams,
): Promise<{ graph: WorkGraphProjection }> {
  return withMutation(async () => {
    const snapshot = requireGraph(params.graphId);
    if (snapshot.graph.status !== 'planning')
      throw new Error('workGraph.addNode requires planning status');
    const kind = params.kind ?? (params.reference ? 'reference' : 'backlog');
    if (kind === 'reference') {
      if (params.backlogItemId) throw new Error('Reference work nodes cannot set backlogItemId');
      if (!params.reference?.title?.trim() || !params.reference.ref?.trim()) {
        throw new Error('Reference work nodes require reference.title and reference.ref');
      }
      if (!params.reference.status) {
        throw new Error('Reference work nodes require reference.status');
      }
    } else if (!params.backlogItemId) {
      throw new Error('Backlog work nodes require backlogItemId');
    }
    const backlogItem = params.backlogItemId
      ? getBacklogItemSnapshot(params.backlogItemId)
      : undefined;
    if (kind === 'backlog') {
      if (snapshot.nodes.some((node) => node.backlogItemId === params.backlogItemId)) {
        throw new Error(`Backlog item ${params.backlogItemId} is already attached to this graph`);
      }
      assertBacklogAvailableForNode(params.backlogItemId!, params.graphId);
      if (!backlogItem) throw new Error(`Backlog item not found: ${params.backlogItemId}`);
    }
    const title = kind === 'reference' ? params.reference!.title : backlogItem!.title;
    const implicitIdSeed =
      kind === 'reference'
        ? `${title}-${params.reference!.kind}-${params.reference!.ref}`
        : `${title}-${backlogItem!.id}`;
    const nodeId = normalizeId('wn', params.id, implicitIdSeed);
    if (snapshot.nodes.some((node) => node.id === nodeId))
      throw new Error(`Work node already exists: ${nodeId}`);
    const now = new Date().toISOString();
    const node: WorkNode = {
      id: nodeId,
      graphId: snapshot.graph.id,
      kind,
      ...(backlogItem ? { backlogItemId: backlogItem.id } : {}),
      ...(kind === 'reference'
        ? {
            reference: {
              ...params.reference!,
              title: params.reference!.title.trim(),
              ref: params.reference!.ref.trim(),
              status: params.reference!.status,
              labels: normalizeRunTags(params.reference!.labels),
            },
          }
        : {}),
      ...(normalizeRunTags(params.tags ?? backlogItem?.tags).length
        ? { tags: normalizeRunTags(params.tags ?? backlogItem?.tags) }
        : {}),
      status: 'planned',
      waitingOn: [],
      ...(params.onFailure ? { onFailure: params.onFailure } : {}),
      updatedAt: now,
    };
    if (backlogItem) {
      await attachBacklogItemToWorkNode({
        itemId: backlogItem.id,
        graphId: snapshot.graph.id,
        nodeId,
      });
    }
    snapshot.nodes.push(node);
    snapshot.graph.updatedAt = now;
    await persistNow(snapshot);
    emit(snapshot);
    return { graph: project(snapshot) };
  });
}

export async function addWorkGraphEdge(
  params: WorkGraphAddEdgeParams,
): Promise<{ graph: WorkGraphProjection }> {
  return withMutation(async () => {
    const snapshot = requireGraph(params.graphId);
    if (snapshot.graph.status !== 'planning')
      throw new Error('workGraph.addEdge requires planning status');
    const fromNode = snapshot.nodes.find((node) => node.id === params.fromNodeId);
    if (!fromNode) throw new Error(`fromNode not found: ${params.fromNodeId}`);
    if (!snapshot.nodes.some((node) => node.id === params.toNodeId))
      throw new Error(`toNode not found: ${params.toNodeId}`);
    if (params.condition.kind === 'reference-status' && !isReferenceNode(fromNode)) {
      throw new Error('reference-status edges must originate from reference nodes');
    }
    const edge: WorkEdge = {
      id: normalizeId('we', params.id, `${params.fromNodeId}-${params.toNodeId}`),
      graphId: snapshot.graph.id,
      fromNodeId: params.fromNodeId,
      toNodeId: params.toNodeId,
      condition: params.condition,
      blocks: params.blocks ?? 'start',
      required: params.required !== false,
      status: 'pending',
      unlock: params.unlock ?? { kind: 'enqueue' },
    };
    const candidate = { ...snapshot, edges: [...snapshot.edges, edge] };
    assertNoCycle(candidate);
    snapshot.edges.push(edge);
    snapshot.graph.updatedAt = new Date().toISOString();
    await persistNow(snapshot);
    emit(snapshot);
    return { graph: project(snapshot) };
  });
}

export async function removeWorkGraphEdge(params: {
  graphId: string;
  edgeId: string;
}): Promise<{ graph: WorkGraphProjection }> {
  return withMutation(async () => {
    const snapshot = requireGraph(params.graphId);
    if (snapshot.graph.status !== 'planning') {
      throw new Error('workGraph.removeEdge requires planning status');
    }
    const edgeIndex = snapshot.edges.findIndex((edge) => edge.id === params.edgeId);
    if (edgeIndex < 0) throw new Error(`Work edge not found: ${params.edgeId}`);
    snapshot.edges.splice(edgeIndex, 1);
    snapshot.graph.updatedAt = new Date().toISOString();
    await persistNow(snapshot);
    emit(snapshot);
    return { graph: project(snapshot) };
  });
}

export async function removeWorkGraphNode(params: {
  graphId: string;
  nodeId: string;
}): Promise<{ graph: WorkGraphProjection }> {
  return withMutation(async () => {
    const snapshot = requireGraph(params.graphId);
    if (snapshot.graph.status !== 'planning') {
      throw new Error('workGraph.removeNode requires planning status');
    }
    const nodeIndex = snapshot.nodes.findIndex((node) => node.id === params.nodeId);
    if (nodeIndex < 0) throw new Error(`Work node not found: ${params.nodeId}`);
    const node = snapshot.nodes[nodeIndex]!;
    if (node.backlogItemId) {
      assertBacklogItemAttachedToWorkNode({
        itemId: node.backlogItemId,
        graphId: snapshot.graph.id,
        nodeId: node.id,
      });
    }
    const previousNodes = snapshot.nodes;
    const previousEdges = snapshot.edges;
    snapshot.nodes = snapshot.nodes.filter((candidate) => candidate.id !== params.nodeId);
    snapshot.edges = snapshot.edges.filter(
      (edge) => edge.fromNodeId !== params.nodeId && edge.toNodeId !== params.nodeId,
    );
    snapshot.graph.updatedAt = new Date().toISOString();
    try {
      if (node.backlogItemId) {
        await detachBacklogItemFromWorkNode({
          itemId: node.backlogItemId,
          graphId: snapshot.graph.id,
          nodeId: node.id,
        });
      }
      await persistNow(snapshot);
    } catch (err) {
      snapshot.nodes = previousNodes;
      snapshot.edges = previousEdges;
      throw err;
    }
    emit(snapshot);
    return { graph: project(snapshot) };
  });
}

export async function updateWorkGraphNode(
  params: WorkGraphUpdateNodeParams,
): Promise<{ graph: WorkGraphProjection }> {
  const shouldReconcile = await withMutation(async () => {
    const snapshot = requireGraph(params.graphId);
    const node = snapshot.nodes.find((candidate) => candidate.id === params.nodeId);
    if (!node) throw new Error(`Work node not found: ${params.nodeId}`);
    let referenceUpdated = false;
    if (params.status) node.status = params.status;
    if (params.reference !== undefined) {
      if (!isReferenceNode(node)) throw new Error('Only reference nodes can update reference data');
      if (params.reference === null) throw new Error('Reference nodes require reference data');
      if (!params.reference.title.trim() || !params.reference.ref.trim()) {
        throw new Error('Reference work nodes require reference.title and reference.ref');
      }
      if (!params.reference.status)
        throw new Error('Reference work nodes require reference.status');
      node.reference = {
        ...params.reference,
        title: params.reference.title.trim(),
        ref: params.reference.ref.trim(),
        labels: normalizeRunTags(params.reference.labels),
      };
      referenceUpdated = true;
      if (['waiting', 'needs-attention', 'done', 'failed'].includes(snapshot.graph.status)) {
        snapshot.graph.status = 'active';
      }
    }
    if (params.tags !== undefined) {
      const tags = params.tags === null ? [] : normalizeRunTags(params.tags);
      if (tags.length) node.tags = tags;
      else delete node.tags;
    }
    if (params.onFailure !== undefined) {
      if (params.onFailure === null) delete node.onFailure;
      else node.onFailure = params.onFailure;
    }
    if (params.baseRef !== undefined) {
      if (params.baseRef === null || !params.baseRef.trim()) delete node.baseRef;
      else node.baseRef = params.baseRef.trim();
    }
    if (params.upstreamBaseNodeIds !== undefined) {
      if (params.upstreamBaseNodeIds === null) delete node.upstreamBaseNodeIds;
      else
        node.upstreamBaseNodeIds = [
          ...new Set(params.upstreamBaseNodeIds.map((id) => id.trim()).filter(Boolean)),
        ];
    }
    node.updatedAt = new Date().toISOString();
    snapshot.graph.updatedAt = node.updatedAt;
    await persistNow(snapshot);
    emit(snapshot);
    return referenceUpdated && !['planning', 'paused', 'archived'].includes(snapshot.graph.status);
  });
  if (shouldReconcile) await schedulerTick({ graphId: params.graphId });
  return { graph: project(requireGraph(params.graphId)) };
}

export async function activateWorkGraph(params: {
  graphId: string;
}): Promise<{ graph: WorkGraphProjection }> {
  await withMutation(async () => {
    const snapshot = requireGraph(params.graphId);
    assertNoCycle(snapshot);
    const now = new Date().toISOString();
    snapshot.graph.status = 'active';
    snapshot.graph.updatedAt = now;
    for (const node of snapshot.nodes) {
      if (isReferenceNode(node)) {
        syncReferenceNode(node, now);
        continue;
      }
      if (node.status === 'planned') {
        node.status = 'waiting';
        node.updatedAt = now;
      }
    }
    await persistNow(snapshot);
    emit(snapshot);
  });
  await schedulerTick({ graphId: params.graphId });
  return { graph: project(requireGraph(params.graphId)) };
}

export async function pauseWorkGraph(params: {
  graphId: string;
}): Promise<{ graph: WorkGraphProjection }> {
  return withMutation(async () => {
    const snapshot = requireGraph(params.graphId);
    snapshot.graph.status = 'paused';
    snapshot.graph.updatedAt = new Date().toISOString();
    await persistNow(snapshot);
    emit(snapshot);
    return { graph: project(snapshot) };
  });
}

function terminalFamilyOutcome(
  runs: readonly Run[],
  familyId: string | undefined,
): 'success' | 'failure' | 'cancelled' | null {
  if (!familyId) return null;
  const familyRuns = runs.filter((run) => run.familyId === familyId || run.id === familyId);
  if (familyRuns.length === 0) return null;
  if (familyRuns.some((run) => !isTerminalRunStatus(run.status))) return null;
  if (familyRuns.some((run) => run.status === 'failed')) return 'failure';
  if (familyRuns.some((run) => run.status === 'cancelled')) return 'cancelled';
  return 'success';
}

function mergedEvidenceFromRuns(runs: readonly Run[]): { prNumber?: number } | null {
  // This used to cast Run to a shape carrying prState/mergedAt/mergeSha. Run
  // declared none of them and nothing wrote them, so the check was always false
  // and every `merged` edge stayed pending forever regardless of what shipped.
  // ci-watch now persists the merge observation onto the run; read the declared
  // fields so a lie in the type cannot hide a dead condition again.
  for (const run of runs) {
    if (run.prState === 'MERGED' || run.mergedAt) {
      return { prNumber: run.prNumber };
    }
  }
  return null;
}

/**
 * Returns true when the node was reclaimed — reset to `ready` because the run it
 * pointed at is gone. The caller needs to know: a reclaimed node reads `ready`
 * without any work having started, which is not the same thing as a node whose
 * dependency regressed mid-flight.
 */
function syncNodeFromBacklogQueueRuns(node: WorkNode, runs: readonly Run[]): boolean {
  if (!isBacklogNode(node)) return false;
  // A cancelled run is an aborted dispatch, not the node's active work — ignore
  // it so cancel returns the node to a dispatchable state instead of pinning it
  // to the cancelled run's status (which would otherwise read as running/failed
  // and block re-dispatch).
  const linkedRuns = runs.filter(
    (run) =>
      run.workGraphId === node.graphId && run.workNodeId === node.id && run.status !== 'cancelled',
  );
  const latestRun = linkedRuns.sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  const queued = getQueueSnapshot().find(
    (item) => item.workGraphId === node.graphId && item.workNodeId === node.id,
  );
  if (latestRun) {
    node.latestRunId = latestRun.id;
    node.currentFamilyId = latestRun.familyId;
    if (!latestRun.parentRunId) node.currentRootRunId = latestRun.id;
    if (latestRun.status === 'blocked' || latestRun.status === 'human-gating')
      node.status = 'gated';
    else if (latestRun.status === 'done') node.status = 'succeeded';
    else if (latestRun.status === 'failed') node.status = 'failed';
    else node.status = 'running';
    node.updatedAt = new Date().toISOString();
    return false;
  }
  if (queued) {
    const backlog = node.backlogItemId ? getBacklogItemSnapshot(node.backlogItemId) : null;
    if (backlog?.status === 'ready') {
      removeQueueItemInternal(queued.id, 'graph-sync-purge-stale-queue');
    } else {
      node.status = 'queued';
      node.updatedAt = new Date().toISOString();
      return false;
    }
  }
  const backlog = node.backlogItemId ? getBacklogItemSnapshot(node.backlogItemId) : null;
  if (
    backlog?.status === 'ready' &&
    !latestRun &&
    !queued &&
    // A node only legitimately reads `running` or `gated` while it has an active
    // linked run (handled above with an early return). Reaching here means the run
    // is gone (deleted/cancelled/missing), so a lingering `running` or `gated` is
    // orphaned and must reset to `ready` alongside the other stuck states —
    // otherwise the node stays permanently un-dispatchable. `gated` matters
    // particularly because the scheduler tick skips nodes already in that state,
    // so nothing else would ever re-evaluate it.
    (node.status === 'failed' ||
      node.status === 'needs-attention' ||
      node.status === 'queued' ||
      node.status === 'running' ||
      node.status === 'gated' ||
      // `succeeded` belongs here, but only when the node HELD a run that has
      // since gone. Deleting a run leaves its node succeeded and nothing else
      // reconsiders it, so reopening the backlog item and dispatching did
      // nothing but report that the node had succeeded. A node marked succeeded
      // without ever having a run — set manually, or driven by a reference
      // condition — has no run to lose and must not be reset.
      (node.status === 'succeeded' && !!node.latestRunId))
  ) {
    node.status = 'ready';
    delete node.latestRunId;
    // These point at the same departed run; leaving them makes the node claim a
    // family that no longer exists.
    delete node.currentFamilyId;
    delete node.currentRootRunId;
    node.updatedAt = new Date().toISOString();
    return true;
  }
  return false;
}

function evaluateEdge(
  edge: WorkEdge,
  snapshot: WorkGraphSnapshot,
  runs: readonly Run[],
  now: string,
): void {
  const from = snapshot.nodes.find((node) => node.id === edge.fromNodeId);
  if (!from) {
    edge.status = 'failed';
    edge.lastEvaluatedAt = now;
    return;
  }
  if (edge.condition.kind === 'manual') {
    const gateId = edge.condition.gateId;
    const resolution = [...snapshot.gates]
      .reverse()
      .find(
        (gate) =>
          gate.gateId === gateId &&
          (!gate.graphId || gate.graphId === snapshot.graph.id) &&
          (gate.edgeId ?? edge.id) === edge.id,
      );
    if (resolution?.decision === 'approved' || resolution?.decision === 'waived') {
      edge.status = resolution.decision === 'waived' ? 'waived' : 'satisfied';
      edge.evidence = { manualResolution: resolution, observedAt: resolution.resolvedAt };
    } else if (resolution?.decision === 'rejected') {
      edge.status = 'failed';
      edge.evidence = { manualResolution: resolution, observedAt: resolution.resolvedAt };
    } else {
      edge.status = 'pending';
      delete edge.evidence;
    }
  } else if (edge.condition.kind === 'reference-status') {
    const referenceStatus = from.reference?.status ?? 'unknown';
    const expected = edge.condition.status ?? 'satisfied';
    if (
      referenceStatus === expected ||
      (expected === 'satisfied' && referenceStatus === 'waived')
    ) {
      edge.status = referenceStatus === 'waived' ? 'waived' : 'satisfied';
      edge.evidence = {
        referenceStatus,
        referenceRef: from.reference?.ref,
        observedAt: from.reference?.updatedAt ?? now,
      };
    } else if ((referenceStatus === 'failed' || referenceStatus === 'blocked') && edge.required) {
      edge.status = 'failed';
      edge.evidence = {
        referenceStatus,
        referenceRef: from.reference?.ref,
        observedAt: from.reference?.updatedAt ?? now,
      };
    } else {
      edge.status = 'pending';
      delete edge.evidence;
    }
  } else if (edge.condition.kind === 'family-done') {
    const outcome = terminalFamilyOutcome(runs, from.currentFamilyId);
    if (
      outcome &&
      (edge.condition.outcome === 'terminal' ||
        (!edge.condition.outcome && outcome === 'success') ||
        edge.condition.outcome === outcome)
    ) {
      edge.status = 'satisfied';
      edge.evidence = { observedAt: now };
    } else if (outcome && outcome !== 'success' && edge.required) {
      edge.status = 'failed';
      edge.evidence = { observedAt: now };
    } else {
      edge.status = 'pending';
      delete edge.evidence;
    }
  } else if (edge.condition.kind === 'merged') {
    const upstreamRuns = runs.filter(
      (run) => run.familyId === from.currentFamilyId || run.id === from.currentFamilyId,
    );
    const evidence = mergedEvidenceFromRuns(upstreamRuns);
    if (evidence) {
      edge.status = 'satisfied';
      edge.evidence = { ...evidence, observedAt: now };
    } else {
      edge.status = 'pending';
      delete edge.evidence;
    }
  }
  edge.lastEvaluatedAt = now;
}

function readinessVersion(snapshot: WorkGraphSnapshot, node: WorkNode, actions: string[]): string {
  const satisfiedEdges = snapshot.edges
    .filter(
      (edge) =>
        edge.toNodeId === node.id &&
        edge.required &&
        (edge.status === 'satisfied' || edge.status === 'waived'),
    )
    .map((edge) => edge.id)
    .sort();
  return createHash('sha256')
    .update(
      JSON.stringify({
        graphId: snapshot.graph.id,
        nodeId: node.id,
        edges: satisfiedEdges,
        actions,
      }),
    )
    .digest('hex')
    .slice(0, 16);
}

function computeWaiting(node: WorkNode, inbound: readonly WorkEdge[]): void {
  node.waitingOn = inbound
    .filter((edge) => edge.required && edge.status !== 'satisfied' && edge.status !== 'waived')
    .map((edge) => ({
      kind: edge.condition.kind === 'manual' ? 'manual-gate' : 'upstream',
      edgeId: edge.id,
      upstreamNodeId: edge.fromNodeId,
      detail:
        edge.condition.kind === 'manual'
          ? `Waiting on manual gate ${edge.condition.gateId}`
          : edge.condition.kind === 'reference-status'
            ? `Waiting on external reference ${edge.fromNodeId}`
            : `Waiting on upstream node ${edge.fromNodeId}`,
    }));
}

function blocksStart(edge: WorkEdge): boolean {
  return edge.blocks !== 'completion';
}

function startEdges(inbound: readonly WorkEdge[]): WorkEdge[] {
  return inbound.filter(blocksStart);
}

function failedRequiredEdges(inbound: readonly WorkEdge[]): WorkEdge[] {
  return inbound.filter((edge) => edge.required && edge.status === 'failed');
}

function satisfiedCompletionRebaseEdges(inbound: readonly WorkEdge[]): WorkEdge[] {
  return inbound.filter(
    (edge) =>
      edge.blocks === 'completion' &&
      edge.unlock.kind === 'rebase-onto' &&
      edge.status === 'satisfied',
  );
}

function canRequireCompletionUnlock(node: WorkNode): boolean {
  return ['ready', 'queued', 'running', 'gated', 'succeeded'].includes(node.status);
}

function unlockActionKind(inbound: readonly WorkEdge[]): WorkGraphActionLedgerEntry['actionKind'] {
  if (inbound.some((edge) => edge.unlock.kind === 'mark-ready')) return 'mark-ready';
  if (inbound.some((edge) => edge.unlock.kind === 'rebase-onto')) return 'rebase-onto';
  return 'enqueue';
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function recordNodeUnlockFailure(
  snapshot: WorkGraphSnapshot,
  node: WorkNode,
  inbound: readonly WorkEdge[],
  now: string,
  message: string,
): void {
  const actions = inbound.map((edge) => edge.unlock.kind).sort();
  const version = readinessVersion(snapshot, node, actions);
  const actionKind = unlockActionKind(inbound);
  const existingStarted = snapshot.ledger.find(
    (entry) =>
      entry.graphId === snapshot.graph.id &&
      entry.nodeId === node.id &&
      entry.actionKind === actionKind &&
      entry.readinessVersion === version &&
      entry.status === 'started',
  );
  if (existingStarted) {
    existingStarted.status = 'failed';
    existingStarted.completedAt = now;
    existingStarted.result = message;
  } else {
    const key = `${snapshot.graph.id}:${node.id}:${actionKind}:failed:${version}`;
    if (!snapshot.ledger.some((entry) => entry.key === key)) {
      snapshot.ledger.push({
        key,
        graphId: snapshot.graph.id,
        nodeId: node.id,
        actionKind,
        readinessVersion: version,
        status: 'failed',
        startedAt: now,
        completedAt: now,
        result: message,
      });
    }
  }
  node.status = 'needs-attention';
  node.waitingOn = [{ kind: 'policy', detail: `Unlock failed: ${message}` }];
  node.updatedAt = now;
  snapshot.graph.status = 'needs-attention';
}

function backfillSchedulerAuthorization(snapshot: WorkGraphSnapshot, node: WorkNode): void {
  if (node.schedulerAuthorizedAt) return;
  const completedEntry = snapshot.ledger.find(
    (entry) =>
      entry.nodeId === node.id &&
      entry.status === 'completed' &&
      (entry.actionKind === 'enqueue' || entry.actionKind === 'mark-ready'),
  );
  if (completedEntry) {
    node.schedulerAuthorizedAt = completedEntry.completedAt ?? completedEntry.startedAt;
  }
}

async function executeNodeUnlock(
  snapshot: WorkGraphSnapshot,
  node: WorkNode,
  inbound: readonly WorkEdge[],
  now: string,
  options: { forceEnqueue?: boolean } = {},
): Promise<void> {
  if (!isBacklogNode(node) || !node.backlogItemId) {
    node.status = 'waiting';
    node.waitingOn = [{ kind: 'policy', detail: 'Reference nodes are not dispatchable' }];
    node.updatedAt = now;
    return;
  }
  const actions = inbound.map((edge) => edge.unlock.kind).sort();
  const version = readinessVersion(snapshot, node, actions);
  const actionKind = unlockActionKind(inbound);
  const actionKey = `${snapshot.graph.id}:${node.id}:${actionKind}:${version}`;
  const backlogItem = getBacklogItemSnapshot(node.backlogItemId);
  let existingQueue = getQueueSnapshot().find(
    (item) => item.workGraphId === snapshot.graph.id && item.workNodeId === node.id,
  );
  // Same rule as syncNodeFromBacklogQueueRuns: a cancelled run is an aborted
  // dispatch, not work in flight. Counting it as an existing run made unlock
  // record the action completed and return, so a node reset to ready after a
  // cancel was never re-enqueued.
  const existingRun = getAllRuns().find(
    (run) =>
      run.workGraphId === snapshot.graph.id &&
      run.workNodeId === node.id &&
      run.status !== 'cancelled',
  );
  if (
    existingQueue?.status === 'queued' &&
    !existingRun &&
    backlogItem?.status === 'ready' &&
    node.status === 'ready'
  ) {
    removeQueueItemInternal(existingQueue.id, 'graph-retry-purge-stale-queue');
    existingQueue = undefined;
  }
  const completedEntry = snapshot.ledger.find(
    (entry) => entry.key === actionKey && entry.status === 'completed',
  );
  if (completedEntry) {
    backfillSchedulerAuthorization(snapshot, node);
    const retryableStaleEnqueue =
      actionKind === 'enqueue' &&
      !existingQueue &&
      !existingRun &&
      backlogItem?.status === 'ready' &&
      node.status === 'ready';
    if (!retryableStaleEnqueue) return;
    snapshot.ledger = snapshot.ledger.filter((entry) => entry.key !== actionKey);
  }
  if (actionKind === 'enqueue' && backlogItem?.autoDispatch === false && !options.forceEnqueue) {
    // Declining is correct, but it must be visible: clearing `waitingOn` here left
    // the node reading `ready` with nothing pending and no ledger entry, so a graph
    // that could never dispatch looked healthy. State the reason and both escapes.
    node.status = 'ready';
    node.waitingOn = [
      {
        kind: 'policy',
        detail:
          `Backlog item ${backlogItem.sourceRef ?? backlogItem.id} has autoDispatch disabled, ` +
          'so the graph will not enqueue it. Enable autoDispatch on the item, or force a ' +
          'scheduler tick with forceEnqueue.',
      },
    ];
    node.updatedAt = now;
    return;
  }
  if (inbound.some((edge) => edge.unlock.kind === 'rebase-onto')) {
    node.status = 'needs-attention';
    node.waitingOn = [
      {
        kind: 'policy',
        detail: 'rebase-onto unlock requires ci-watch helper integration before execution',
      },
    ];
    snapshot.graph.status = 'needs-attention';
    const existing = snapshot.ledger.find((entry) => entry.key === actionKey);
    if (existing) {
      existing.status = 'failed';
      existing.completedAt = existing.completedAt ?? now;
      existing.result = 'helper-not-wired';
    } else {
      snapshot.ledger.push({
        key: actionKey,
        graphId: snapshot.graph.id,
        nodeId: node.id,
        actionKind: 'rebase-onto',
        readinessVersion: version,
        status: 'failed',
        startedAt: now,
        completedAt: now,
        result: 'helper-not-wired',
      });
    }
    return;
  }
  if (existingQueue || existingRun) {
    node.schedulerAuthorizedAt = node.schedulerAuthorizedAt ?? now;
    snapshot.ledger.push({
      key: actionKey,
      graphId: snapshot.graph.id,
      nodeId: node.id,
      actionKind,
      readinessVersion: version,
      status: 'completed',
      startedAt: now,
      completedAt: now,
      result: existingRun ? `run:${existingRun.id}` : `queue:${existingQueue?.id}`,
    });
    return;
  }
  if (inbound.some((edge) => edge.unlock.kind === 'mark-ready')) {
    await markBacklogItemReady({ itemId: node.backlogItemId });
    node.status = 'ready';
    node.schedulerAuthorizedAt = node.schedulerAuthorizedAt ?? now;
    snapshot.ledger.push({
      key: actionKey,
      graphId: snapshot.graph.id,
      nodeId: node.id,
      actionKind: 'mark-ready',
      readinessVersion: version,
      status: 'completed',
      startedAt: now,
      completedAt: now,
      result: 'ready',
    });
    return;
  }
  snapshot.ledger.push({
    key: actionKey,
    graphId: snapshot.graph.id,
    nodeId: node.id,
    actionKind: 'enqueue',
    readinessVersion: version,
    status: 'started',
    startedAt: now,
  });
  const result = await enqueueBacklogItem(
    { itemId: node.backlogItemId },
    { workGraphId: snapshot.graph.id, workNodeId: node.id },
  );
  await persistQueueNow();
  node.status = 'queued';
  const entry = snapshot.ledger.find((candidate) => candidate.key === actionKey);
  if (entry) {
    const completedAt = new Date().toISOString();
    entry.status = 'completed';
    entry.completedAt = completedAt;
    entry.result = `queue:${result.queueItem.id}`;
    node.schedulerAuthorizedAt = node.schedulerAuthorizedAt ?? completedAt;
  }
}

function acquireLease(snapshot: WorkGraphSnapshot, owner: string, nowMs: number): boolean {
  const leaseUntil = Date.parse(snapshot.graph.scheduler.leaseUntil ?? '');
  if (
    snapshot.graph.scheduler.leaseOwner &&
    Number.isFinite(leaseUntil) &&
    leaseUntil > nowMs &&
    snapshot.graph.scheduler.leaseOwner !== owner
  ) {
    return false;
  }
  snapshot.graph.scheduler.leaseOwner = owner;
  snapshot.graph.scheduler.leaseUntil = new Date(nowMs + LEASE_MS).toISOString();
  snapshot.graph.scheduler.lastTickAt = new Date(nowMs).toISOString();
  return true;
}

export async function schedulerTick(
  params: { graphId?: string; forceEnqueue?: boolean } = {},
): Promise<{ ok: true; graphs: WorkGraphProjection[] }> {
  return withMutation(async () => {
    const owner = `gateway-${process.pid}`;
    const nowMs = Date.now();
    const now = new Date(nowMs).toISOString();
    const unlockOptions = { forceEnqueue: params.forceEnqueue === true };
    const targets = [...graphs.values()].filter((snapshot) => {
      // A targeted tick is an operator asking about one specific graph, so it
      // recomputes whatever state that graph is in. The background sweep still
      // skips the rest: `needs-attention` means a human has to look, and a graph
      // that reached it could otherwise never be reprocessed — not even once the
      // condition that flagged it cleared — leaving no way back except activate.
      if (params.graphId) return snapshot.graph.id === params.graphId;
      return snapshot.graph.status === 'active' || snapshot.graph.status === 'waiting';
    });
    const updated: WorkGraphProjection[] = [];
    for (const snapshot of targets) {
      if (!acquireLease(snapshot, owner, nowMs)) continue;
      const runs = getAllRuns();
      const reclaimed = new Set<string>();
      for (const node of snapshot.nodes) {
        if (syncNodeFromBacklogQueueRuns(node, runs)) reclaimed.add(node.id);
      }
      for (const edge of snapshot.edges) evaluateEdge(edge, snapshot, runs, now);
      let runnable = 0;
      let graphNeedsAttention = false;
      for (const node of snapshot.nodes) {
        // Persisted v1 snapshots predate schedulerAuthorizedAt. Their completed
        // action ledger is the durable proof that the scheduler admitted the
        // node, so restore that proof before deciding whether a completed run
        // is historical work imported during reconciliation.
        backfillSchedulerAuthorization(snapshot, node);
        const inbound = snapshot.edges.filter((edge) => edge.toNodeId === node.id);
        const startInbound = startEdges(inbound);
        const failedRequired = failedRequiredEdges(inbound);
        if (failedRequired.length > 0) {
          node.status = 'needs-attention';
          node.waitingOn = failedRequired.map((edge) => ({
            kind: edge.condition.kind === 'manual' ? 'manual-gate' : 'upstream',
            edgeId: edge.id,
            upstreamNodeId: edge.fromNodeId,
            detail: `Required upstream edge ${edge.id} failed`,
          }));
          node.updatedAt = now;
          snapshot.graph.status = 'needs-attention';
          graphNeedsAttention = true;
          continue;
        }
        const completionRebaseInbound = satisfiedCompletionRebaseEdges(inbound);
        if (completionRebaseInbound.length > 0 && canRequireCompletionUnlock(node)) {
          try {
            await executeNodeUnlock(snapshot, node, completionRebaseInbound, now, unlockOptions);
          } catch (err) {
            recordNodeUnlockFailure(
              snapshot,
              node,
              completionRebaseInbound,
              now,
              errorMessage(err),
            );
          }
          if (node.status === 'needs-attention') graphNeedsAttention = true;
          continue;
        }
        if (isReferenceNode(node)) {
          computeWaiting(node, startInbound);
          if (node.waitingOn.length > 0) {
            node.status = 'waiting';
            node.updatedAt = now;
          } else {
            syncReferenceNode(node, now);
          }
          continue;
        }
        const hasCompletedRun =
          node.status === 'succeeded' &&
          node.latestRunId !== undefined &&
          runs.some((run) => run.id === node.latestRunId && run.status === 'done');
        if (hasCompletedRun && !node.schedulerAuthorizedAt) {
          // Start dependencies decide whether work may begin. Once a durable run
          // completed without scheduler authorization, later reconciliation must
          // not rewrite that historical outcome for a merely pending prerequisite.
          // Failed required edges are handled above and still require attention.
          if (node.waitingOn.length > 0) {
            node.waitingOn = [];
            node.updatedAt = now;
          }
          continue;
        }
        computeWaiting(node, startInbound);
        const blocked = node.waitingOn.length > 0;
        if (blocked) {
          // A node reclaimed on this very tick reads `ready` only because its run
          // went away, not because work regressed under it. Flagging that as a
          // regression made the two rules fight: the reclaim reset the node every
          // tick and this branch re-flagged it, pinning the node and its graph in
          // `needs-attention` — which the background sweep skips, so nothing could
          // ever clear it.
          if (
            !reclaimed.has(node.id) &&
            ['ready', 'queued', 'running', 'gated', 'succeeded'].includes(node.status)
          ) {
            const regressionReason =
              'Start dependency regressed after this node became active; review queued/running work manually';
            if (node.backlogItemId && node.status === 'queued') {
              // Queue removal + backlog needs-attention via commitDependent:
              // cancelGraphQueuedItem restores the row if the dependent write throws
              // (best-effort same-unit recovery, not a multi-store transaction).
              const cancelled = await cancelGraphQueuedItem({
                workGraphId: snapshot.graph.id,
                workNodeId: node.id,
                reason: regressionReason,
                commitDependent: async () => {
                  await markBacklogItemNeedsAttention({
                    itemId: node.backlogItemId!,
                    reason: regressionReason,
                    clearQueueLink: true,
                  });
                },
              });
              if (!cancelled) {
                await markBacklogItemNeedsAttention({
                  itemId: node.backlogItemId,
                  reason: regressionReason,
                  clearQueueLink: false,
                });
              }
            }
            node.status = 'needs-attention';
            node.waitingOn = [
              ...node.waitingOn,
              {
                kind: 'policy',
                detail: regressionReason,
              },
            ];
            snapshot.graph.status = 'needs-attention';
            graphNeedsAttention = true;
          } else {
            node.status = 'waiting';
          }
          node.updatedAt = now;
          continue;
        }
        if (['queued', 'running', 'gated', 'succeeded', 'failed', 'skipped'].includes(node.status))
          continue;
        const requiredInbound = startInbound.filter((edge) => edge.required);
        const satisfiedInbound = requiredInbound.filter(
          (edge) => edge.status === 'satisfied' || edge.status === 'waived',
        );
        if (requiredInbound.length === satisfiedInbound.length) {
          runnable++;
          try {
            await executeNodeUnlock(snapshot, node, startInbound, now, unlockOptions);
          } catch (err) {
            recordNodeUnlockFailure(snapshot, node, inbound, now, errorMessage(err));
          }
          if (node.status === 'needs-attention') graphNeedsAttention = true;
        }
      }
      if (
        graphNeedsAttention ||
        snapshot.nodes.some((node) => isBacklogNode(node) && node.status === 'needs-attention')
      ) {
        snapshot.graph.status = 'needs-attention';
      } else {
        const allDone =
          snapshot.nodes.length > 0 &&
          snapshot.nodes.every((node) => node.status === 'succeeded' || node.status === 'skipped');
        const allRequiredEdgesSettled = snapshot.edges.every(
          (edge) => !edge.required || edge.status === 'satisfied' || edge.status === 'waived',
        );
        snapshot.graph.status =
          allDone && allRequiredEdgesSettled ? 'done' : runnable === 0 ? 'waiting' : 'active';
      }
      snapshot.graph.updatedAt = now;
      await persistNow(snapshot);
      emit(snapshot);
      updated.push(project(snapshot));
    }
    return { ok: true, graphs: updated };
  });
}

export async function gateResolve(params: {
  graphId?: string;
  gateId: string;
  nodeId?: string;
  edgeId?: string;
  reason: string;
  decision: 'approved' | 'rejected' | 'waived';
}): Promise<{ graph: WorkGraphProjection }> {
  const graphId = await withMutation(async () => {
    const matches = [...graphs.values()].flatMap((candidate) =>
      candidate.edges
        .filter(
          (edge) =>
            edge.condition.kind === 'manual' &&
            edge.condition.gateId === params.gateId &&
            (!params.graphId || edge.graphId === params.graphId) &&
            (!params.edgeId || edge.id === params.edgeId) &&
            (!params.nodeId || edge.toNodeId === params.nodeId),
        )
        .map((edge) => ({ snapshot: candidate, edge })),
    );
    if (matches.length === 0) throw new Error(`Manual graph gate not found: ${params.gateId}`);
    if (matches.length > 1) {
      throw new Error(
        `Manual graph gate ${params.gateId} is ambiguous; include graphId, edgeId, or nodeId`,
      );
    }
    const { snapshot, edge } = matches[0]!;
    snapshot.gates.push({
      ...params,
      graphId: snapshot.graph.id,
      edgeId: params.edgeId ?? edge.id,
      nodeId: params.nodeId ?? edge.toNodeId,
      resolvedAt: new Date().toISOString(),
    });
    if (snapshot.graph.status === 'waiting' || snapshot.graph.status === 'needs-attention')
      snapshot.graph.status = 'active';
    await persistNow(snapshot);
    emit(snapshot);
    return snapshot.graph.id;
  });
  await schedulerTick({ graphId });
  return { graph: project(requireGraph(graphId)) };
}
