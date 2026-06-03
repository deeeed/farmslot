// Binary frame codec for stream feed WS transport
// Magic byte 0xDF (retained for wire compatibility)
//
// Layout:
//   Byte 0:      0xDF (magic)
//   Byte 1:      Flags (bit 0 = keyFrame)
//   Bytes 2-3:   Width (uint16 BE)
//   Bytes 4-5:   Height (uint16 BE)
//   Bytes 6-9:   Timestamp offset (uint32 BE, ms)
//   Bytes 10-13: Payload length (uint32 BE)
//   Bytes 14+:   H.264 NAL payload

const MAGIC = 0xdf;
const HEADER_SIZE = 14;

export interface StreamBinaryFrame {
  keyFrame: boolean;
  resourceIndex: number; // bits 1-3 of flags byte (0-7)
  width: number;
  height: number;
  timestampMs: number;
  payload: Uint8Array;
}

export function encodeStreamFrame(frame: StreamBinaryFrame): ArrayBuffer {
  const buf = new ArrayBuffer(HEADER_SIZE + frame.payload.length);
  const view = new DataView(buf);
  const bytes = new Uint8Array(buf);

  view.setUint8(0, MAGIC);
  view.setUint8(1, (frame.keyFrame ? 1 : 0) | ((frame.resourceIndex & 0x7) << 1));
  view.setUint16(2, frame.width, false); // big-endian
  view.setUint16(4, frame.height, false);
  view.setUint32(6, frame.timestampMs, false);
  view.setUint32(10, frame.payload.length, false);
  bytes.set(frame.payload, HEADER_SIZE);

  return buf;
}

export function decodeStreamFrame(buffer: ArrayBuffer): StreamBinaryFrame {
  if (buffer.byteLength < HEADER_SIZE) {
    throw new Error(`Stream frame too short: ${buffer.byteLength} bytes`);
  }

  const view = new DataView(buffer);
  const magic = view.getUint8(0);
  if (magic !== MAGIC) {
    throw new Error(`Invalid magic byte: 0x${magic.toString(16)}, expected 0xdf`);
  }

  const flags = view.getUint8(1);
  const width = view.getUint16(2, false);
  const height = view.getUint16(4, false);
  const timestampMs = view.getUint32(6, false);
  const payloadLen = view.getUint32(10, false);

  if (buffer.byteLength < HEADER_SIZE + payloadLen) {
    throw new Error(
      `Frame truncated: expected ${HEADER_SIZE + payloadLen}, got ${buffer.byteLength}`,
    );
  }

  return {
    keyFrame: (flags & 1) !== 0,
    resourceIndex: (flags >> 1) & 0x7,
    width,
    height,
    timestampMs,
    payload: new Uint8Array(buffer, HEADER_SIZE, payloadLen),
  };
}
