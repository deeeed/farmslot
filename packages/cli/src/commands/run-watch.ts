import { type EventFrame, Events, isRecord, TERMINAL_RUN_STATUSES } from '@farmslot/protocol';
import type { TaskRunLifecycle } from '@farmslot/recipe-cli/harness';

import type { GatewayConnection } from '../gateway-client.js';

interface RunLifecycleFields {
  id: string;
  project: string;
  status: string;
  slotId?: string | null;
}

export function runLifecycleSnapshot(run: RunLifecycleFields): TaskRunLifecycle {
  return {
    id: run.id,
    project: run.project,
    ...(run.slotId ? { slotId: run.slotId } : {}),
    status: run.status,
    terminal: TERMINAL_RUN_STATUSES.some((status) => status === run.status),
  };
}

/** One authenticated connection observes only this run; usage-only events do not redraw it. */
export async function watchRunLifecycle(
  connection: GatewayConnection,
  runId: string,
  render: (run: TaskRunLifecycle) => void,
): Promise<void> {
  let latest: TaskRunLifecycle | undefined;
  let revision = 0;
  let initial = true;
  let interrupted = false;
  let finish: () => void = () => {};
  let fail: (error: unknown) => void = () => {};
  const stopped = new Promise<void>((resolve, reject) => {
    finish = resolve;
    fail = reject;
  });
  // Attach a rejection observer before the initial RPC, preserving its error for the await below.
  const completion = stopped.then(
    () => ({ ok: true as const }),
    (error) => ({ ok: false as const, error }),
  );
  const emit = (run: TaskRunLifecycle) => {
    if (JSON.stringify(run) === JSON.stringify(latest)) return;
    latest = run;
    if (!initial) render(run);
    if (run.terminal) finish();
  };
  const off = connection.onEvent((event: EventFrame) => {
    if (event.event !== Events.RUN_UPDATED && event.event !== Events.RUN_COMPLETED) return;
    if (!isRecord(event.payload) || !isRecord(event.payload.run) || event.payload.run.id !== runId)
      return;
    const value = event.payload.run;
    if (typeof value.status !== 'string' || typeof value.project !== 'string') return;
    revision++;
    try {
      emit(
        runLifecycleSnapshot({
          id: runId,
          project: value.project,
          status: value.status,
          ...(typeof value.slotId === 'string' ? { slotId: value.slotId } : {}),
        }),
      );
    } catch (error) {
      fail(error);
    }
  });
  const offClose = connection.onClose(() =>
    fail(new Error('Gateway connection closed while watching run lifecycle.')),
  );
  const interrupt = () => {
    interrupted = true;
    finish();
    connection.close();
  };
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', interrupt);
  try {
    const observed = revision;
    const { run } = await connection.call<{ run: RunLifecycleFields }>('run.get', { runId });
    if (observed === revision || !latest) emit(runLifecycleSnapshot(run));
    initial = false;
    if (latest) render(latest);
    const outcome = await completion;
    if (!outcome.ok) throw outcome.error;
  } catch (error) {
    if (!interrupted) throw error;
  } finally {
    off();
    offClose();
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', interrupt);
    connection.close();
  }
}
