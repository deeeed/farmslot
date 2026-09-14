import {
  isSlotFreedByPark,
  isTerminalRunStatus,
  Methods,
  nativeWorkerBindingIsHeld,
  type Run,
} from '@farmslot/protocol';

import { loadSlotVars } from '../core/config.js';
import { readSlotRow } from '../core/state.js';
import { getAllRuns, getRun } from '../runs/store.js';

import { assertNativeRunOwner } from './native-worker-owner.js';

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function ids(
  records: Array<Record<string, unknown>>,
  single: string,
  multiple: string,
): Set<string> {
  return new Set(
    records.flatMap((params) => {
      const values = [params[single], ...(Array.isArray(params[multiple]) ? params[multiple] : [])];
      return values.filter(
        (value): value is string => typeof value === 'string' && value.length > 0,
      );
    }),
  );
}

async function holdsNativeSlot(run: Run): Promise<boolean> {
  if (run.agentContexts?.some((context) => nativeWorkerBindingIsHeld(context.nativeSession)))
    return true;
  if (run.transport !== 'native' || isTerminalRunStatus(run.status) || isSlotFreedByPark(run))
    return false;
  // FIND_SLOT writes the request before its claim. The row, including a handoff
  // reservation during slot-finding, establishes ownership before worker launch.
  const slot = await readSlotRow(run.slotId!);
  return slot?.current_run_id === run.id || slot?.handoff_run_id === run.id;
}

/** Generic run/slot controls cannot grant a second principal native input ownership. */
export async function assertNativeWorkerRpcAccess(method: string, value: unknown): Promise<void> {
  // Node identity/ownership is validated by its registration contract, not as an operator action.
  if (method === 'node.connect') return;
  const params = record(value);
  if (!params) return;
  const records = [
    params,
    record(params.target),
    record(params.selector),
    record(params.worker),
  ].filter((item): item is Record<string, unknown> => item !== undefined);
  const runIds = ids(records, 'runId', 'runIds');
  if (typeof params.parentRunId === 'string') runIds.add(params.parentRunId);
  if (typeof params.expectedRunId === 'string') runIds.add(params.expectedRunId);
  const slotIds = ids(records, 'slotId', 'slotIds');
  const machines = ids(records, 'machine', 'machines');
  const cleanup = method === Methods.RUN_CLEANUP;
  if (!runIds.size && !slotIds.size && !machines.size && !cleanup) return;
  const runs =
    slotIds.size || machines.size || cleanup
      ? getAllRuns()
      : [...runIds].flatMap((id) => {
          const run = getRun(id);
          return run ? [run] : [];
        });
  for (const run of runs) {
    if (
      run.transport !== 'native' &&
      !run.nativeOwnerPrincipalId &&
      !run.agentContexts?.some((context) => context.nativeSession)
    )
      continue;
    if (runIds.has(run.id) || cleanup) {
      assertNativeRunOwner(run);
      continue;
    }
    if (!run.slotId || !(await holdsNativeSlot(run))) continue;
    if (slotIds.has(run.slotId)) {
      assertNativeRunOwner(run);
      continue;
    }
    if (machines.size) {
      const vars = await loadSlotVars(run.slotId);
      if (machines.has(vars.machine)) assertNativeRunOwner(run);
    }
  }
}
