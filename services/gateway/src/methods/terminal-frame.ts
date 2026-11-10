import type { WebSocket } from 'ws';

import { Events } from '@farmslot/protocol';

import { SerializedPayload } from '../server/event-frame.js';

type EventEmitter = (event: string, payload: unknown) => void;

/** Bytes a terminal viewer's socket may hold unsent before it is dropped to a resync. */
export const TERMINAL_BUFFER_LIMIT = 1024 * 1024;
export const TERMINAL_RESYNC_CLOSE = { code: 1013, reason: 'Terminal resync required' } as const;

let lastChunk: string | undefined;
let lastChunkJson = '';
/** A PTY chunk reaches every viewer of its terminal in one synchronous pass: escape it once. */
function chunkJson(data: string): string {
  if (data !== lastChunk) {
    lastChunk = data;
    lastChunkJson = JSON.stringify(data);
  }
  return lastChunkJson;
}

/** A viewer's `terminal.data` payload, `{...identity, data, timestamp}`, built on the shared chunk. */
export function terminalDataPayload(
  identity: object,
): (data: string, timestamp: number) => SerializedPayload {
  const json = JSON.stringify(identity);
  const head = json === '{}' ? '{' : `${json.slice(0, -1)},`;
  return (data, timestamp) =>
    new SerializedPayload(`${head}"data":${chunkJson(data)},"timestamp":${timestamp}}`);
}

/** Clears the viewer's screen and draws `lines`: what a viewer joining a running PTY is sent. */
export const JOINED_SCREEN_PREFIX = '\u001b[H\u001b[2J';
export function joinedScreen(lines: readonly string[]): string {
  return `${JOINED_SCREEN_PREFIX}${lines.join('\r\n')}`;
}

/**
 * Sends a viewer that joined a running PTY its current screen, since tmux only redraws a new attach.
 * This is also how a viewer closed for a resync gets its screen back while others keep the PTY.
 */
export async function seedJoinedScreen(
  emit: EventEmitter,
  payload: ReturnType<typeof terminalDataPayload>,
  capture: () => Promise<readonly string[]>,
  key: string,
): Promise<void> {
  let lines: readonly string[];
  try {
    lines = await capture();
  } catch (error) {
    // The live stream continues and the client still seeds an empty viewport from its own
    // snapshot, so a failed capture costs only this redraw.
    console.warn(`[terminal] joined-screen seed failed key=${key}: ${(error as Error).message}`);
    return;
  }
  if (lines.length) emit(Events.TERMINAL_DATA, payload(joinedScreen(lines), Date.now()));
}

/**
 * Terminal output is never dropped. A viewer whose socket already holds more than the limit is
 * closed instead; the client reconnects, subscribes again and gets a full redraw.
 */
export function withTerminalBackpressure(ws: WebSocket, emit: EventEmitter): EventEmitter {
  return (event, payload) => {
    if (event === Events.TERMINAL_DATA && ws.bufferedAmount > TERMINAL_BUFFER_LIMIT) {
      if (ws.readyState === ws.OPEN)
        ws.close(TERMINAL_RESYNC_CLOSE.code, TERMINAL_RESYNC_CLOSE.reason);
      return;
    }
    emit(event, payload);
  };
}
