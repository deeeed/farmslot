/** All prompt sends and retained resumes pass here before they can restart work. */
export async function ensureWorkerContinuationReady(slotId: string, runId?: string): Promise<void> {
  const { readSlotRow } = await import('../core/state.js');
  const row = await readSlotRow(slotId);
  if (!row || row.idle_devserver_epoch !== row.slot_epoch || !Array.isArray(row.idle_devservers))
    return;
  const owner = runId ?? row.current_run_id;
  if (typeof owner !== 'string') throw new Error('Worker continuation requires the slot owner');
  const { restoreIdleDevServers } = await import('../run-lifecycle/idle-devserver-service.js');
  await restoreIdleDevServers(slotId, owner);
}
