// Shared node→gateway capture-frame codec (ADR-046). Single source of truth for the
// binary envelope so the node (encode) and the gateway (decode) never drift. The magic
// byte lives in @farmslot/protocol; the Buffer-based codec lives here (node-only) so it
// stays out of the UI-shared protocol bundle.
//
// Envelope: [0xAF magic][1B flags][2B width BE][2B height BE][1B slotIdLen][slotId…][payload…]
// flags bit0 = keyframe.

import { NODE_FRAME_MAGIC } from '@farmslot/protocol';

export { NODE_FRAME_MAGIC };

const HEADER_FIXED = 7; // magic + flags + width(2) + height(2) + slotIdLen

export function encodeNodeFrame(
  slotId: string,
  payload: Uint8Array,
  keyFrame: boolean,
  width: number,
  height: number,
): Buffer {
  const slotBytes = Buffer.from(slotId, 'utf-8');
  const headerSize = HEADER_FIXED + slotBytes.length;
  const buf = Buffer.alloc(headerSize + payload.length);
  buf[0] = NODE_FRAME_MAGIC;
  buf[1] = keyFrame ? 1 : 0;
  buf.writeUInt16BE(width, 2);
  buf.writeUInt16BE(height, 4);
  buf[6] = slotBytes.length;
  slotBytes.copy(buf, HEADER_FIXED);
  buf.set(payload, headerSize);
  return buf;
}

export interface DecodedNodeFrame {
  slotId: string;
  payload: Uint8Array;
  keyFrame: boolean;
  width: number;
  height: number;
}

/** Decode a node capture frame. Returns null when the buffer is truncated. Callers
 *  should have already checked `raw[0] === NODE_FRAME_MAGIC`. */
export function decodeNodeFrame(raw: Buffer): DecodedNodeFrame | null {
  if (raw.length < HEADER_FIXED) return null;
  const flags = raw[1];
  const keyFrame = (flags & 1) !== 0;
  const width = raw.readUInt16BE(2);
  const height = raw.readUInt16BE(4);
  const slotIdLen = raw[6];
  if (raw.length < HEADER_FIXED + slotIdLen) return null;
  const slotId = raw.subarray(HEADER_FIXED, HEADER_FIXED + slotIdLen).toString('utf-8');
  const payload = new Uint8Array(
    raw.buffer,
    raw.byteOffset + HEADER_FIXED + slotIdLen,
    raw.length - HEADER_FIXED - slotIdLen,
  );
  return { slotId, payload, keyFrame, width, height };
}
