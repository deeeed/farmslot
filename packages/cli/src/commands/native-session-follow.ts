import {
  Events,
  Methods,
  type NativeSessionDeltaPayload,
  type NativeSessionSubscribeResult,
} from '@farmslot/protocol';
import {
  createNativeConversationCache,
  nativeHistoryParams,
  type ResourceCacheConnection,
} from '@farmslot/protocol/client-cache';

import type { GatewayClient, GatewayConnection } from '../gateway-client.js';

/** Existing CLI connection and shared reducer; no model commands or new transport. */
export async function followNativeSession(
  client: Pick<GatewayClient, 'connect'>,
  params: unknown,
  signal: AbortSignal,
  write: (frame: unknown, signal: AbortSignal) => void | Promise<void>,
): Promise<void> {
  if (!params || typeof params !== 'object' || Array.isArray(params))
    throw new Error('--follow requires native session parameters');
  const after = 'after' in params ? params.after : undefined;
  const target = nativeHistoryParams(
    Object.fromEntries(Object.entries(params).filter(([key]) => key !== 'after')),
  );
  let socket: GatewayConnection | undefined;
  let serial = 0;
  let subscriptions = 0;
  let state: ResourceCacheConnection = {
    id: 0,
    connected: false,
    authMode: 'token',
    scope: { gatewayUrl: 'cli' },
    capabilities: {
      httpBearerAuth: true,
      voiceInstructionFormatting: true,
      conversationStreaming: 1,
    },
  };
  let onDelta: ((payload: NativeSessionDeltaPayload) => void) | undefined;
  let lastError: Error | undefined;
  let finish: (() => void) | undefined;
  const closing = new Set<Promise<unknown>>();
  const outputAbort = new AbortController();
  let outputClosed = false;
  let outputBytes = 0;
  let outputTask: Promise<void> | undefined;
  const outputQueue: Array<{ frame: NativeSessionDeltaPayload; bytes: number }> = [];
  const outputFailure = (error: unknown) => {
    if (outputClosed || signal.aborted) return;
    lastError = error instanceof Error ? error : new Error(String(error));
    finish?.();
  };
  const enqueue = (frame: NativeSessionDeltaPayload) => {
    if (lastError || outputClosed || signal.aborted) return;
    const bytes = Buffer.byteLength(JSON.stringify(frame)) + 1;
    if (outputBytes + bytes > 1024 * 1024) {
      outputFailure(
        new Error(
          'Native output exceeded 1 MiB while stdout was blocked. Resume from the last complete emitted cursor.',
        ),
      );
      return;
    }
    outputBytes += bytes;
    outputQueue.push({ frame, bytes });
    pump();
  };
  const pump = () => {
    if (outputTask || outputClosed || signal.aborted || lastError || !outputQueue.length) return;
    outputTask = (async () => {
      while (outputQueue.length && !outputClosed && !signal.aborted && !lastError) {
        const next = outputQueue.shift()!;
        await write(next.frame, outputAbort.signal);
        outputBytes -= next.bytes;
      }
    })()
      .catch(outputFailure)
      .finally(() => {
        outputTask = undefined;
        pump();
      });
  };
  const controller = createNativeConversationCache(
    {
      async subscribe(target) {
        if (!socket) throw new Error('Gateway connection closed');
        const result = await socket.call<NativeSessionSubscribeResult>(
          Methods.NATIVE_SESSION_SUBSCRIBE,
          { ...target, ...(subscriptions++ === 0 && after !== undefined ? { after } : {}) },
        );
        return result;
      },
      unsubscribe(subscriptionId) {
        if (!socket || !state.connected) return Promise.resolve();
        const pending = socket.call(Methods.NATIVE_SESSION_UNSUBSCRIBE, { subscriptionId });
        closing.add(pending);
        void pending.then(
          () => closing.delete(pending),
          () => closing.delete(pending),
        );
        return pending;
      },
      onDelta(listener) {
        onDelta = listener;
        return () => {
          onDelta = undefined;
        };
      },
    },
    { load: async () => undefined, save: async () => undefined, forget: async () => undefined },
    () => state,
    { onEnvelope: enqueue },
  );
  const stop = controller.api.observe(target, (observation) => {
    if (
      observation.status === 'error' ||
      observation.status === 'unsupported' ||
      (observation.error && observation.status !== 'ready')
    ) {
      lastError = new Error(observation.error?.message ?? 'Native conversation unavailable');
      finish?.();
    }
  });
  try {
    while (!signal.aborted && !lastError) {
      socket = await client.connect(signal);
      const ended = new Promise<void>((resolve) => {
        finish = resolve;
      });
      const stopEvent = socket.onEvent((frame) => {
        if (frame.event !== Events.NATIVE_SESSION_DELTA) return;
        const payload = frame.payload as NativeSessionDeltaPayload;
        onDelta?.(payload);
      });
      const stopClose = socket.onClose(() => {
        state = { ...state, connected: false };
        controller.connectionChanged(false);
        finish?.();
      });
      const abort = () => finish?.();
      signal.addEventListener('abort', abort, { once: true });
      state = { ...state, id: ++serial, connected: true };
      controller.connectionChanged(false);
      if (!signal.aborted) await ended;
      stopEvent();
      stopClose();
      signal.removeEventListener('abort', abort);
      if (signal.aborted || lastError || state.connected) break;
    }
  } catch (error) {
    if (!signal.aborted) throw error;
  } finally {
    outputClosed = true;
    outputAbort.abort();
    outputQueue.length = 0;
    stop();
    // Let idempotent unsubscribe reach this same authenticated connection before closing it.
    const results = await Promise.allSettled([...closing]);
    const failed = results.find((result) => result.status === 'rejected');
    if (failed?.status === 'rejected' && state.connected && !lastError && !signal.aborted)
      lastError = failed.reason instanceof Error ? failed.reason : new Error(String(failed.reason));
    await controller.dispose(false);
    socket?.close();
    await outputTask;
  }
  if (lastError) throw lastError;
}
