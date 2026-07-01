// Shared H.264 frame splitter. The node and the gateway both read the raw byte stream
// from `adb screenrecord --output-format=h264` and slice it into individual video frames
// the same way: split on the 00 00 00 01 NAL start codes and group the NAL units into
// frames (SPS + PPS + IDR = a keyframe, a lone slice = a delta frame). This logic was
// copied verbatim into both services; it now lives in one place.

export type H264FrameHandler = (frame: Uint8Array, keyFrame: boolean) => void;

export interface H264FrameSplitter {
  /** Feed a raw stdout chunk; emits complete video frames via the handler. */
  push(chunk: Buffer): void;
}

function concatBuffers(parts: Buffer[]): Uint8Array {
  const total = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

export function createH264FrameSplitter(onFrame: H264FrameHandler): H264FrameSplitter {
  let buffer = Buffer.alloc(0);

  function drain(): void {
    const buf = buffer;
    const startCodes: number[] = [];

    // Find all 4-byte start codes.
    for (let i = 0; i <= buf.length - 4; i++) {
      if (buf[i] === 0 && buf[i + 1] === 0 && buf[i + 2] === 0 && buf[i + 3] === 1) {
        startCodes.push(i);
      }
    }

    if (startCodes.length < 2) return; // need at least 2 start codes to extract a NAL

    let consumed = 0;
    let frameStart = -1;
    let frameIsKey = false;
    let frameData: Buffer[] = [];

    for (let i = 0; i < startCodes.length - 1; i++) {
      const nalStart = startCodes[i];
      const nalEnd = startCodes[i + 1];
      const nalType = buf[nalStart + 4] & 0x1f;

      if (nalType === 7 || nalType === 8) {
        // SPS or PPS — start accumulating a keyframe.
        if (frameStart === -1) frameStart = nalStart;
        frameIsKey = true;
        frameData.push(buf.subarray(nalStart, nalEnd));
      } else if (nalType === 5) {
        // IDR slice — completes the keyframe.
        if (frameStart === -1) {
          frameStart = nalStart;
          frameIsKey = true;
        }
        frameData.push(buf.subarray(nalStart, nalEnd));
        onFrame(concatBuffers(frameData), true);
        consumed = nalEnd;
        frameStart = -1;
        frameIsKey = false;
        frameData = [];
      } else if (nalType === 1) {
        // P-slice — standalone frame.
        if (frameData.length > 0) {
          // Flush accumulated SPS/PPS without IDR (shouldn't happen, but safe).
          onFrame(concatBuffers(frameData), frameIsKey);
          frameData = [];
          frameIsKey = false;
          frameStart = -1;
        }
        onFrame(new Uint8Array(buf.buffer, buf.byteOffset + nalStart, nalEnd - nalStart), false);
        consumed = nalEnd;
      } else {
        // Skip other NAL types (SEI=6, AUD=9, etc.).
        if (frameStart !== -1) {
          frameData.push(buf.subarray(nalStart, nalEnd));
        } else {
          consumed = nalEnd;
        }
      }
    }

    // Keep unconsumed data (last incomplete NAL + any accumulated frame data).
    if (consumed > 0) {
      buffer = Buffer.from(buf.subarray(frameData.length > 0 ? frameStart! : consumed));
    }
  }

  return {
    push(chunk: Buffer): void {
      buffer = Buffer.concat([buffer, chunk]);
      drain();
    },
  };
}
