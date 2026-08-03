// delivery-projection.ts — pure derivation of roadmap delivery lineage and planning context.
//
// `BacklogItem.roadmapItemId` is the canonical live relationship; `RoadmapItem.promotion`
// is promotion provenance. Both are unioned here so a manually backlinked item is never
// invisible, and disagreements surface as findings instead of failing `roadmap.get`.
// Every function in this module is pure: callers supply the full backlog list and a
// run index, so the projection never depends on a paginated client cache.

import { createHash } from 'node:crypto';

import {
  type BacklogItem,
  githubPullUrl,
  isSchedulerAuthoritativeGraph,
  parseGitHubPullUrl,
  parseGitHubRef,
  type PlanningContextProjection,
  type PlanningRelation,
  type PlanningRelationLabel,
  type RoadmapDeliveryBacklogRef,
  type RoadmapDeliveryFinding,
  type RoadmapDeliveryLinkSource,
  type RoadmapDeliveryProjection,
  type RoadmapDeliveryPrRef,
  type RoadmapDeliveryPrSource,
  type RoadmapDeliveryRunRef,
  type RoadmapDeliveryStatus,
  type RoadmapDeliverySummary,
  type RoadmapItem,
  type Run,
  type WorkEdge,
  type WorkGraphSnapshot,
  type WorkNode,
} from '@farmslot/protocol';

/** Planning stages that still imply unfinished discovery once work has shipped. */
const UNFINISHED_DISCOVERY_STAGES = new Set<RoadmapItem['stage']>(['rough', 'refining', 'refined']);

/** Backlog statuses that mean execution is under way but not finished. */
const IN_FLIGHT_BACKLOG_STATUSES = new Set<BacklogItem['status']>([
  'queued',
  'dispatching',
  'running',
  'needs-attention',
  'failed',
]);

/**
 * Index backlog items by the roadmap item they claim. Built once per request for
 * the same reason as the run index: without it, a roadmap list with N rows scans
 * the whole backlog N times.
 */
export function buildBacklogIndexByRoadmapItem(
  backlogItems: readonly BacklogItem[],
): Map<string, BacklogItem[]> {
  const index = new Map<string, BacklogItem[]>();
  for (const backlogItem of backlogItems) {
    if (!backlogItem.roadmapItemId) continue;
    const bucket = index.get(backlogItem.roadmapItemId);
    if (bucket) bucket.push(backlogItem);
    else index.set(backlogItem.roadmapItemId, [backlogItem]);
  }
  return index;
}

/**
 * Index every run by the backlog item it carried. Built once per request so a
 * roadmap list with N rows does not scan the whole run store N times.
 */
export function buildRunIndexByBacklogItem(runs: readonly Run[]): Map<string, Run[]> {
  const index = new Map<string, Run[]>();
  for (const run of runs) {
    if (!run.backlogItemId) continue;
    const bucket = index.get(run.backlogItemId);
    if (bucket) bucket.push(run);
    else index.set(run.backlogItemId, [run]);
  }
  for (const bucket of index.values()) {
    bucket.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  return index;
}

function runFamiliesFor(runs: readonly Run[]): RoadmapDeliveryRunRef[] {
  const byFamily = new Map<string, Run[]>();
  for (const run of runs) {
    const bucket = byFamily.get(run.familyId);
    if (bucket) bucket.push(run);
    else byFamily.set(run.familyId, [run]);
  }
  return [...byFamily.entries()]
    .map(([familyId, familyRuns]) => {
      const ordered = [...familyRuns].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      const latest = ordered[0];
      // Archived runs are lineage-readable but absent from run.list/run.get, so
      // flag families clients cannot navigate to.
      const archivedOnly = ordered.every((run) => Boolean(run.archivedAt));
      return {
        familyId,
        runIds: ordered.map((run) => run.id),
        latestRunId: latest.id,
        latestStatus: latest.status,
        latestUpdatedAt: latest.updatedAt,
        ...(archivedOnly ? { archivedOnly: true } : {}),
      };
    })
    .sort((a, b) => b.latestUpdatedAt.localeCompare(a.latestUpdatedAt));
}

interface RawPrRef {
  ref: string;
  url?: string;
  source: RoadmapDeliveryPrSource;
}

/**
 * Merge raw references into one entry per PR.
 *
 * `foldBareNumbers` is only safe within a single backlog item's own evidence, where
 * a repo-less `Run.prNumber` and a qualified `Run.links` entry plausibly describe
 * the same pull request. Across backlog items they do not: backlog A's bare `#421`
 * and backlog B's `acme/repo#421` are different evidence, and folding them
 * attributes A's delivery to B's repository and undercounts multi-PR work.
 */
function dedupePrRefs(
  raw: readonly RawPrRef[],
  { foldBareNumbers }: { foldBareNumbers: boolean },
): RoadmapDeliveryPrRef[] {
  const byKey = new Map<string, RoadmapDeliveryPrRef>();
  const order: RoadmapDeliveryPrRef[] = [];

  const merge = (key: string, entry: RawPrRef) => {
    const existing = byKey.get(key);
    if (!existing) {
      const created: RoadmapDeliveryPrRef = {
        ref: entry.ref,
        ...(entry.url ? { url: entry.url } : {}),
        sources: [entry.source],
      };
      byKey.set(key, created);
      order.push(created);
      return;
    }
    if (!existing.url && entry.url) existing.url = entry.url;
    if (!existing.sources.includes(entry.source)) existing.sources.push(entry.source);
  };

  // Qualified `owner/repo#n` first, so a repo-less `#n` from Run.prNumber folds
  // into it instead of creating a second row for the same pull request.
  const qualified = raw.filter((entry) => parseGitHubRef(entry.ref));
  const unqualified = raw.filter((entry) => !parseGitHubRef(entry.ref));
  for (const entry of qualified) merge(parseGitHubRef(entry.ref)!.ref, entry);
  for (const entry of unqualified) {
    const number = Number(entry.ref.replace(/^#/, ''));
    const matches =
      foldBareNumbers && Number.isFinite(number)
        ? order.filter((candidate) => parseGitHubRef(candidate.ref)?.number === number)
        : [];
    // Fold only when the target is unambiguous. Two repos can each have a PR
    // #421; attaching the bare number to whichever was seen first would assert a
    // repo we do not actually know.
    const qualifiedMatch = matches.length === 1 ? matches[0] : undefined;
    merge(qualifiedMatch ? parseGitHubRef(qualifiedMatch.ref)!.ref : entry.ref, entry);
  }

  return order;
}

function prRefsForBacklogItem(
  backlogItem: BacklogItem | undefined,
  runs: readonly Run[],
): RoadmapDeliveryPrRef[] {
  const raw: RawPrRef[] = [];
  for (const run of runs) {
    const linkRefs = (run.links ?? []).flatMap((link) => {
      const parsed = parseGitHubPullUrl(link.url);
      return parsed ? [{ ref: parsed.ref, url: link.url, source: 'run-link' as const }] : [];
    });
    raw.push(...linkRefs);
    if (run.prNumber != null) {
      // Only attribute the bare `prNumber` to a repo the run unambiguously points
      // at. A run linking two repos gives no basis for choosing one, so the number
      // stays unqualified rather than asserting a repo we do not know.
      const linkRepos = new Set(
        linkRefs.map((entry) => parseGitHubRef(entry.ref)?.repo).filter(Boolean),
      );
      const repo = linkRepos.size === 1 ? [...linkRepos][0] : parseGitHubRef(run.ticketOrPr)?.repo;
      raw.push(
        repo
          ? {
              ref: `${repo}#${run.prNumber}`,
              url: githubPullUrl({ repo, number: run.prNumber }),
              source: 'run-pr-number',
            }
          : { ref: `#${run.prNumber}`, source: 'run-pr-number' },
      );
    }
  }
  const shippedRef = backlogItem?.shipped?.prRef;
  if (shippedRef) {
    const parsed = parseGitHubRef(shippedRef);
    raw.push(
      parsed
        ? { ref: parsed.ref, url: githubPullUrl(parsed), source: 'backlog-shipped' }
        : { ref: shippedRef, source: 'backlog-shipped' },
    );
  }
  // Within one backlog item, a bare prNumber and a qualified link are the same PR.
  return dedupePrRefs(raw, { foldBareNumbers: true });
}

/**
 * Archiving rewrites `done` to `archived`, so status alone forgets that the work
 * shipped. `lastObservedRunStatus` is the surviving evidence; without it a
 * roadmap item whose backlog was completed and then tidied away reads as if it
 * had never started — the exact drift this projection exists to surface.
 */
function isDelivered(backlogItem: BacklogItem): boolean {
  if (backlogItem.shipped) return true;
  if (backlogItem.status === 'done') return true;
  return backlogItem.status === 'archived' && backlogItem.lastObservedRunStatus === 'done';
}

export interface RoadmapDeliveryProjectionInput {
  item: Pick<RoadmapItem, 'id' | 'stage' | 'promotion'>;
  /** Complete backlog store contents, including archived items. */
  backlogItems: readonly BacklogItem[];
  runsByBacklogItemId: ReadonlyMap<string, Run[]>;
  /** Optional prebuilt indexes; derived from `backlogItems` when omitted. */
  backlogByRoadmapItemId?: ReadonlyMap<string, BacklogItem[]>;
  backlogById?: ReadonlyMap<string, BacklogItem>;
  generatedAt: string;
}

export function buildRoadmapDeliveryProjection(
  input: RoadmapDeliveryProjectionInput,
): RoadmapDeliveryProjection {
  const { item, backlogItems, runsByBacklogItemId, generatedAt } = input;
  const backlogByRoadmapItemId =
    input.backlogByRoadmapItemId ?? buildBacklogIndexByRoadmapItem(backlogItems);
  // Reuse the caller's id index when supplied: rebuilding it per roadmap row is
  // the remaining O(roadmap x backlog) path on `roadmap.list`.
  const byId = input.backlogById ?? new Map(backlogItems.map((entry) => [entry.id, entry]));
  const findings: RoadmapDeliveryFinding[] = [];

  const promotionIds: string[] = [];
  for (const entry of item.promotion ?? []) {
    if (!entry.backlogItemId) continue;
    if (!promotionIds.includes(entry.backlogItemId)) promotionIds.push(entry.backlogItemId);
  }
  const canonicalIds = (backlogByRoadmapItemId.get(item.id) ?? []).map(
    (backlogItem) => backlogItem.id,
  );

  const linkSources = new Map<string, RoadmapDeliveryLinkSource>();
  for (const id of promotionIds) linkSources.set(id, 'promotion');
  for (const id of canonicalIds) {
    linkSources.set(id, linkSources.has(id) ? 'both' : 'backlog');
  }

  for (const id of promotionIds) {
    const backlogItem = byId.get(id);
    if (!backlogItem) {
      findings.push({
        code: 'promotion-backlog-missing',
        backlogItemId: id,
        detail: `Promotion provenance references backlog item ${id}, which no longer exists.`,
        remediation: `Remove the stale promotion entry for ${id} from ${item.id}, or restore the backlog item.`,
      });
      continue;
    }
    if (backlogItem.roadmapItemId !== item.id) {
      findings.push({
        code: 'promotion-roadmap-mismatch',
        backlogItemId: id,
        detail: backlogItem.roadmapItemId
          ? `Backlog item ${id} was promoted from ${item.id} but now carries roadmapItemId ${backlogItem.roadmapItemId}.`
          : `Backlog item ${id} was promoted from ${item.id} but carries no roadmapItemId.`,
        remediation: `Set roadmapItemId on ${id} to the roadmap item that owns it, or drop the promotion entry from ${item.id}.`,
      });
    }
  }
  for (const id of canonicalIds) {
    if (promotionIds.includes(id)) continue;
    findings.push({
      code: 'backlog-link-not-in-promotion',
      backlogItemId: id,
      detail: `Backlog item ${id} links to ${item.id} through roadmapItemId with no matching promotion provenance.`,
      remediation: `Treat the backlog link as canonical; add a promotion entry to ${item.id} only if the provenance record matters.`,
    });
  }

  const backlogRefs: RoadmapDeliveryBacklogRef[] = [...linkSources.entries()].map(
    ([id, linkSource]) => {
      const backlogItem = byId.get(id);
      const runs = runsByBacklogItemId.get(id) ?? [];
      const base = {
        backlogItemId: id,
        linkSource,
        runFamilies: runFamiliesFor(runs),
        prs: prRefsForBacklogItem(backlogItem, runs),
      };
      if (!backlogItem) {
        return { ...base, archived: false, delivered: false, resolved: false };
      }
      return {
        ...base,
        ref: backlogItem.sourceRef,
        title: backlogItem.title,
        project: backlogItem.project,
        status: backlogItem.status,
        ...(backlogItem.specPath ? { specPath: backlogItem.specPath } : {}),
        archived: backlogItem.status === 'archived',
        delivered: isDelivered(backlogItem),
        resolved: true,
        ...(backlogItem.shipped ? { shippedAt: backlogItem.shipped.closedAt } : {}),
      };
    },
  );

  const status = deriveDeliveryStatus(backlogRefs, byId, findings);

  if (status === 'delivered' && UNFINISHED_DISCOVERY_STAGES.has(item.stage)) {
    findings.push({
      code: 'planning-stage-behind-delivery',
      detail: `Delivery is complete but the authored planning stage is still '${item.stage}'.`,
      remediation: `Edit ${item.id} to stage 'promoted' or 'archived' once the outcome is reviewed; the gateway does not rewrite roadmap markdown.`,
    });
  }

  return {
    roadmapItemId: item.id,
    status,
    backlogItems: backlogRefs,
    runFamilies: dedupeRunFamilies(backlogRefs),
    // Across backlog items, identical refs merge but bare numbers never absorb a
    // qualified ref from a different item — that would forge provenance.
    prs: dedupePrRefs(
      backlogRefs.flatMap((entry) =>
        entry.prs.flatMap((pr) =>
          pr.sources.map((source) => ({
            ref: pr.ref,
            ...(pr.url ? { url: pr.url } : {}),
            source,
          })),
        ),
      ),
      { foldBareNumbers: false },
    ),
    findings,
    generatedAt,
  };
}

function dedupeRunFamilies(refs: readonly RoadmapDeliveryBacklogRef[]): RoadmapDeliveryRunRef[] {
  const byFamily = new Map<string, RoadmapDeliveryRunRef>();
  for (const entry of refs) {
    for (const family of entry.runFamilies) {
      const existing = byFamily.get(family.familyId);
      if (!existing) {
        byFamily.set(family.familyId, { ...family, runIds: [...family.runIds] });
        continue;
      }
      for (const runId of family.runIds) {
        if (!existing.runIds.includes(runId)) existing.runIds.push(runId);
      }
      if (family.latestUpdatedAt > existing.latestUpdatedAt) {
        existing.latestRunId = family.latestRunId;
        existing.latestStatus = family.latestStatus;
        existing.latestUpdatedAt = family.latestUpdatedAt;
      }
      // Reachable if any contributing view had a live run.
      if (!family.archivedOnly) delete existing.archivedOnly;
    }
  }
  return [...byFamily.values()].sort((a, b) => b.latestUpdatedAt.localeCompare(a.latestUpdatedAt));
}

function deriveDeliveryStatus(
  refs: readonly RoadmapDeliveryBacklogRef[],
  byId: ReadonlyMap<string, BacklogItem>,
  findings: readonly RoadmapDeliveryFinding[],
): RoadmapDeliveryStatus {
  // Lineage the projection cannot trust is reported as inconsistent. A canonical
  // backlog link missing from promotion provenance is not that case: the link
  // itself is valid, so those items still report real delivery.
  const untrustworthy = findings.some(
    (finding) =>
      finding.code === 'promotion-backlog-missing' || finding.code === 'promotion-roadmap-mismatch',
  );
  if (untrustworthy) return 'inconsistent';

  const resolved = refs.filter((entry) => entry.resolved);
  const considered = resolved.filter((entry) => !entry.archived);
  // Archived work that shipped is still shipped. It is excluded from the "is
  // everything finished" question, but it still counts as delivery having happened.
  const archivedDelivered = resolved.some((entry) => entry.archived && entry.delivered);
  if (considered.length === 0) return archivedDelivered ? 'delivered' : 'unstarted';

  const deliveredCount = considered.filter((entry) => entry.delivered).length;
  if (deliveredCount === considered.length) return 'delivered';
  if (deliveredCount > 0 || archivedDelivered) return 'partial';

  const active = considered.some((entry) => {
    if (entry.runFamilies.length > 0) return true;
    const backlogItem = byId.get(entry.backlogItemId);
    return backlogItem ? IN_FLIGHT_BACKLOG_STATUSES.has(backlogItem.status) : false;
  });
  return active ? 'active' : 'unstarted';
}

// ─── Planning context ───

function edgeRelationLabel(
  edge: WorkEdge,
  direction: 'upstream' | 'downstream',
): PlanningRelationLabel {
  if (edge.unlock.kind === 'rebase-onto') return 'follow-up';
  if (edge.blocks === 'completion') return 'composes-with';
  return direction === 'upstream' ? 'depends-on' : 'blocks';
}

function nodeRelationTarget(
  node: WorkNode,
  backlogById: ReadonlyMap<string, BacklogItem>,
): Pick<
  PlanningRelation,
  | 'targetKind'
  | 'targetId'
  | 'targetRef'
  | 'targetTitle'
  | 'targetStatus'
  | 'specPath'
  | 'targetUrl'
> {
  if (node.kind === 'reference' && node.reference) {
    return {
      targetKind: 'reference',
      targetId: node.id,
      targetRef: node.reference.ref,
      targetTitle: node.reference.title,
      targetStatus: node.reference.status,
      ...(node.reference.url ? { targetUrl: node.reference.url } : {}),
    };
  }
  const backlogItem = node.backlogItemId ? backlogById.get(node.backlogItemId) : undefined;
  return {
    targetKind: 'backlog',
    targetId: node.backlogItemId ?? node.id,
    ...(backlogItem?.sourceRef ? { targetRef: backlogItem.sourceRef } : {}),
    ...(backlogItem?.title ? { targetTitle: backlogItem.title } : {}),
    ...(backlogItem?.status ? { targetStatus: backlogItem.status } : {}),
    ...(backlogItem?.specPath ? { specPath: backlogItem.specPath } : {}),
  };
}

export interface PlanningContextInput {
  /** The backlog item the brief is being written for, when the run has one. */
  backlogItem?: BacklogItem;
  /** Roadmap parent resolved from `backlogItem.roadmapItemId`. */
  roadmapItem?: RoadmapItem;
  /** Complete backlog store contents, used for promoted siblings and node titles. */
  backlogItems: readonly BacklogItem[];
  /** WorkGraph the backlog item belongs to, when graph-linked. */
  graph?: WorkGraphSnapshot;
  delivery?: RoadmapDeliverySummary;
  generatedAt: string;
}

/**
 * Bounded related-work snapshot: refs, labels, status, and spec paths — never
 * the related specs themselves. Only edges of an active WorkGraph are marked as
 * carrying scheduler authority (ADR-040); everything else is context.
 */
export function buildPlanningContextProjection(
  input: PlanningContextInput,
): PlanningContextProjection {
  const { backlogItem, roadmapItem, backlogItems, graph, delivery, generatedAt } = input;
  const backlogById = new Map(backlogItems.map((entry) => [entry.id, entry]));
  const relations: PlanningRelation[] = [];

  if (roadmapItem) {
    relations.push({
      label: 'parent-roadmap',
      direction: 'upstream',
      targetKind: 'roadmap',
      targetId: roadmapItem.id,
      targetRef: roadmapItem.id,
      targetTitle: roadmapItem.title,
      targetStatus: roadmapItem.stage,
      specPath: roadmapItem.filePath,
      source: 'roadmap-promotion',
      schedulerAuthority: false,
      reason: 'Roadmap parent of this backlog item.',
    });
    for (const sibling of backlogItems) {
      if (sibling.roadmapItemId !== roadmapItem.id) continue;
      if (sibling.id === backlogItem?.id) continue;
      relations.push({
        label: 'promoted-sibling',
        direction: 'sibling',
        targetKind: 'backlog',
        targetId: sibling.id,
        targetRef: sibling.sourceRef,
        targetTitle: sibling.title,
        targetStatus: sibling.status,
        ...(sibling.specPath ? { specPath: sibling.specPath } : {}),
        source: 'roadmap-promotion',
        schedulerAuthority: false,
        reason: `Shares roadmap parent ${roadmapItem.id}.`,
      });
    }
  }

  const node = graph?.nodes.find(
    (candidate) =>
      candidate.id === backlogItem?.workNodeId ||
      (backlogItem?.id != null && candidate.backlogItemId === backlogItem.id),
  );
  if (graph && node) {
    const nodeById = new Map(graph.nodes.map((entry) => [entry.id, entry]));
    const schedulerActive = isSchedulerAuthoritativeGraph(graph.graph.status);
    for (const edge of graph.edges) {
      const direction =
        edge.toNodeId === node.id ? 'upstream' : edge.fromNodeId === node.id ? 'downstream' : null;
      if (!direction) continue;
      const other = nodeById.get(direction === 'upstream' ? edge.fromNodeId : edge.toNodeId);
      if (!other) continue;
      relations.push({
        label: edgeRelationLabel(edge, direction),
        direction,
        ...nodeRelationTarget(other, backlogById),
        source: other.kind === 'reference' ? 'work-graph-reference' : 'work-graph-edge',
        schedulerAuthority: schedulerActive && edge.required,
        reason: `WorkGraph edge ${edge.id} (${edge.condition.kind}, blocks ${edge.blocks ?? 'start'}, status ${edge.status}).`,
      });
    }
    for (const familyId of node.supersededFamilyIds ?? []) {
      const superseded = graph.nodes.find(
        (candidate) => candidate.id !== node.id && candidate.currentFamilyId === familyId,
      );
      if (!superseded) continue;
      relations.push({
        label: 'supersedes',
        direction: 'sibling',
        ...nodeRelationTarget(superseded, backlogById),
        source: 'work-graph-edge',
        schedulerAuthority: false,
        reason: `Supersedes run family ${familyId}.`,
      });
    }
  }

  // Order upstream-first (prerequisites gate the work), then downstream, then
  // siblings, so a renderer that must truncate drops the least actionable tail.
  // The projection itself keeps every relation: it is the frozen artifact a
  // reviewer diffs, and a hash over a truncated set could not detect a changed
  // prerequisite that fell outside the cap.
  const priority: Record<PlanningRelation['direction'], number> = {
    upstream: 0,
    downstream: 1,
    sibling: 2,
  };
  const ordered = [...relations].sort(
    (a, b) =>
      priority[a.direction] - priority[b.direction] ||
      Number(b.schedulerAuthority) - Number(a.schedulerAuthority),
  );

  const projection: Omit<PlanningContextProjection, 'snapshotHash'> = {
    ...(backlogItem ? { backlogItemId: backlogItem.id } : {}),
    ...(roadmapItem
      ? {
          roadmapItemId: roadmapItem.id,
          roadmapTitle: roadmapItem.title,
          roadmapSpecPath: roadmapItem.filePath,
          roadmapStage: roadmapItem.stage,
        }
      : {}),
    ...(node ? { workGraphId: node.graphId, workNodeId: node.id } : {}),
    ...(delivery ? { delivery } : {}),
    relations: ordered,
    generatedAt,
  };
  return { ...projection, snapshotHash: planningContextSnapshotHash(projection) };
}

/**
 * Content hash of everything except `generatedAt`, so the worker brief and the
 * reviewer brief quote the same value while the timestamps differ.
 */
export function planningContextSnapshotHash(
  projection: Omit<PlanningContextProjection, 'snapshotHash'> & { snapshotHash?: string },
): string {
  const { generatedAt: _generatedAt, snapshotHash: _snapshotHash, ...content } = projection;
  return createHash('sha256').update(JSON.stringify(content)).digest('hex').slice(0, 16);
}
