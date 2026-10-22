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

/** The runs a run list shows, in input order. Command Center and Companion both list through this. */
export function selectRunList(runs: readonly Run[], query: RunListQuery): Run[] {
  const [tag] = normalizeRunTags(query.tag ? [query.tag] : []);
  const search = query.search?.trim().toLowerCase();
  return runs.filter(
    (run) =>
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

function inScope(run: Run, scope: RunListScope): boolean {
  if (scope === 'active') return isActiveListRun(run);
  if (scope === 'history') return isTerminalRunStatus(run.status);
  return true;
}

function onMachines(
  run: Run,
  machines: readonly string[],
  slotMachines: ReadonlyMap<string, string> | undefined,
): boolean {
  const slotId = resolveRunSlotId(run);
  if (!slotId) return false;
  const machine = slotMachines?.get(slotId);
  if (machine) return machines.includes(machine);
  return machines.some((name) => slotId === name || slotId.startsWith(`${name}-`));
}

function matchesSearch(run: Run, search: string): boolean {
  return [
    run.ticketOrPr,
    run.summary,
    ...runLinkedTicketRefs(run),
    resolveRunSlotId(run),
    run.metrics.disposition?.replace(/_/g, ' '),
    ...(run.tags ?? []),
  ].some((value) => value?.toLowerCase().includes(search));
}
