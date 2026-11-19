import {
  isRecipeFlowUpdate,
  isRecord,
  normalizeRecipeClaimId,
  type RecipeFlowProgress,
  type RecipeFlowUpdate,
  type RecipeInvocationNode,
  type RecipeInvocationTree,
  recipeTraceEntries,
  type RecordedEvidencePackageInput,
} from '@farmslot/protocol';
import { buildRecipeInvocationAncestry } from '@farmslot/recipe-runner/evidence';

import type {
  EvidenceReviewClaim,
  EvidenceReviewInput,
  EvidenceReviewModel,
  EvidenceReviewOccurrence,
} from './evidence-review-model.js';
import type { RunEvidenceCue, RunEvidenceFile } from './run-evidence-view.js';

export interface EvidenceReviewPendingFlow {
  tree: RecipeInvocationTree;
  update: RecipeFlowUpdate;
}

export type RunEvidenceFlowStatus = 'running' | 'pass' | 'fail' | 'skipped' | 'unknown';

export interface RunEvidenceFlowDecision {
  case: string | null;
  next: string | null;
}

export interface RunEvidenceFlowOccurrence {
  recipeRunId: string;
  traceIndex: number;
  invocationId: string | null;
  status: 'pass' | 'fail' | 'unknown';
  decision: RunEvidenceFlowDecision;
  claimIds: string[];
  files: RunEvidenceFile[];
  cue: RunEvidenceCue | null;
}

export interface RunEvidenceFlowNode extends RecipeInvocationNode {
  depth: number;
  breadcrumbIds: string[];
  status: RunEvidenceFlowStatus;
  occurrences: RunEvidenceFlowOccurrence[];
}

export interface RunEvidenceFlow {
  version: 1;
  recipeRunId: string;
  rootId: string;
  activeId: string | null;
  progress: RecipeFlowProgress;
  nodes: RunEvidenceFlowNode[];
}

interface FlowProjectionContext {
  trace: readonly unknown[];
  occurrences: readonly EvidenceReviewOccurrence[];
  claims: readonly EvidenceReviewClaim[];
  occurrenceCue: EvidenceReviewModel['occurrenceCue'];
  markerSeekMs: EvidenceReviewModel['markerSeekMs'];
  artifactPath(path: string): string;
  warnings: string[];
  valid: boolean;
  retainedSources: ReadonlyMap<string, { input: RecordedEvidencePackageInput; prefix: string }>;
}

const identity = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
const nullableId = (value: unknown): value is string | null => value === null || identity(value);
const strings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every(identity);

function isNode(value: unknown): value is RecipeInvocationNode {
  return (
    isRecord(value) &&
    identity(value.id) &&
    nullableId(value.parentId) &&
    identity(value.recipeRef) &&
    nullableId(value.nodeId) &&
    identity(value.action) &&
    typeof value.label === 'string' &&
    strings(value.children) &&
    nullableId(value.entry) &&
    nullableId(value.teardown) &&
    nullableId(value.next) &&
    nullableId(value.default) &&
    isRecord(value.cases) &&
    Object.values(value.cases).every(identity) &&
    strings(value.claimIds)
  );
}

/** Check the prepared data; never reconstruct a missing tree from trace paths. */
function checkedTree(value: unknown): RecipeInvocationTree | null {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    !identity(value.rootId) ||
    !Array.isArray(value.nodes) ||
    !value.nodes.every(isNode)
  )
    return null;
  const nodes = new Map(value.nodes.map((node) => [node.id, node]));
  if (nodes.size !== value.nodes.length || nodes.get(value.rootId)?.parentId !== null) return null;
  const state = new Map<string, 'visiting' | 'done'>();
  const owner = new Map<string, string>();
  for (const node of nodes.values())
    for (const child of node.children) {
      if (owner.has(child) || nodes.get(child)?.parentId !== node.id) return null;
      owner.set(child, node.id);
    }
  const parentValid = (id: string): boolean => {
    if (state.get(id) === 'done') return true;
    if (state.get(id) === 'visiting') return false;
    const node = nodes.get(id);
    if (!node) return false;
    state.set(id, 'visiting');
    if (id !== value.rootId && (node.parentId === null || !parentValid(node.parentId)))
      return false;
    state.set(id, 'done');
    return true;
  };
  for (const node of nodes.values()) {
    if (!parentValid(node.id)) return null;
    if (node.parentId !== null && owner.get(node.id) !== node.parentId) return null;
    for (const id of [node.entry, node.teardown])
      if (id !== null && nodes.get(id)?.parentId !== node.id) return null;
    for (const id of [node.next, node.default, ...Object.values(node.cases)])
      if (id !== null && (!nodes.has(id) || nodes.get(id)?.parentId !== node.parentId)) return null;
  }
  return { version: 1, rootId: value.rootId, nodes: value.nodes };
}

function packageIdentity(input: RecordedEvidencePackageInput | undefined): string | null {
  if (!input) return null;
  const ids = [
    input.recipeRunId,
    input.claims?.recipeRunId,
    isRecord(input.summary) ? input.summary.recipeRunId : undefined,
  ].filter(identity);
  return ids.length && new Set(ids).size === 1 ? ids[0]! : null;
}

function preparedTree(
  input: RecordedEvidencePackageInput | undefined,
): RecipeInvocationTree | null {
  return isRecord(input?.recipeResolution) ? checkedTree(input.recipeResolution.flow) : null;
}

/** Resolve a recorded local next through the prepared edges, not a guessed path prefix. */
function decision(
  entry: unknown,
  node: RecipeInvocationNode | undefined,
  nodes: ReadonlyMap<string, RecipeInvocationNode>,
): RunEvidenceFlowDecision {
  if (!isRecord(entry)) return { case: null, next: null };
  const branch = typeof entry.case === 'string' ? entry.case : null;
  const edges = node
    ? [...new Set([node.next, node.default, ...Object.values(node.cases)].filter(identity))]
    : [];
  const recordedNext = typeof entry.next === 'string' ? entry.next : null;
  const matches =
    recordedNext === null
      ? []
      : edges.filter((id) => id === recordedNext || nodes.get(id)?.nodeId === recordedNext);
  const selected =
    branch !== null && node && Object.hasOwn(node.cases, branch) ? node.cases[branch] : undefined;
  return {
    case: branch,
    next: matches.length === 1 ? matches[0]! : recordedNext === null ? (selected ?? null) : null,
  };
}

function recordedStatus(entry: unknown): RunEvidenceFlowOccurrence['status'] {
  if (!isRecord(entry) || entry.status === 'unknown') return 'unknown';
  if (entry.status === 'pass' || entry.status === 'fail') return entry.status;
  return entry.ok === true ? 'pass' : entry.ok === false ? 'fail' : 'unknown';
}

/** One join over normalized occurrences per review model. No media or history I/O. */
export function projectRunEvidenceFlow(
  input: EvidenceReviewInput,
  context: FlowProjectionContext,
): {
  flow: RunEvidenceFlow | null;
  criterionOccurrences: ReadonlyMap<string, RunEvidenceFlowOccurrence[]>;
} {
  const pkg = input.package;
  const pending = pkg || !input.evidencePending ? undefined : input.pendingFlow;
  const rawTree = pkg && isRecord(pkg.recipeResolution) ? pkg.recipeResolution.flow : pending?.tree;
  const rawUpdate = pkg && isRecord(pkg.summary) ? pkg.summary.flow : pending?.update;
  const tree = checkedTree(rawTree);
  const update = isRecipeFlowUpdate(rawUpdate) ? rawUpdate : null;
  const recipeRunId = pkg
    ? packageIdentity(pkg)
    : input.ledger?.schemaVersion === 2 &&
        identity(input.ledger.recipeRunId) &&
        input.ledger.recipeRunId !== update?.recipeRunId
      ? null
      : (update?.recipeRunId ?? null);
  const compatible =
    context.valid &&
    tree &&
    update &&
    recipeRunId === update.recipeRunId &&
    tree.rootId === update.rootId &&
    (update.activeId === null || tree.nodes.some((node) => node.id === update.activeId));
  if ((rawTree !== undefined || rawUpdate !== undefined) && !compatible)
    context.warnings.push(
      'Prepared recipe flow is unavailable: incompatible tree, update or execution identity.',
    );
  const nodes = new Map((compatible ? tree.nodes : []).map((node) => [node.id, node]));
  const occurrences = new Map<number, RunEvidenceFlowOccurrence>();
  const byNode = new Map<string, RunEvidenceFlowOccurrence[]>();
  for (const occurrence of context.occurrences) {
    if (!recipeRunId) continue;
    const cue = context.occurrenceCue(occurrence.traceIndex);
    const node = nodes.get(occurrence.nodeId);
    const value: RunEvidenceFlowOccurrence = {
      recipeRunId,
      traceIndex: occurrence.traceIndex,
      invocationId: node?.id ?? null,
      status: recordedStatus(context.trace[occurrence.traceIndex]),
      decision: decision(context.trace[occurrence.traceIndex], node, nodes),
      claimIds: [...new Set(occurrence.proves.map(normalizeRecipeClaimId))],
      files: occurrence.artifacts.map(({ artifactPath, name, mediaType }) => ({
        path: artifactPath,
        name,
        mediaType,
      })),
      cue,
    };
    occurrences.set(value.traceIndex, value);
    if (node) {
      const list = byNode.get(node.id) ?? [];
      list.push(value);
      byNode.set(node.id, list);
    }
  }
  const criterionOccurrences = projectCriterionOccurrences(context, occurrences);
  if (!compatible) return { flow: null, criterionOccurrences };
  const ancestry = buildRecipeInvocationAncestry(tree);
  const choices = new Map<string, Set<string>>();
  for (const [id, list] of byNode) {
    const node = nodes.get(id)!;
    if (!Object.keys(node.cases).length || list.some((entry) => entry.decision.next === null))
      continue;
    choices.set(id, new Set(list.map((entry) => entry.decision.next!)));
  }
  const reachable = new Set<string>();
  const pendingIds = [tree.rootId];
  while (pendingIds.length) {
    const id = pendingIds.pop()!;
    if (reachable.has(id)) continue;
    reachable.add(id);
    const node = nodes.get(id)!;
    for (const target of [
      node.entry,
      node.teardown,
      ...(choices.get(id) ?? [node.next, node.default, ...Object.values(node.cases)]),
    ])
      if (target !== null) pendingIds.push(target);
  }
  const active = update.activeId === null ? undefined : ancestry.get(update.activeId);
  const activePath = new Set(active?.breadcrumbs.map(({ id }) => id) ?? []);
  const status = (node: RecipeInvocationNode): RunEvidenceFlowStatus => {
    const entries = byNode.get(node.id) ?? [];
    if (node.id === tree.rootId) {
      const value = pkg && isRecord(pkg.summary) ? pkg.summary.status : undefined;
      return value === 'pass' || value === 'fail' || value === 'unknown'
        ? value
        : update.activeId === null
          ? 'unknown'
          : 'running';
    }
    if (
      activePath.has(node.id) &&
      (!entries.length || update.progress.current > update.progress.completed)
    )
      return 'running';
    return entries.at(-1)?.status ?? (reachable.has(node.id) ? 'unknown' : 'skipped');
  };
  return {
    flow: {
      version: 1,
      recipeRunId: update.recipeRunId,
      rootId: tree.rootId,
      activeId: update.activeId,
      progress: { ...update.progress },
      nodes: tree.nodes.map((node) => ({
        ...structuredClone(node),
        depth: ancestry.get(node.id)!.depth,
        breadcrumbIds: ancestry.get(node.id)!.breadcrumbs.map(({ id }) => id),
        status: status(node),
        occurrences: byNode.get(node.id) ?? [],
      })),
    },
    criterionOccurrences,
  };
}

interface RetainedOccurrenceIndex {
  entries: readonly unknown[];
  nodes: ReadonlyMap<string, RecipeInvocationNode>;
  files: ReadonlyMap<number, ReadonlySet<string>>;
}

/** Index each selected original once, keeping its trace and file namespace together. */
function indexRetained(input: RecordedEvidencePackageInput): RetainedOccurrenceIndex {
  const entries = recipeTraceEntries(input.trace) ?? [];
  const nodes = new Map((preparedTree(input)?.nodes ?? []).map((node) => [node.id, node]));
  const refs = new Map<string, Set<number>>();
  const uniqueNodes = new Map<string, number | null>();
  entries.forEach((entry, index) => {
    if (!isRecord(entry) || !identity(entry.nodeId)) return;
    uniqueNodes.set(entry.nodeId, uniqueNodes.has(entry.nodeId) ? null : index);
    for (const artifact of Array.isArray(entry.artifacts) ? entry.artifacts : []) {
      if (!isRecord(artifact) || !identity(artifact.path)) continue;
      const indexes = refs.get(artifact.path) ?? new Set<number>();
      indexes.add(index);
      refs.set(artifact.path, indexes);
    }
  });
  const files = new Map<number, Set<string>>();
  const manifest =
    isRecord(input.manifest) && Array.isArray(input.manifest.artifacts)
      ? input.manifest.artifacts
      : [];
  for (const artifact of manifest) {
    if (!isRecord(artifact) || !identity(artifact.path)) continue;
    const recorded = isRecord(artifact.metadata) ? artifact.metadata.recordedEvidence : undefined;
    const indexes = isRecord(recorded)
      ? typeof recorded.traceIndex === 'number'
        ? [recorded.traceIndex]
        : []
      : [
          ...new Set([
            ...(refs.get(artifact.path) ?? []),
            ...(typeof artifact.nodeId === 'string' &&
            typeof uniqueNodes.get(artifact.nodeId) === 'number'
              ? [uniqueNodes.get(artifact.nodeId)!]
              : []),
          ]),
        ];
    for (const index of indexes) {
      if (index === null) continue;
      const paths = files.get(index) ?? new Set<string>();
      paths.add(artifact.path);
      files.set(index, paths);
    }
  }
  return { entries, nodes, files };
}

/** Retained bindings never consult the fresh execution's trace-index map. */
function projectCriterionOccurrences(
  context: FlowProjectionContext,
  current: ReadonlyMap<number, RunEvidenceFlowOccurrence>,
): ReadonlyMap<string, RunEvidenceFlowOccurrence[]> {
  const result = new Map<string, RunEvidenceFlowOccurrence[]>();
  if (!context.valid) return result;
  const byClaim = new Map<string, Set<number>>();
  for (const [index, occurrence] of current)
    for (const claim of occurrence.claimIds) {
      const indexes = byClaim.get(claim) ?? new Set<number>();
      indexes.add(index);
      byClaim.set(claim, indexes);
    }
  const sources = new Map<RecordedEvidencePackageInput, RetainedOccurrenceIndex>();
  for (const claim of context.claims) {
    const retained = context.retainedSources.get(claim.id);
    const indexes = new Set([
      ...(retained ? (claim.status?.assertionIndices ?? []) : (byClaim.get(claim.id) ?? [])),
      ...claim.occurrences.map(({ traceIndex }) => traceIndex),
      ...claim.moments.map(({ traceIndex }) => traceIndex),
    ]);
    const bindings: RunEvidenceFlowOccurrence[] = [];
    if (retained) {
      const recipeRunId = packageIdentity(retained.input);
      if (!recipeRunId) continue;
      const source = sources.get(retained.input) ?? indexRetained(retained.input);
      sources.set(retained.input, source);
      const files = new Map(claim.evidence.map((file) => [file.path, file]));
      const clips = new Map(
        claim.clips
          .filter((clip) => clip.moment?.recipeRunId === recipeRunId)
          .map((clip) => [clip.traceIndex, clip]),
      );
      for (const traceIndex of [...indexes].sort((a, b) => a - b)) {
        const entry = source.entries[traceIndex];
        if (!isRecord(entry) || !identity(entry.nodeId)) continue;
        const node = source.nodes.get(entry.nodeId);
        const clip = clips.get(traceIndex);
        const startMs = clip ? context.markerSeekMs(clip.videoPath, traceIndex, 'start') : null;
        const endMs = clip ? context.markerSeekMs(clip.videoPath, traceIndex, 'end') : null;
        const paths = source.files.get(traceIndex) ?? new Set<string>();
        bindings.push({
          recipeRunId,
          traceIndex,
          invocationId: node?.id ?? null,
          status: recordedStatus(entry),
          decision: decision(entry, node, source.nodes),
          claimIds: [claim.id],
          files: [...paths].flatMap((path) => {
            const file = files.get(`${retained.prefix}${path}`);
            return file
              ? [{ path: file.artifactPath, name: file.name, mediaType: file.mediaType }]
              : [];
          }),
          cue:
            clip && startMs !== null && endMs !== null
              ? { videoPath: context.artifactPath(clip.videoPath), startMs, endMs }
              : null,
        });
      }
    } else
      for (const index of [...indexes].sort((a, b) => a - b)) {
        const occurrence = current.get(index);
        if (occurrence)
          bindings.push({
            ...structuredClone(occurrence),
            claimIds: [...new Set([...occurrence.claimIds, claim.id])],
          });
      }
    result.set(claim.id, bindings);
  }
  return result;
}
