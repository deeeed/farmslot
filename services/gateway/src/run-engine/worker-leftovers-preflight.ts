import {
  isRecord,
  type NativeWorkerSessionBinding,
  type Run,
  type RuntimeCapabilityStatusResult,
} from '@farmslot/protocol';

import type { LaunchProbeResult } from './worker-preflight.js';

export interface LaunchLeftoverDeps {
  cleanupInFlight(slotId: string): boolean;
  readSlot(slotId: string): Promise<Readonly<Record<string, unknown>> | null>;
  capabilities(slotId: string, ownerRunId: string): Promise<RuntimeCapabilityStatusResult>;
  readNative(binding: NativeWorkerSessionBinding): Promise<unknown>;
}

/** Positive cleanup records refuse; run-level leases are never guessed to belong to an older generation. */
export async function inspectWorkerLaunchLeftovers(
  run: Run,
  deps: LaunchLeftoverDeps,
): Promise<LaunchProbeResult> {
  if (!run.slotId) return { status: 'unverified', detail: 'No slot ownership is bound.' };
  if (deps.cleanupInFlight(run.slotId))
    return {
      status: 'mismatch',
      detail: `${run.slotId} cleanup is still in flight. Wait for its lifecycle owner to settle, then replay this run.`,
    };
  const slot = await deps.readSlot(run.slotId);
  if (slot?.phase === 'releasing')
    return {
      status: 'mismatch',
      detail: `${run.slotId} is still releasing. Wait for slot release to settle, then retry this run.`,
    };
  const status = await deps.capabilities(run.slotId, run.id);
  const pending = status.leases.find(
    (lease) =>
      lease.owner.runId === run.id &&
      (lease.state === 'releasing' || Boolean(lease.cleanupFailure)),
  );
  if (pending)
    return {
      status: 'mismatch',
      detail: `Run ${run.id} lease ${pending.id} has unreleased cleanup (${pending.cleanupFailure ?? pending.state}). Retry its existing lifecycle cleanup before replay.`,
    };
  const history = (run.agentContexts ?? []).flatMap(
    (context) => context.nativeSessionHistory ?? [],
  );
  for (const binding of history.filter((entry) => entry.releasedAt)) {
    const value: unknown = await deps.readNative(binding);
    if (!isRecord(value) || !isRecord(value.session))
      return {
        status: 'unverified',
        detail: 'Historical native session inspection is unavailable.',
      };
    if (
      typeof value.session.workerLeaseId !== 'string' ||
      typeof value.session.processStopped !== 'boolean'
    )
      return {
        status: 'unverified',
        detail: 'Historical native ownership or stopped state is unknown.',
      };
    // A transferred session now belongs to its new lease. It grants this attempt no cleanup authority.
    if (value.session.workerLeaseId === binding.leaseId && value.session.processStopped === false)
      return {
        status: 'mismatch',
        detail: `Prior session ${binding.sessionId} still runs on released lease ${binding.leaseId}. Reconcile its existing native cleanup before replay.`,
      };
  }
  return {
    status: 'verified',
    detail:
      'No recorded unsettled cleanup; current and retained leases/sessions remain admitted by their lifecycle owners.',
  };
}
