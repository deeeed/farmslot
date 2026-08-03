// planning-context.ts — bounded related-work brief for worker and reviewer tasks.
//
// The section names refs, labels, statuses, and spec paths so an agent can read
// the related work by path. It never inlines related spec bodies, and it states
// which relations gate the scheduler (active WorkGraph edges) and which are
// context only.

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  PLANNING_CONTEXT_MAX_RELATIONS,
  type PlanningContextProjection,
  type PlanningRelation,
  type Run,
  summarizeRoadmapDelivery,
} from '@farmslot/protocol';

import { getBacklogItemSnapshot, listBacklogItems } from '../backlog/store.js';
import {
  buildPlanningContextProjection,
  buildRoadmapDeliveryProjection,
  buildRunIndexByBacklogItem,
} from '../roadmap/delivery-projection.js';
import { findRoadmapItemById, loadWorkGraphSnapshot } from '../roadmap/store.js';
import { getAllRuns, getArchivedRuns } from '../runs/store.js';

export const PLANNING_CONTEXT_INPUT = 'inputs/planning-context.json';

export const PLANNING_CONTEXT_HEADING = '## Related planning context';

function relationLine(relation: PlanningRelation): string {
  const target = relation.targetRef ?? relation.targetId;
  const title = relation.targetTitle ? ` — ${relation.targetTitle}` : '';
  const status = relation.targetStatus ? ` · status ${relation.targetStatus}` : '';
  const spec = relation.specPath
    ? ` · spec ${relation.specPath}`
    : relation.targetUrl
      ? ` · ${relation.targetUrl}`
      : '';
  const authority = relation.schedulerAuthority
    ? 'scheduler authority'
    : 'context only (no scheduler authority)';
  return `- \`${relation.label}\` ${target}${title}${status}${spec} · ${authority} · ${relation.reason}`;
}

function relationGroup(
  relations: readonly PlanningRelation[],
  direction: PlanningRelation['direction'],
  heading: string,
): string[] {
  const rows = relations.filter((relation) => relation.direction === direction);
  return [`### ${heading}`, ...(rows.length ? rows.map(relationLine) : ['- None'])];
}

/**
 * Renders the frozen snapshot. Pure so both the worker task writer and the
 * independent-review brief render byte-identical content from the same artifact.
 */
export function buildPlanningContextSection(
  taskDir: string,
  projection: PlanningContextProjection | null,
  emptyReason = 'this run is not linked to a backlog item',
): string {
  if (!projection) {
    return [
      '',
      '---',
      '',
      PLANNING_CONTEXT_HEADING,
      '',
      `- No related planning context: ${emptyReason}.`,
    ].join('\n');
  }

  const header = [
    `- Snapshot hash: ${projection.snapshotHash}`,
    `- Generated at: ${projection.generatedAt}`,
    `- Snapshot artifact: ${taskDir}/${PLANNING_CONTEXT_INPUT}`,
    projection.roadmapItemId
      ? `- Roadmap parent: ${projection.roadmapItemId} — ${projection.roadmapTitle ?? 'untitled'} (stage ${projection.roadmapStage ?? 'unknown'}, spec ${projection.roadmapSpecPath ?? 'none'})`
      : '- Roadmap parent: none',
    projection.workGraphId
      ? `- WorkGraph: ${projection.workGraphId} node ${projection.workNodeId}`
      : '- WorkGraph: not graph-linked',
    projection.delivery
      ? `- Roadmap delivery: ${projection.delivery.status} (${projection.delivery.deliveredBacklogItemCount}/${projection.delivery.backlogItemCount} backlog items delivered, ${projection.delivery.prCount} PR(s), ${projection.delivery.findingCount} finding(s))`
      : '- Roadmap delivery: not applicable',
  ];

  // Truncation is a rendering concern: the brief stays bounded while the frozen
  // artifact keeps every relation, so "read the full set from the snapshot" is true.
  const rendered = projection.relations.slice(0, PLANNING_CONTEXT_MAX_RELATIONS);
  const omitted = projection.relations.length - rendered.length;
  const body = rendered.length
    ? [
        ...relationGroup(rendered, 'upstream', 'Upstream'),
        '',
        ...relationGroup(rendered, 'downstream', 'Downstream'),
        '',
        ...relationGroup(rendered, 'sibling', 'Siblings'),
      ]
    : ['### Related work', '- None: this backlog item has no roadmap or WorkGraph relations.'];

  const truncation =
    omitted > 0
      ? [
          '',
          `_${omitted} of ${projection.relations.length} relations omitted here to keep this brief bounded._`,
          `_The snapshot artifact above holds all ${projection.relations.length}._`,
        ]
      : [];

  return [
    '',
    '---',
    '',
    PLANNING_CONTEXT_HEADING,
    '',
    ...header,
    '',
    ...body,
    ...truncation,
    '',
    'Read related work by the listed spec paths. Only relations marked `scheduler authority`',
    'gate execution; everything else is context. Do not copy related spec bodies into this task.',
  ].join('\n');
}

/**
 * Resolves the live projection for a run's backlog item. Returns null for runs
 * with no backlog linkage — an explicit empty state, not a silent omission.
 */
export async function resolveRunPlanningContext(
  run: Pick<Run, 'backlogItemId'>,
): Promise<PlanningContextProjection | null> {
  if (!run.backlogItemId) return null;
  const backlogItem = getBacklogItemSnapshot(run.backlogItemId);
  if (!backlogItem) return null;

  const backlogItems = listBacklogItems({ includeArchived: true }).items;
  // A stale roadmapItemId means "no parent" for briefing purposes; the roadmap
  // delivery projection is where that dangling link is reported as a finding.
  const roadmapItem = backlogItem.roadmapItemId
    ? ((await findRoadmapItemById(backlogItem.roadmapItemId)) ?? undefined)
    : undefined;
  const graph = backlogItem.workGraphId
    ? loadWorkGraphSnapshot(backlogItem.workGraphId)
    : undefined;
  const delivery = roadmapItem
    ? summarizeRoadmapDelivery(
        buildRoadmapDeliveryProjection({
          item: roadmapItem,
          backlogItems,
          // Live plus archived, matching the roadmap store: a frozen snapshot that
          // omitted archived attempts would report different delivery counts — and a
          // different hash — than the projection it is supposed to mirror.
          runsByBacklogItemId: buildRunIndexByBacklogItem([
            ...getAllRuns(),
            ...(await getArchivedRuns()),
          ]),
          generatedAt: new Date().toISOString(),
        }),
      )
    : undefined;

  return buildPlanningContextProjection({
    backlogItem,
    ...(roadmapItem ? { roadmapItem } : {}),
    backlogItems,
    ...(graph ? { graph } : {}),
    ...(delivery ? { delivery } : {}),
    generatedAt: new Date().toISOString(),
  });
}

/** Freezes the projection next to the task so the reviewer brief reuses it verbatim. */
export async function writePlanningContextInput(
  taskAbsDir: string,
  projection: PlanningContextProjection,
): Promise<void> {
  const target = path.join(taskAbsDir, PLANNING_CONTEXT_INPUT);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(projection, null, 2)}\n`, 'utf-8');
}
