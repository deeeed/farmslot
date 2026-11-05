import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import {
  Events,
  isRecord,
  type RuntimeCapabilityAcquireResult,
  type RuntimeCapabilityListResult,
  RuntimeCapabilityMethods,
  type RuntimeCapabilityReleaseResult,
} from '@farmslot/protocol';
import type { CliOptions } from '@farmslot/recipe-cli/harness';

import { GatewayClient, type GatewayConnection } from '../gateway-client.js';
import { resolveGatewayTarget } from '../gateway-profiles.js';

import { RUNTIME_CAPABILITY_ACQUIRE_RPC_TIMEOUT_MS } from './rpc.js';

export interface RecordingResourceRequest {
  capabilityId?: string;
  slotId?: string;
  runId?: string;
  project?: string;
  taskDir?: string;
  recorded: boolean;
  options: CliOptions;
  signal?: AbortSignal;
}
export type RecordingResourceConnect = (options: CliOptions) => Promise<GatewayConnection>;

const connectGateway: RecordingResourceConnect = (options) =>
  new GatewayClient({
    ...resolveGatewayTarget({
      url: typeof options.url === 'string' ? options.url : undefined,
      gateway: typeof options.gateway === 'string' ? options.gateway : undefined,
    }),
    timeout: RUNTIME_CAPABILITY_ACQUIRE_RPC_TIMEOUT_MS,
  }).connect();

/** One existing capability lease covers the entire recorded command, including setup. */
export async function withRecordingResource<T>(
  request: RecordingResourceRequest,
  invoke: (signal?: AbortSignal) => Promise<T>,
  connect: RecordingResourceConnect = connectGateway,
): Promise<T> {
  const { capabilityId, slotId } = request;
  let runId = request.runId;
  if (!request.recorded || !capabilityId) return invoke(request.signal);
  if (request.taskDir) {
    const receipt: unknown = JSON.parse(
      await readFile(path.join(request.taskDir, 'inputs/runtime-capability-catalog.json'), 'utf8'),
    );
    if (
      !isRecord(receipt) ||
      receipt.version !== 1 ||
      typeof receipt.ownerRunId !== 'string' ||
      !receipt.ownerRunId ||
      receipt.slotId !== slotId ||
      receipt.project !== request.project ||
      (runId !== undefined && runId !== receipt.ownerRunId)
    )
      throw new Error('The recorded proof task does not match its owning run, slot and project.');
    runId = receipt.ownerRunId;
  }
  if (!slotId || !runId)
    throw new Error('A recorded proof resource requires --run and an allocated slot.');
  request.signal?.throwIfAborted();
  const connection = await connect(request.options);
  const controller = new AbortController();
  const signal = request.signal
    ? AbortSignal.any([request.signal, controller.signal])
    : controller.signal;
  let revision = 0;
  let wake: (() => void) | undefined;
  let leaseId: string | undefined;
  const invocationId = randomUUID();
  let attempted = false;
  let cleaningUp = false;
  const revoked = new Set<string>();
  let waitingAnnounced = false;
  const unsubscribe = connection.onEvent((event) => {
    const payload = event.payload;
    if (!isRecord(payload)) return;
    if (
      [Events.RUN_UPDATED, Events.RUN_COMPLETED].some((name) => name === event.event) &&
      isRecord(payload.run) &&
      payload.run.id === runId
    ) {
      const run = payload.run;
      if (
        run.slotId !== slotId ||
        (typeof run.status === 'string' &&
          ['done', 'failed', 'cancelled', 'paused'].includes(run.status))
      )
        controller.abort(new Error('The recorded proof no longer owns its active run and slot.'));
    }
    const change = payload.event;
    if (
      event.event !== Events.RUNTIME_CAPABILITY_LIFECYCLE ||
      !isRecord(change) ||
      !isRecord(change.owner) ||
      change.owner.runId !== runId ||
      change.capabilityId !== capabilityId
    )
      return;
    if (leaseId && change.leaseId !== leaseId) return;
    if (change.kind === 'released' && typeof change.leaseId === 'string') {
      revoked.add(change.leaseId);
      if (leaseId === change.leaseId && !cleaningUp)
        controller.abort(new Error('The recorded proof resource was released.'));
    }
    revision++;
    wake?.();
  });
  const unsubscribeClose = connection.onClose(() =>
    controller.abort(
      new Error('Gateway connection closed while holding or waiting for the recording resource.'),
    ),
  );
  let outcome: { value: T } | { error: unknown };
  try {
    signal.throwIfAborted();
    const catalog = await connection.call<RuntimeCapabilityListResult>(
      RuntimeCapabilityMethods.list,
      { slotId },
    );
    if (
      catalog.slotId !== slotId ||
      catalog.recordingCapability !== capabilityId ||
      (request.project && catalog.project !== request.project)
    )
      throw new Error(
        'The gateway must support this project recording capability before running recorded proofs.',
      );
    for (;;) {
      signal.throwIfAborted();
      const observed = revision;
      attempted = true;
      const result = await connection.call<RuntimeCapabilityAcquireResult>(
        RuntimeCapabilityMethods.acquire,
        {
          slotId,
          capabilityId,
          ownerRunId: runId,
          invocationId,
          proofRequirement: {
            capabilityId,
            reason: 'Recorded recipe proof, including fixture setup',
            mode: 'visual',
          },
          queueOnConflict: true,
        },
      );
      if (result.ok) {
        if (result.lease.invocationId !== invocationId || result.lease.purpose !== 'recording')
          throw new Error("The gateway did not return this recording invocation's lease.");
        leaseId = result.lease.id;
        if (revoked.has(leaseId))
          controller.abort(new Error('The recorded proof resource was released before execution.'));
        signal.throwIfAborted();
        break;
      }
      if (result.conflict.kind !== 'scoped-wait')
        throw new Error(`Recording resource refused: ${result.conflict.reason}`);
      leaseId = result.conflict.queuedLeaseId;
      if (revoked.has(leaseId))
        controller.abort(new Error('The recorded proof queue place was released.'));
      if (!waitingAnnounced) {
        process.stderr.write(
          `Waiting for recording resource '${capabilityId}': ${result.conflict.reason}\n`,
        );
        waitingAnnounced = true;
      }
      signal.throwIfAborted();
      if (observed !== revision) continue;
      await new Promise<void>((resolve, reject) => {
        const abort = () => reject(signal.reason);
        wake = resolve;
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
        // Both paths remove the exact listener; only an owned lifecycle event wakes the wait.
        wake = () => {
          signal.removeEventListener('abort', abort);
          resolve();
        };
      }).finally(() => {
        wake = undefined;
      });
    }
    outcome = { value: await invoke(signal) };
  } catch (error) {
    outcome = { error };
  }
  cleaningUp = true;
  try {
    if (attempted) {
      const released = await connection.call<RuntimeCapabilityReleaseResult>(
        RuntimeCapabilityMethods.release,
        {
          slotId,
          ownerRunId: runId,
          capabilityId,
          invocationId,
          keepWarm: false,
        },
      );
      if (!released.ok || released.failures.length)
        throw new Error(
          `Recording resource cleanup failed for ${invocationId}: ${released.failures.map((failure) => failure.reason).join('; ')}`,
        );
    }
  } catch (error) {
    const errors = 'error' in outcome ? [outcome.error, error] : [error];
    throw new AggregateError(
      errors,
      `Recorded proof resource cleanup failed: ${errors.map((failure) => (failure instanceof Error ? failure.message : String(failure))).join('; ')}`,
    );
  } finally {
    unsubscribe();
    unsubscribeClose();
    connection.close();
  }
  if ('error' in outcome) throw outcome.error;
  return outcome.value;
}
