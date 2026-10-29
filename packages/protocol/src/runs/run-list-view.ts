import {
  type FlowType,
  isActiveListRun,
  isTerminalRunStatus,
  normalizeRunTags,
  type Run,
  type RunLane,
  type RunStatus,
} from '../contracts/runs.js';
import type { SlotStatus } from '../contracts/slots.js';

import { runLinkedTicketRefs } from './linked-tickets.js';
import type { RunListProjection } from './run-list-filter.js';
import { resolveRunSlotId } from './slot-resolution.js';

/** `active` follows `isActiveListRun`, `history` keeps terminal runs, `all` keeps every run. */
export type RunListScope = 'active' | 'history' | 'all';

export interface RunListQuery {
  scope: RunListScope;
  projects?: readonly string[];
  machines?: readonly string[];
  /** Fleet slot to machine. A slot missing here matches a machine by its `<machine>-` prefix. */
  slotMachines?: ReadonlyMap<string, string>;
  status?: RunStatus;
  flow?: FlowType;
  lane?: RunLane;
  tag?: string;
  search?: string;
}

/**
 * The runs a run list shows, in input order. Command Center and Companion both list through this.
 * A version-list projection selects exactly as the run it was made from.
 */
export function selectRunList<R extends Run | RunListProjection>(
  runs: readonly R[],
  query: RunListQuery,
): R[] {
  const [tag] = normalizeRunTags(query.tag ? [query.tag] : []);
  const search = query.search?.trim().toLowerCase();
  return runs.filter(
    (run: Run | RunListProjection) =>
      inScope(run, query.scope) &&
      (!query.projects?.length || query.projects.includes(run.project)) &&
      (!query.machines?.length || onMachines(run, query.machines, query.slotMachines)) &&
      (!query.status || run.status === query.status) &&
      (!query.flow || run.flowType === query.flow) &&
      (!query.lane || run.lane === query.lane) &&
      (!tag || normalizeRunTags(run.tags).includes(tag)) &&
      (!search || matchesSearch(run, search)),
  );
}

/** The `slotMachines` map for a fleet snapshot. */
export function slotMachineMap(
  slots: readonly Pick<SlotStatus, 'slot' | 'machine'>[],
): Map<string, string> {
  return new Map(slots.map((slot) => [slot.slot, slot.machine]));
}

/** Incoming runs replace stored runs with the same id; newest first. */
export function mergeRunsById(existing: readonly Run[], incoming: readonly Run[]): Run[] {
  const byId = new Map(existing.map((run) => [run.id, run]));
  for (const run of incoming) byId.set(run.id, run);
  return [...byId.values()].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

function slotOf(run: Run | RunListProjection): string | null {
  return 'projected' in run ? run.slotId : resolveRunSlotId(run);
}

function inScope(run: Run | RunListProjection, scope: RunListScope): boolean {
  if (scope === 'active') return isActiveListRun(run);
  if (scope === 'history') return isTerminalRunStatus(run.status);
  return true;
}

function onMachines(
  run: Run | RunListProjection,
  machines: readonly string[],
  slotMachines: ReadonlyMap<string, string> | undefined,
): boolean {
  const slotId = slotOf(run);
  if (!slotId) return false;
  const machine = slotMachines?.get(slotId);
  if (machine) return machines.includes(machine);
  return machines.some((name) => slotId === name || slotId.startsWith(`${name}-`));
}

function matchesSearch(run: Run | RunListProjection, search: string): boolean {
  return [
    run.ticketOrPr,
    run.summary,
    ...('projected' in run ? run.linkedTicketRefs : runLinkedTicketRefs(run)),
    slotOf(run),
    run.metrics.disposition?.replace(/_/g, ' '),
    ...(run.tags ?? []),
  ].some((value) => value?.toLowerCase().includes(search));
}
