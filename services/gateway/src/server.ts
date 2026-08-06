// server.ts — WebSocket server setup, connection handling, frame routing

import type { IncomingMessage, Server as HttpServer } from 'node:http';

import { WebSocket, WebSocketServer } from 'ws';

import { decodeNodeFrame } from '@farmslot/capabilities/screen-frame';
import {
  chatActionRejectCode,
  type EventFrame,
  Events,
  type GatewayAuthConnectParams,
  Methods,
  NODE_FRAME_MAGIC,
  type PairingExchangeParams,
  type RequestFrame,
  type ResponseFrame,
} from '@farmslot/protocol';
import { SlotConfigError } from '@farmslot/slot-config';

import { handleBranchFsChanged } from './automation/branch-watcher.js';
import { tryDispatchNext } from './backlog/dispatch-queue.js';
import { autoDispatchBacklogReady, listBacklogItems } from './backlog/store.js';
import { ChatActionRejectError } from './chat/chat-actions.js';
import { GatewayMethodError } from './core/method-error.js';
import { setSlotUpdateHook } from './core/state.js';
import { unregisterByWs } from './fleet/machine-registry.js';
import { getMachineHealth, markMachineOffline, updateMachineMetrics } from './fleet/node-health.js';
import { handleNodeExecOutput, handleNodeResponse } from './fleet/node-rpc.js';
import { pairingExchange } from './fleet/pairing.js';
import {
  clearMachineResourceStatus,
  handleNodeResourceChanged,
  startResourcePolling,
} from './fleet/resource-manager.js';
import { loadFleetStatus, onStateChange } from './fleet/state.js';
import { resetClientResourceIndex, streamUnsubscribe } from './methods/stream-feed.js';
import { parseTerminalKey } from './methods/terminal.js';
import { unsubscribeWorkerTerminalPty } from './methods/terminal-worker.js';
import { buildTmuxWorkerUpdateFromNodeSnapshot } from './methods/tmux-workers.js';
import { metroUnsubscribeAll } from './methods/workspace.js';
import { initThumbnailCache, unsubscribeThumbnails } from './observability/thumbnail-cache.js';
import { onPtyExit, unsubscribeAllPty } from './runtime/pty-stream.js';
import {
  cleanupAgentScreenSessions,
  ingestNodeFrame,
  startScreenReaper,
  startScreenRelaunchWatcher,
} from './runtime/screen-session.js';
import { unsubscribeAll } from './runtime/tmux-stream.js';
// Method handlers
import {
  authenticateGatewayClient,
  GatewayAuthError,
  type GatewayAuthRuntime,
  requireAuthenticatedSession,
  resolveRequestIp,
  sanitizeAuthFailureReason,
} from './security/auth.js';
import { isGatewayOriginAllowed } from './security/origin.js';
import { handleSelfReviewFsChanged } from './self-review/orchestrator.js';
import type { ClientState } from './server/client-state.js';
import { routeMethod } from './server/route-method.js';
import { handleAgentFsChanged } from './tasks/watcher.js';

let eventSeq = 0;
let backlogAutoDispatchTimer: NodeJS.Timeout | null = null;
let backlogAutoDispatchInterval: NodeJS.Timeout | null = null;
let serverGlobalsInitialized = false;
const ENABLE_RESOURCE_POLL_ALL =
  process.env.FARMSLOT_RESOURCE_POLL_ALL === '1' ||
  process.env.FARMSLOT_RESOURCE_POLL_ALL === 'true';

let clientSeq = 0;
const clients = new Map<WebSocket, ClientState>();
let activeAuthRuntime: GatewayAuthRuntime | null = null;

/**
 * Inbound WebSocket frame limit (matches `ws` library default of 100 MiB).
 * Oversized frames are rejected with close code 1009. Without a socket-level
 * `error` listener, `ws` emits an unhandled `error` event and Node exits —
 * that is what took the farmdev gateway down on large reconnect/re-present
 * traffic. Keep the cap intentional and always attach the handler below.
 */
export const DEFAULT_WS_MAX_PAYLOAD_BYTES = 100 * 1024 * 1024;

export type CreateWebSocketServerOptions = {
  /** Override inbound max payload (bytes). Tests use a tiny value. */
  maxPayload?: number;
};

function isActiveClient(state: ClientState): boolean {
  return clients.get(state.ws) === state && state.ws.readyState === WebSocket.OPEN;
}

function scheduleBacklogAutoDispatchTick(): void {
  if (listBacklogItems({ status: 'ready' }).items.length === 0) return;
  if (backlogAutoDispatchTimer) return;
  backlogAutoDispatchTimer = setTimeout(() => {
    backlogAutoDispatchTimer = null;
    autoDispatchBacklogReady().catch((err) => {
      console.error(`[backlog] auto-dispatch tick error: ${(err as Error).message}`);
    });
  }, 1_000);
  backlogAutoDispatchTimer.unref();
}

function nextEventSeq(): number {
  return ++eventSeq;
}

export function createWebSocketServer(
  httpServer: HttpServer,
  authRuntime: GatewayAuthRuntime,
  options?: CreateWebSocketServerOptions,
): WebSocketServer {
  activeAuthRuntime = authRuntime;
  const maxPayload = options?.maxPayload ?? DEFAULT_WS_MAX_PAYLOAD_BYTES;
  const wss = new WebSocketServer({
    server: httpServer,
    maxPayload,
    verifyClient: (info, done) => {
      done(isGatewayOriginAllowed(info.origin, info.req.headers.host));
    },
  });

  // Server-level errors (bind/listen issues) must not become unhandled rejections.
  wss.on('error', (err) => {
    console.error(`[server] websocket server error: ${(err as Error).message}`);
  });

  wss.on('connection', (ws: WebSocket, _req: IncomingMessage) => {
    const state: ClientState = {
      id: `c${++clientSeq}`,
      ws,
      terminalHandlers: new Map(),
      workerTerminalHandlers: new Map(),
      ptyHandlers: new Map(),
      terminalIdentities: new Map(),
      workerSessionHistoryHandlers: new Map(),
      workerSessionHistorySubscribeSeq: new Map(),
      terminalSubscribeSeq: new Map(),
      screenHandlers: new Map(),
      thumbnailSubscribed: false,
      authenticated: authRuntime.auth.mode === 'none',
      clientKind: authRuntime.auth.mode === 'none' ? 'ui' : undefined,
      authMode: authRuntime.auth.mode === 'none' ? 'none' : undefined,
      authenticatedAt: authRuntime.auth.mode === 'none' ? Date.now() : undefined,
    };
    clients.set(ws, state);

    // Critical: `ws` emits `error` for oversized frames (WS_ERR_UNSUPPORTED_MESSAGE_LENGTH)
    // before closing with 1009. An unhandled socket error crashes the whole gateway process.
    ws.on('error', (err) => {
      const code = (err as NodeJS.ErrnoException).code;
      console.error(
        `[server] websocket error on ${state.id}` +
          (state.clientKind ? ` (${state.clientKind})` : '') +
          `: ${(err as Error).message}` +
          (code ? ` [${code}]` : ''),
      );
    });

    // Send privileged hello snapshot only after auth when auth is enabled.
    if (authRuntime.auth.mode === 'none') sendHello(ws);

    ws.on('message', (raw: Buffer, isBinary: boolean) => {
      // Handle binary frames from nodes (screen capture relay)
      if (isBinary && raw.length > 7 && raw[0] === NODE_FRAME_MAGIC) {
        if (
          authRuntime.auth.mode !== 'none' &&
          (!state.authenticated || state.clientKind !== 'node')
        ) {
          console.warn(`[auth] rejected pre-auth node binary frame from ${state.id}`);
          ws.close(1008, 'node authentication required');
          return;
        }
        handleNodeBinaryFrame(raw);
        return;
      }

      // Route node responses (type: 'res' from gateway-initiated requests)
      try {
        const peek = JSON.parse(raw.toString());
        if (peek.type === 'res' && typeof peek.id === 'string') {
          if (
            authRuntime.auth.mode !== 'none' &&
            (!state.authenticated || state.clientKind !== 'node')
          ) {
            console.warn(`[auth] rejected pre-auth node response from ${state.id}`);
            ws.close(1008, 'node authentication required');
            return;
          }
          handleNodeResponse(peek.id, peek.ok, peek.payload, peek.error?.message, peek.error?.code);
          return;
        }
        // Route node fs.changed events to task watcher or branch watcher
        if (peek.type === 'event' && peek.event === 'node.fs.changed') {
          if (
            authRuntime.auth.mode !== 'none' &&
            (!state.authenticated || state.clientKind !== 'node')
          ) {
            console.warn(`[auth] rejected pre-auth node event from ${state.id}`);
            ws.close(1008, 'node authentication required');
            return;
          }
          if (handleBranchFsChanged(peek.payload)) {
            return;
          }
          if (!handleSelfReviewFsChanged(peek.payload)) {
            handleAgentFsChanged(peek.payload);
          }
          return;
        }
        // Route node exec output events to per-request streaming callbacks
        if (peek.type === 'event' && peek.event === 'node.exec.output') {
          if (
            authRuntime.auth.mode !== 'none' &&
            (!state.authenticated || state.clientKind !== 'node')
          ) {
            console.warn(`[auth] rejected pre-auth node event from ${state.id}`);
            ws.close(1008, 'node authentication required');
            return;
          }
          handleNodeExecOutput(peek.payload.requestId, peek.payload.stream, peek.payload.data);
          return;
        }
        // Route node resource.changed events to resource manager
        if (peek.type === 'event' && peek.event === 'node.resource.changed') {
          if (
            authRuntime.auth.mode !== 'none' &&
            (!state.authenticated || state.clientKind !== 'node')
          ) {
            console.warn(`[auth] rejected pre-auth node event from ${state.id}`);
            ws.close(1008, 'node authentication required');
            return;
          }
          handleNodeResourceChanged(peek.payload);
          return;
        }

        // Route node-pushed tmux worker inventory/status updates. The node owns
        // sampling so the gateway can broadcast changes without polling every pane.
        if (peek.type === 'event' && peek.event === 'node.tmux.workers.changed') {
          if (
            authRuntime.auth.mode !== 'none' &&
            (!state.authenticated || state.clientKind !== 'node')
          ) {
            console.warn(`[auth] rejected pre-auth node event from ${state.id}`);
            ws.close(1008, 'node authentication required');
            return;
          }
          buildTmuxWorkerUpdateFromNodeSnapshot(peek.payload)
            .then((result) => {
              broadcast({
                type: 'event',
                event: Events.TMUX_WORKER_INVENTORY_UPDATED,
                payload: { result },
                seq: ++eventSeq,
              });
            })
            .catch((err) => {
              // Node-pushed inventory is a live cache optimization. Keep the gateway serving
              // request-time tmux.worker.list even if one pushed snapshot is malformed/stale.
              console.warn(`[server] tmux worker update failed: ${(err as Error).message}`);
            });
          return;
        }
        // Route node metrics events to node health
        if (peek.type === 'event' && peek.event === 'node.metrics') {
          if (
            authRuntime.auth.mode !== 'none' &&
            (!state.authenticated || state.clientKind !== 'node')
          ) {
            console.warn(`[auth] rejected pre-auth node event from ${state.id}`);
            ws.close(1008, 'node authentication required');
            return;
          }
          const { machine, metrics } = peek.payload;
          updateMachineMetrics(machine, metrics);
          broadcast({
            type: 'event',
            event: Events.NODE_HEALTH_UPDATED,
            payload: { machine, health: getMachineHealth(machine) },
            seq: ++eventSeq,
          });
          return;
        }
      } catch (err) {
        // JSON parse failure — not a structured frame, fall through to text handling.
        if (process.env.DEBUG_GATEWAY_FRAMES) {
          console.warn(
            `[server] non-JSON websocket frame routed as text: ${(err as Error).message}`,
          );
        }
      }
      handleMessage(state, raw, authRuntime, _req);
    });

    ws.on('close', () => {
      // Cleanup node registration
      const disconnectedMachine = unregisterByWs(ws);
      if (disconnectedMachine) {
        markMachineOffline(disconnectedMachine);
        cleanupAgentScreenSessions(disconnectedMachine);
        clearMachineResourceStatus(disconnectedMachine).catch((err) => {
          console.warn(
            `[server] clearMachineResourceStatus failed for ${disconnectedMachine}: ${(err as Error).message}`,
          );
        });
        console.log(`Node disconnected: ${disconnectedMachine}`);
        broadcast({
          type: 'event',
          event: Events.NODE_DISCONNECTED,
          payload: { machine: disconnectedMachine },
          seq: ++eventSeq,
        });
        // Broadcast fleet update so UI reflects offline status immediately
        loadFleetStatus(true)
          .then((fleet) => {
            broadcast({
              type: 'event',
              event: Events.FLEET_UPDATED,
              payload: { fleet },
              seq: ++eventSeq,
            });
          })
          .catch((err) => {
            console.warn(
              `[server] fleet refresh on node disconnect failed: ${(err as Error).message}`,
            );
          });
      }

      // Cleanup terminal subscriptions for this client and invalidate any
      // terminal.subscribe RPC that is still awaiting target resolution.
      // Keep this in sync with the pre-await sequence bump in TERMINAL_SUBSCRIBE.
      for (const slotId of new Set([
        ...state.terminalSubscribeSeq.keys(),
        ...[...state.terminalHandlers.keys(), ...state.ptyHandlers.keys()].map(
          (key) => parseTerminalKey(key).slotId,
        ),
      ])) {
        state.terminalSubscribeSeq.set(slotId, (state.terminalSubscribeSeq.get(slotId) ?? 0) + 1);
      }
      for (const handler of state.terminalHandlers.values()) {
        unsubscribeAll(handler);
      }
      for (const handler of state.ptyHandlers.values()) {
        unsubscribeAllPty(handler);
      }
      for (const [key, handler] of state.workerTerminalHandlers) {
        unsubscribeWorkerTerminalPty(key, handler);
      }
      for (const key of new Set([
        ...state.workerSessionHistorySubscribeSeq.keys(),
        ...state.workerSessionHistoryHandlers.keys(),
      ])) {
        state.workerSessionHistorySubscribeSeq.set(
          key,
          (state.workerSessionHistorySubscribeSeq.get(key) ?? 0) + 1,
        );
      }
      for (const unsubscribe of state.workerSessionHistoryHandlers.values()) {
        unsubscribe();
      }
      state.workerSessionHistoryHandlers.clear();
      // Cleanup metro watchers for this client
      metroUnsubscribeAll(state.id);
      // Cleanup screen subscriptions for this client
      for (const [key, handler] of state.screenHandlers) {
        const resourceId = key.slice(key.indexOf(':') + 1);
        streamUnsubscribe(state.ws, key, handler, resourceId === 'auto' ? undefined : resourceId);
      }
      resetClientResourceIndex(ws);
      if (state.thumbnailSubscribed) {
        state.thumbnailSubscribed = false;
        unsubscribeThumbnails();
      }
      clients.delete(ws);
    });
  });

  return wss;
}

/**
 * Register the process-global side effects the gateway needs exactly once:
 * event bridges (PTY exit, fleet state change), the backlog auto-dispatch
 * interval, and the demand-driven pollers/reapers. These are NOT per-connection
 * and MUST NOT live in createWebSocketServer — that runs once per listening
 * server (plaintext ws + TLS wss), and a second registration would duplicate
 * TERMINAL_EXITED/FLEET_UPDATED broadcasts, double-run auto-dispatch, and leak a
 * resource-poll interval. Idempotent so a stray second call is a no-op.
 */
export function initServerGlobals(): void {
  if (serverGlobalsInitialized) return;
  serverGlobalsInitialized = true;

  // Broadcast PTY exit events to all clients
  onPtyExit((slotId, exitCode) => {
    const terminal = parseTerminalKey(slotId);
    let sent = false;
    for (const [ws, state] of clients) {
      const identity = state.terminalIdentities.get(slotId);
      if (!identity) continue;
      sendEvent(ws, Events.TERMINAL_EXITED, { ...identity, exitCode });
      sent = true;
    }
    if (!sent) {
      broadcast({
        type: 'event',
        event: Events.TERMINAL_EXITED,
        payload: { ...terminal, exitCode },
        seq: ++eventSeq,
      });
    }
  });

  // Full-fleet resource polling can execute project health hooks for every slot.
  // Keep it opt-in; request paths like resource.health still probe on demand.
  if (ENABLE_RESOURCE_POLL_ALL) {
    startResourcePolling(broadcastEvent);
  } else {
    console.log(
      '[resource-manager] full-fleet polling disabled (set FARMSLOT_RESOURCE_POLL_ALL=1)',
    );
  }

  // Start screen handler reaper (30s interval) — cleans dead WS handlers from HMR
  startScreenReaper();

  // Rebind active browser capture sessions when a relaunch swaps the pid, so
  // node-side capture no longer pins the dead Chromium until the viewer
  // reconnects.
  startScreenRelaunchWatcher();

  // Init thumbnail cache (demand-driven — only polls when clients subscribe)
  initThumbnailCache(broadcastEvent);

  // Watch for fleet state changes and broadcast
  onStateChange((fleet) => {
    broadcast({
      type: 'event',
      event: Events.FLEET_UPDATED,
      payload: { fleet },
      seq: ++eventSeq,
    });
    // Auto-dispatch queued items when slots free up
    tryDispatchNext().catch((err) => {
      console.error(`[dispatch-queue] auto-dispatch error: ${(err as Error).message}`);
    });
    scheduleBacklogAutoDispatchTick();
  });
  backlogAutoDispatchInterval = setInterval(scheduleBacklogAutoDispatchTick, 60_000);
  backlogAutoDispatchInterval.unref();

  // Hook: broadcast fleet update whenever updateSlotStatus writes to disk.
  // This ensures the UI sees changes immediately instead of waiting for chokidar.
  setSlotUpdateHook(() => {
    loadFleetStatus(true)
      .then((fleet) => {
        broadcast({
          type: 'event',
          event: Events.FLEET_UPDATED,
          payload: { fleet },
          seq: ++eventSeq,
        });
      })
      .catch((err) => {
        console.warn(`[server] slot update hook fleet refresh failed: ${(err as Error).message}`);
      });
  });
}

/** Test-only: reset the once-guard so a suite can re-exercise initServerGlobals. */
export function resetServerGlobalsForTests(): void {
  if (process.env.NODE_TEST_CONTEXT !== '1') {
    throw new Error('resetServerGlobalsForTests is only available during tests');
  }
  serverGlobalsInitialized = false;
  if (backlogAutoDispatchInterval) {
    clearInterval(backlogAutoDispatchInterval);
    backlogAutoDispatchInterval = null;
  }
}

function handleNodeBinaryFrame(raw: Buffer): void {
  // Envelope decoded by the shared codec (@farmslot/capabilities) — same source of truth
  // the node uses to encode. Magic already checked by the caller.
  const decoded = decodeNodeFrame(raw);
  if (!decoded) return;
  ingestNodeFrame(decoded.slotId, decoded.payload, decoded.keyFrame, decoded.width, decoded.height);
}

async function sendHello(ws: WebSocket): Promise<void> {
  try {
    const fleet = await loadFleetStatus();
    sendEvent(ws, Events.HELLO, { fleet });
  } catch (err) {
    console.warn(`[server] sendHello fleet load failed: ${(err as Error).message}`);
    sendEvent(ws, Events.HELLO, { fleet: null });
  }
}

async function handleMessage(
  state: ClientState,
  raw: Buffer,
  authRuntime: GatewayAuthRuntime,
  req: IncomingMessage,
): Promise<void> {
  let frame: RequestFrame;
  try {
    frame = JSON.parse(raw.toString());
  } catch (err) {
    console.warn(`[server] ignoring malformed request frame: ${(err as Error).message}`);
    return;
  }

  if (frame.type !== 'req') return;

  if (frame.method === Methods.PAIRING_EXCHANGE) {
    try {
      const result = pairingExchange((frame.params ?? {}) as PairingExchangeParams, authRuntime);
      sendResponse(state.ws, frame.id, true, result);
    } catch (err) {
      sendResponse(state.ws, frame.id, false, undefined, {
        code: 'PAIRING_FAILED',
        message: (err as Error).message,
      });
    }
    return;
  }

  if (frame.method === Methods.AUTH_CONNECT) {
    const authParams = (frame.params ?? {}) as GatewayAuthConnectParams;
    const clientKind = authParams.clientKind;
    if (clientKind !== 'ui' && clientKind !== 'companion' && clientKind !== 'node') {
      sendResponse(state.ws, frame.id, false, undefined, {
        code: 'AUTH_INVALID_CLIENT',
        message: 'auth.connect requires clientKind ui, companion, or node',
      });
      return;
    }
    const result = authenticateGatewayClient({
      runtime: authRuntime,
      connectParams: authParams,
      clientIp: resolveRequestIp(req),
    });
    if (!result.ok) {
      const retry = result.retryAfterMs
        ? ` Retry after ${Math.ceil(result.retryAfterMs / 1000)}s.`
        : '';
      sendResponse(state.ws, frame.id, false, undefined, {
        code: result.rateLimited ? 'AUTH_RATE_LIMITED' : 'AUTH_FAILED',
        message: `Gateway authentication failed: ${sanitizeAuthFailureReason(result.reason)}.${retry}`,
      });
      return;
    }
    state.authenticated = true;
    state.clientKind = clientKind;
    state.authMode = result.mode ?? authRuntime.auth.mode;
    state.authenticatedAt = Date.now();
    console.log(`[auth] ${clientKind} authenticated using ${state.authMode}`);
    sendResponse(state.ws, frame.id, true, {
      ok: true,
      clientKind,
      authMode: state.authMode,
      authenticatedAt: state.authenticatedAt,
      capabilities: {
        httpBearerAuth: authRuntime.auth.mode !== 'none',
        voiceInstructionFormatting: true,
        gatewayPing: true,
      },
    });
    await sendHello(state.ws);
    return;
  }

  try {
    requireAuthenticatedSession(authRuntime, state);
  } catch (err) {
    const authErr = err as GatewayAuthError;
    sendResponse(state.ws, frame.id, false, undefined, {
      code: authErr.code,
      message: authErr.message,
    });
    return;
  }

  const emit = (event: string, payload: unknown) => {
    sendEvent(state.ws, event, payload);
  };

  try {
    const result = await routeMethod(frame.method, frame.params, {
      authRuntime,
      broadcast,
      emit,
      isActiveClient,
      nextEventSeq,
      state,
    });
    sendResponse(state.ws, frame.id, true, result);
  } catch (err) {
    const message = (err as Error).message;
    let code = 'METHOD_ERROR';
    let userAction: string | undefined;
    let details: unknown;
    if (message.startsWith('Unknown method:')) {
      code = 'METHOD_NOT_FOUND';
    } else if (err instanceof GatewayAuthError) {
      code = err.code;
    } else if (err instanceof GatewayMethodError || err instanceof SlotConfigError) {
      code = err.code;
      userAction = err.userAction;
      details = err.details;
    } else if (err instanceof ChatActionRejectError) {
      // A specific err.code (e.g. 'RequiresExplicitMergeMain') wins over the
      // generic CHAT_ACTION_REJECT_<REASON> derivation so callers can
      // distinguish it from ordinary precondition failures.
      const specific = (err as Error & { code?: string }).code;
      code = specific ?? chatActionRejectCode(err.reason);
    }
    sendResponse(state.ws, frame.id, false, undefined, {
      code,
      message,
      ...(userAction ? { userAction } : {}),
      ...(details !== undefined ? { details } : {}),
    });
  }
}

function sendResponse(
  ws: WebSocket,
  id: string,
  ok: boolean,
  payload?: unknown,
  error?: NonNullable<ResponseFrame['error']>,
): void {
  if (ws.readyState !== WebSocket.OPEN) return;
  const frame: ResponseFrame = { type: 'res', id, ok };
  if (ok) frame.payload = payload;
  else frame.error = error;
  ws.send(JSON.stringify(frame));
}

function sendEvent(ws: WebSocket, event: string, payload: unknown): void {
  if (ws.readyState !== WebSocket.OPEN) return;
  const frame: EventFrame = {
    type: 'event',
    event,
    payload,
    seq: ++eventSeq,
  };
  ws.send(JSON.stringify(frame));
}

export function broadcast(frame: EventFrame): void {
  const msg = JSON.stringify(frame);
  for (const [ws, state] of clients) {
    if (
      ws.readyState === WebSocket.OPEN &&
      (activeAuthRuntime?.auth.mode === 'none' || state.authenticated)
    ) {
      ws.send(msg);
    }
  }
}

export function broadcastEvent(event: string, payload: unknown): void {
  broadcast({
    type: 'event',
    event,
    payload,
    seq: ++eventSeq,
  });
}
