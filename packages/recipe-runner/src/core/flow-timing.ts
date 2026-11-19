import {
  isRecord,
  type RecipeFlowTiming,
  type RecipeInvocationNode,
  type RecipeInvocationTiming,
  type RecipeInvocationTree,
  type RecipeTimingQualification,
  type RecipeTimingRollup,
} from '@farmslot/protocol';

interface Interval {
  start: number;
  end: number;
}
interface RecordedNode {
  windows: Interval[];
  spans: Interval[];
  invalid: boolean;
  open: boolean;
  choices: Set<string>;
  unknownChoice: boolean;
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
}

/** Incremental interval index. Snapshots use prepared edges and cached node metrics, not trace history. */
export function createRecipeInvocationTimingProjection(
  tree: RecipeInvocationTree,
): RecipeInvocationTimingProjection {
  const nodes = new Map(tree.nodes.map((node) => [node.id, node]));
  const recorded = new Map<string, RecordedNode>();
  const cached = new Map<string, QualifiedNode>();
  const state = (id: string) => {
    let result = recorded.get(id);
    if (!result) {
      result = {
        windows: [],
        spans: [],
        invalid: false,
        open: false,
        choices: new Set(),
        unknownChoice: false,
      };
      recorded.set(id, result);
    }
    return result;
  };
  const dirty = (id: string) => {
    cached.delete(id);
    const parent = nodes.get(id)?.parentId;
    if (parent) cached.delete(parent);
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
  const reachable = (): Set<string> => {
    const result = new Set<string>();
    const pending = [tree.rootId];
    while (pending.length) {
      const id = pending.pop()!;
      if (result.has(id)) continue;
      result.add(id);
      const node = nodes.get(id)!;
      const value = recorded.get(id);
      const edges =
        Object.keys(node.cases).length && value?.choices.size && !value.unknownChoice
          ? [...value.choices]
          : [node.next, node.default, ...Object.values(node.cases)];
      for (const next of [node.entry, node.teardown, ...edges])
        if (next !== null && nodes.has(next)) pending.push(next);
    }
    return result;
  };
  const qualify = (node: RecipeInvocationNode, active: ReadonlySet<string>): QualifiedNode => {
    const known = cached.get(node.id);
    if (known) return known;
    const value = recorded.get(node.id);
    if (!value?.windows.length) return unknown();
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
    const children = node.children.filter((id) => active.has(id));
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
    cached.set(node.id, result);
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
    let complete = true;
    for (const id of ids) {
      const metric = metrics.get(id)!;
      const qualification = own
        ? metric.timing.qualification.self
        : metric.timing.qualification.inclusive;
      if (qualification !== 'measured') complete = false;
      if (qualification !== 'unknown') {
        qualified++;
        spans.push(...(own ? metric.self! : recorded.get(id)!.spans));
      }
    }
    return {
      durationMs: qualified ? duration(union(spans)) : null,
      qualification: qualified ? (complete ? 'measured' : 'partial') : 'unknown',
      invocationIds: ids,
    };
  };
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
      if (Object.keys(node.cases).length) {
        const edges = [
          ...new Set(
            [node.next, node.default, ...Object.values(node.cases)].filter(
              (id): id is string => id !== null,
            ),
          ),
        ];
        const selected =
          typeof entry.next === 'string'
            ? edges.filter((id) => id === entry.next || nodes.get(id)?.nodeId === entry.next)
            : typeof entry.case === 'string' && node.cases[entry.case]
              ? [node.cases[entry.case]!]
              : [];
        const value = state(node.id);
        if (selected.length === 1) value.choices.add(selected[0]!);
        else value.unknownChoice = true;
        cached.clear(); // A recorded branch changes which prepared children could have executed.
      }
    },
    setRunInterval(value) {
      recordWindow(tree.rootId, value);
    },
    snapshot() {
      const active = reachable();
      const metrics = new Map(
        tree.nodes.map((node) => [
          node.id,
          active.has(node.id) ? qualify(node, active) : unknown(),
        ]),
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
    },
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
