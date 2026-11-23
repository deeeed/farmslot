import {
  isRecord,
  type RecipeFlowTiming,
  type RecipeFlowTimingUpdate,
  type RecipeInvocationNode,
  type RecipeInvocationTiming,
  type RecipeInvocationTree,
  type RecipeTimingQualification,
  type RecipeTimingRollup,
} from '@farmslot/protocol';

import { createRecipeInvocationRouteIndex } from './flow-route.js';

interface Interval {
  start: number;
  end: number;
}
interface RecordedNode {
  windows: Interval[];
  spans: Interval[];
  invalid: boolean;
  open: boolean;
}
interface QualifiedNode {
  timing: RecipeInvocationTiming;
  self: Interval[] | null;
}

function interval(value: unknown): Interval | null {
  if (!isRecord(value) || typeof value.startedAt !== 'string' || typeof value.endedAt !== 'string')
    return null;
  const start = Date.parse(value.startedAt);
  const end = Date.parse(value.endedAt);
  if (
    value.intervalSource === 'diagnostic' ||
    (value.intervalSource !== 'execution' &&
      value.ok === false &&
      !(value.action === 'end' && ['pass', 'fail', 'unknown'].includes(String(value.status))) &&
      start === end)
  )
    return null;
  return Number.isFinite(start) && Number.isFinite(end) && end >= start ? { start, end } : null;
}

function union(spans: readonly Interval[]): Interval[] {
  const result: Interval[] = [];
  for (const span of [...spans].sort((a, b) => a.start - b.start || a.end - b.end)) {
    const last = result.at(-1);
    if (last && span.start <= last.end) last.end = Math.max(last.end, span.end);
    else result.push({ ...span });
  }
  return result;
}
const duration = (spans: readonly Interval[]) =>
  spans.reduce((sum, span) => sum + span.end - span.start, 0);
const unknown = (): QualifiedNode => ({
  timing: {
    inclusiveMs: null,
    selfMs: null,
    qualification: { inclusive: 'unknown', self: 'unknown' },
  },
  self: null,
});

export interface RecipeInvocationTimingProjection {
  /** Consume the same occurrence the trace writer records, once. */
  record(entry: unknown): void;
  start(id: string): void;
  setRunInterval(value: unknown): void;
  snapshot(): RecipeFlowTiming;
  snapshot(ids: readonly string[]): RecipeFlowTimingUpdate;
}

/** Incremental interval index. Snapshots use prepared edges and cached node metrics, not trace history. */
export function createRecipeInvocationTimingProjection(
  tree: RecipeInvocationTree,
): RecipeInvocationTimingProjection {
  const nodes = new Map(tree.nodes.map((node) => [node.id, node]));
  const recorded = new Map<string, RecordedNode>();
  const route = createRecipeInvocationRouteIndex(tree);
  const cached = new Map<string, QualifiedNode>();
  const state = (id: string) => {
    let result = recorded.get(id);
    if (!result) {
      result = {
        windows: [],
        spans: [],
        invalid: false,
        open: false,
      };
      recorded.set(id, result);
    }
    return result;
  };
  const dirty = (id: string) => {
    cached.delete('active:' + id);
    cached.delete('all:' + id);
    const parent = nodes.get(id)?.parentId;
    if (parent) {
      cached.delete('active:' + parent);
      cached.delete('all:' + parent);
    }
  };
  const recordWindow = (id: string, value: unknown) => {
    const target = state(id);
    target.open = false;
    const window = interval(value);
    if (!window) target.invalid = true;
    else if (
      !target.windows.some((prior) => prior.start === window.start && prior.end === window.end)
    ) {
      target.windows.push(window);
      target.spans = union([...target.spans, window]);
    }
    dirty(id);
  };
  const qualify = (
    node: RecipeInvocationNode,
    active: ReadonlySet<string> | null,
  ): QualifiedNode => {
    const cacheKey = (active === null ? 'active:' : 'all:') + node.id;
    const known = cached.get(cacheKey);
    if (known) return known;
    const value = recorded.get(node.id);
    if (!value?.windows.length) {
      const result = unknown();
      cached.set(cacheKey, result);
      return result;
    }
    const inclusive: RecipeTimingQualification =
      value.invalid || value.open ? 'partial' : 'measured';
    const result: QualifiedNode = {
      timing: {
        inclusiveMs: duration(value.spans),
        selfMs: null,
        qualification: { inclusive, self: 'unknown' },
      },
      self: null,
    };
    cached.set(cacheKey, result);
    const children = node.children.filter((id) => active === null || active.has(id));
    const childStates = children.map((id) => recorded.get(id));
    // Missing or invalid child coverage cannot give a lower bound for self time.
    if (childStates.some((child) => !child?.windows.length || child.invalid || child.open))
      return result;
    const windows = [...value.windows].sort((a, b) => a.start - b.start || a.end - b.end);
    if (
      children.length &&
      windows.some((span, index) => index > 0 && span.start < windows[index - 1]!.end)
    )
      return result;
    const childSpans = union(childStates.flatMap((child) => child!.spans));
    if (
      childSpans.some(
        (child) =>
          !value.spans.some((parent) => child.start >= parent.start && child.end <= parent.end),
      )
    )
      return result;
    if (
      windows.some((parent) =>
        childStates.some(
          (child) =>
            !child!.windows.some((span) => span.start >= parent.start && span.end <= parent.end),
        ),
      )
    )
      return result;
    const self: Interval[] = [];
    for (const parent of value.spans) {
      let cursor = parent.start;
      for (const child of childSpans) {
        if (child.end < parent.start || child.start > parent.end) continue;
        if (child.start > cursor) self.push({ start: cursor, end: child.start });
        cursor = Math.max(cursor, child.end);
      }
      if (cursor < parent.end) self.push({ start: cursor, end: parent.end });
    }
    result.self = self;
    result.timing.selfMs = duration(self);
    result.timing.qualification.self = inclusive;
    cached.set(cacheKey, result);
    return result;
  };
  const claimOwners = new Map<string, Set<string>>();
  const owners = (node: RecipeInvocationNode): Set<string> => {
    let result = claimOwners.get(node.id);
    if (!result) {
      result = new Set([
        ...node.claimIds,
        ...(node.parentId ? owners(nodes.get(node.parentId)!) : []),
      ]);
      claimOwners.set(node.id, result);
    }
    return result;
  };
  for (const node of tree.nodes) owners(node);
  const rollup = (
    ids: string[],
    metrics: ReadonlyMap<string, QualifiedNode>,
    own: boolean,
  ): RecipeTimingRollup => {
    const spans: Interval[] = [];
    let qualified = 0;
    const contributors: string[] = [];
    let complete = true;
    for (const id of ids) {
      const metric = metrics.get(id)!;
      const qualification = own
        ? metric.timing.qualification.self
        : metric.timing.qualification.inclusive;
      if (qualification !== 'measured') complete = false;
      if (qualification !== 'unknown') {
        qualified++;
        contributors.push(id);
        spans.push(...(own ? metric.self! : recorded.get(id)!.spans));
      }
    }
    return {
      durationMs: qualified ? duration(union(spans)) : null,
      qualification: qualified ? (complete ? 'measured' : 'partial') : 'unknown',
      invocationIds: contributors,
    };
  };
  function snapshot(): RecipeFlowTiming;
  function snapshot(ids: readonly string[]): RecipeFlowTimingUpdate;
  function snapshot(ids?: readonly string[]): RecipeFlowTiming | RecipeFlowTimingUpdate {
    if (ids) {
      return {
        scope: 'active',
        nodes: Object.fromEntries(
          ids.map((id) => {
            const node = nodes.get(id)!;
            // Active rows do not resolve the whole graph. An untimed possible child
            // conservatively leaves self unknown until the full recorded report.
            const metric = qualify(node, null);
            return [id, structuredClone(metric.timing)];
          }),
        ),
      };
    }
    const active = route.reachable();
    const metrics = new Map(
      tree.nodes.map((node) => [node.id, active.has(node.id) ? qualify(node, active) : unknown()]),
    );
    const claims = new Map<string, string[]>();
    for (const node of tree.nodes)
      if (active.has(node.id))
        for (const claim of node.claimIds) {
          const ids = claims.get(claim) ?? [];
          ids.push(node.id);
          claims.set(claim, ids);
        }
    return {
      scope: 'all',
      nodes: Object.fromEntries(
        [...metrics].map(([id, metric]) => [id, structuredClone(metric.timing)]),
      ),
      claimTimings: Object.fromEntries(
        [...claims].map(([claim, ids]) => [claim, rollup(ids, metrics, false)]),
      ),
      unassignedTiming: rollup(
        tree.nodes
          .filter((node) => active.has(node.id) && !owners(node).size)
          .map((node) => node.id),
        metrics,
        true,
      ),
    };
  }
  return {
    start(id) {
      if (nodes.has(id)) {
        state(id).open = true;
        dirty(id);
      }
    },
    record(entry) {
      if (!isRecord(entry) || typeof entry.nodeId !== 'string') return;
      const node = nodes.get(entry.nodeId);
      if (!node || entry.action !== node.action) return;
      recordWindow(node.id, entry);
      route.record(entry);
      if (Object.keys(node.cases).length) cached.clear();
    },
    setRunInterval(value) {
      recordWindow(tree.rootId, value);
    },
    snapshot,
  };
}

export interface ProjectRecipeInvocationTimingInput {
  tree: RecipeInvocationTree;
  trace: readonly unknown[];
  summary?: unknown;
  activeId?: string | null;
}

/** One normalization pass for an existing recorded execution; never estimates from media or the clock. */
export function projectRecipeInvocationTiming(
  input: ProjectRecipeInvocationTimingInput,
): RecipeFlowTiming {
  const projection = createRecipeInvocationTimingProjection(input.tree);
  for (const entry of input.trace) projection.record(entry);
  if (input.activeId) projection.start(input.activeId);
  if (input.summary !== undefined) projection.setRunInterval(input.summary);
  return projection.snapshot();
}
