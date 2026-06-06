// methods/stream-feed.ts — stream.subscribe / unsubscribe handlers

import type { WebSocket } from 'ws';

import type { StreamSubscribeParams } from '@farmslot/protocol';

import {
  clearResourceStreamState,
  executeResourceHealth,
  resolveSlotResources,
  setResourceStreamState,
} from '../fleet/resource-manager.js';
import {
  getScreenSession,
  hasScreenSession,
  type ScreenFrameHandler,
  subscribeScreen,
  unsubscribeScreen,
} from '../runtime/screen-session.js';

const HEADER_SIZE = 14;
const MAGIC = 0xdf;

function encodeBinaryFrame(
  payload: Uint8Array,
  keyFrame: boolean,
  width: number,
  height: number,
  timestampMs: number,
  resourceIndex = 0,
): Buffer {
  const buf = Buffer.alloc(HEADER_SIZE + payload.length);
  buf[0] = MAGIC;
  buf[1] = (keyFrame ? 1 : 0) | ((resourceIndex & 0x7) << 1);
  buf.writeUInt16BE(width, 2);
  buf.writeUInt16BE(height, 4);
  buf.writeUInt32BE(timestampMs, 6);
  buf.writeUInt32BE(payload.length, 10);
  buf.set(payload, HEADER_SIZE);
  return buf;
}

const MAX_CLIENT_RESOURCE_INDICES = 8;
const clientResourceIndices = new WeakMap<WebSocket, Map<string, number>>();

function nextResourceIndex(ws: WebSocket, key: string): number {
  let assigned = clientResourceIndices.get(ws);
  if (!assigned) {
    assigned = new Map();
    clientResourceIndices.set(ws, assigned);
  }

  const existing = assigned.get(key);
  if (existing != null) return existing;

  const used = new Set(assigned.values());
  for (let idx = 0; idx < MAX_CLIENT_RESOURCE_INDICES; idx += 1) {
    if (!used.has(idx)) {
      assigned.set(key, idx);
      return idx;
    }
  }

  throw new Error(
    `No free resource indices remain for client (max ${MAX_CLIENT_RESOURCE_INDICES})`,
  );
}

function releaseResourceIndex(ws: WebSocket, key: string): void {
  const assigned = clientResourceIndices.get(ws);
  if (!assigned) return;
  assigned.delete(key);
  if (assigned.size === 0) {
    clientResourceIndices.delete(ws);
  }
}

export function resetClientResourceIndex(ws: WebSocket): void {
  clientResourceIndices.delete(ws);
}

/** Returns the session key used for unsubscribe */
export async function streamSubscribe(
  params: StreamSubscribeParams,
  ws: WebSocket,
  slotId: string,
): Promise<{
  handler: ScreenFrameHandler;
  key: string;
  resourceIndex: number;
  resourceId?: string;
}> {
  const platform = params.platform; // undefined = auto-detect
  const requestedResourceId = params.resourceId;
  let resolvedResourceId: string | undefined;

  // Run resource health hook before streaming (fail fast if device unavailable)
  if (platform || requestedResourceId) {
    const resources = await resolveSlotResources(slotId);
    const resource = requestedResourceId
      ? resources.find((r) => r.id === requestedResourceId)
      : resources.find((r) => r.definition.platform === platform);
    resolvedResourceId = resource?.id;
    if (resource?.definition.hooks?.health) {
      const check = await executeResourceHealth(slotId, resource.id);
      if (!check.ok) {
        const detail = `${resource.definition.label ?? resource.id} is not running`;
        setResourceStreamState(slotId, resource.id, {
          state: 'error',
          detail,
          updatedAt: new Date().toISOString(),
        });
        throw new Error(detail);
      }
    }
  }

  if (resolvedResourceId) {
    setResourceStreamState(slotId, resolvedResourceId, {
      state: 'starting',
      updatedAt: new Date().toISOString(),
    });
  }

  const key = `${slotId}:${requestedResourceId ?? platform ?? 'auto'}`;
  const startMs = Date.now();
  const resourceIndex = nextResourceIndex(ws, key);

  const BACKPRESSURE_THRESHOLD = 512 * 1024; // 512KB
  let droppedFrames = 0;
  let lastDropLog = 0;

  const handler: ScreenFrameHandler = (payload, keyFrame) => {
    if (ws.readyState !== 1 /* OPEN */) return;
    // Backpressure: drop P-frames when WebSocket buffer is congested
    if (ws.bufferedAmount > BACKPRESSURE_THRESHOLD && !keyFrame) {
      droppedFrames++;
      const now = Date.now();
      if (now - lastDropLog > 5000) {
        console.log(`[screen] backpressure: dropped ${droppedFrames} P-frames for ${key}`);
        droppedFrames = 0;
        lastDropLog = now;
      }
      return;
    }
    const session = getScreenSession(key);
    const frame = encodeBinaryFrame(
      payload,
      keyFrame,
      session.width,
      session.height,
      Date.now() - startMs,
      resourceIndex,
    );
    ws.send(frame);
  };

  try {
    await subscribeScreen(
      slotId,
      '', // deviceId unused — subscribeScreen resolves from pool config
      handler,
      params.maxFps ?? 15,
      params.maxWidth ?? 720,
      platform,
      ws,
      requestedResourceId,
    );
  } catch (err) {
    if (resolvedResourceId) {
      setResourceStreamState(slotId, resolvedResourceId, {
        state: 'error',
        detail: err instanceof Error ? err.message : String(err),
        updatedAt: new Date().toISOString(),
      });
    }
    throw err;
  }

  if (resolvedResourceId) {
    setResourceStreamState(slotId, resolvedResourceId, {
      state: 'ready',
      updatedAt: new Date().toISOString(),
    });
  }

  return { handler, key, resourceIndex, resourceId: resolvedResourceId };
}

export function streamUnsubscribe(
  ws: WebSocket,
  key: string,
  handler: ScreenFrameHandler,
  resourceId?: string,
): void {
  unsubscribeScreen(key, handler);
  releaseResourceIndex(ws, key);
  if (resourceId && !hasScreenSession(key)) {
    const slotId = key.split(':', 1)[0] ?? '';
    if (slotId) clearResourceStreamState(slotId, resourceId);
  }
}
