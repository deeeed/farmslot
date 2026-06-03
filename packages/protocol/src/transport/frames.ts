// WebSocket frame types — shared between gateway and UI clients
// Follows the OpenClaw pattern: req/res/event frames

export interface RequestFrame {
  type: 'req';
  id: string;
  method: string;
  params?: unknown;
}

export interface ResponseFrame {
  type: 'res';
  id: string;
  ok: boolean;
  payload?: unknown;
  error?: { code: string; message: string };
}

export interface EventFrame {
  type: 'event';
  event: string;
  payload?: unknown;
  seq?: number;
}

export type Frame = RequestFrame | ResponseFrame | EventFrame;

// Binary frame magic bytes for screen capture relay
export const NODE_FRAME_MAGIC = 0xaf; // node -> gateway
export const UI_FRAME_MAGIC = 0xdf; // gateway -> UI

export function isRequest(f: Frame): f is RequestFrame {
  return f.type === 'req';
}
export function isResponse(f: Frame): f is ResponseFrame {
  return f.type === 'res';
}
export function isEvent(f: Frame): f is EventFrame {
  return f.type === 'event';
}
