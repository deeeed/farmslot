import {
  Events,
  isGateParkInFlightOrFreed,
  isTerminalRunStatus,
  resourcePostureRowStatus,
  type RunGetResult,
  RuntimePostureMethods,
  type RuntimePostureStatusResult,
} from '@farmslot/protocol';
import type { CliOptions, HarnessContext } from '@farmslot/recipe-cli/harness';

import { GatewayClient, type GatewayConnection } from '../gateway-client.js';
import { resolveGatewayTarget } from '../gateway-profiles.js';

interface LiveRecipeAuthority {
  context: HarnessContext;
  headless: boolean;
  options: CliOptions;
  signal: AbortSignal;
}

type Connect = (options: CliOptions) => Promise<GatewayConnection>;

const connectGateway: Connect = (options) => {
  const target = resolveGatewayTarget({
    url: typeof options.url === 'string' ? options.url : undefined,
    gateway: typeof options.gateway === 'string' ? options.gateway : undefined,
  });
  return new GatewayClient({ ...target, timeout: 10_000 }).connect();
};

/** Observe an existing allocation. Only the Gateway may grant or change resource ownership. */
export async function withLiveRecipeAuthority<T>(
  request: LiveRecipeAuthority,
  invoke: (signal: AbortSignal) => Promise<T>,
  connect: Connect = connectGateway,
): Promise<T> {
  const { context, options } = request;
  if (options.disposable !== true)
    throw new Error('--live requires --disposable for the selected smoke target.');
  const slotId = context.slot?.value ? (context.slot.poolSlot ?? context.slot.value) : undefined;
  if (!slotId) {
    if (!request.headless || !options.target) {
      throw new Error(
        'Unallocated live checks require a headless runtime and an explicit checkout target.',
      );
    }
    request.signal.throwIfAborted();
    const result = await invoke(request.signal);
    request.signal.throwIfAborted();
    return result;
  }
  const runId = typeof options.run === 'string' ? options.run : undefined;
  if (!runId) throw new Error('A pooled live check requires --run naming the existing slot owner.');
  if (options.cdpPort || options.watcherPort) {
    throw new Error(
      'Pooled live checks use the allocated slot ports; configure a separate slot for different ports.',
    );
  }
  const controller = new AbortController();
  const signal = AbortSignal.any([request.signal, controller.signal]);
  const connection = await connect(options);
  let closed = false;
  let required: string[] | undefined;
  const check = async (): Promise<void> => {
    signal.throwIfAborted();
    const [{ run }, posture] = await Promise.all([
      connection.call<RunGetResult>('run.get', { runId }),
      connection.call<RuntimePostureStatusResult>(RuntimePostureMethods.status, { runId }),
    ]);
    if (
      run.slotId !== slotId ||
      run.project !== context.project!.name ||
      isTerminalRunStatus(run.status) ||
      isGateParkInFlightOrFreed(run) ||
      posture.slotId !== slotId ||
      posture.state.posture === 'parked' ||
      posture.state.posture === 'terminal'
    ) {
      throw new Error('Live check no longer owns the selected run and slot.');
    }
    const acquired = posture.state.capabilities.filter(
      (entry) => entry.desiredDisposition === 'acquired',
    );
    required ??= acquired.map((entry) => entry.capabilityId);
    if (!request.headless && required.length === 0)
      throw new Error('The run has no allocated runtime proof resources.');
    if (
      required.some(
        (id) =>
          !acquired.some(
            (entry) =>
              entry.capabilityId === id &&
              entry.owner?.runId === runId &&
              resourcePostureRowStatus(entry.desiredDisposition, entry.observedState) === 'matches',
          ),
      )
    ) {
      throw new Error(
        'Live check lost a required runtime resource; restore the run posture before retrying.',
      );
    }
    if (
      options.device &&
      !acquired.some((entry) => Object.values(entry.target ?? {}).includes(String(options.device)))
    ) {
      throw new Error(
        'The requested device is not held by this run; retarget its Gateway proof plan first.',
      );
    }
  };
  let pending = Promise.resolve();
  const unsubscribe = connection.onEvent((event) => {
    if (
      closed ||
      ![Events.RUN_UPDATED, Events.RUN_COMPLETED, Events.RUNTIME_CAPABILITY_LIFECYCLE].some(
        (name) => name === event.event,
      )
    )
      return;
    pending = pending.then(check).catch((error: unknown) => controller.abort(error));
  });
  const unsubscribeClose = connection.onClose(() =>
    controller.abort(new Error('Gateway connection closed during live conformance.')),
  );
  const abortConnection = (): void => connection.close();
  signal.addEventListener('abort', abortConnection, { once: true });
  try {
    await check();
    const result = await invoke(signal);
    await pending;
    await check();
    signal.throwIfAborted();
    return result;
  } finally {
    closed = true;
    unsubscribe();
    unsubscribeClose();
    signal.removeEventListener('abort', abortConnection);
    await pending;
    connection.close();
  }
}
