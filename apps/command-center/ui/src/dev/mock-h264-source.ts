// Mock H.264 source — encodes synthetic frames via WebCodecs VideoEncoder
// Produces Annex B output suitable for H264Decoder consumption

export interface MockH264SourceOptions {
  width?: number;
  height?: number;
  fps?: number;
  onChunk: (data: Uint8Array, keyFrame: boolean, timestamp: number) => void;
}

export class MockH264Source {
  private _width: number;
  private _height: number;
  private _fps: number;
  private _onChunk: MockH264SourceOptions['onChunk'];
  private _encoder: VideoEncoder | null = null;
  private _canvas: OffscreenCanvas;
  private _ctx: OffscreenCanvasRenderingContext2D;
  private _frameCount = 0;
  private _timer: ReturnType<typeof setInterval> | null = null;
  private _running = false;
  private _startTime = 0;
  private _keyFrameInterval = 30; // frames between keyframes (~2s at 15fps)
  private _pendingDescription: Uint8Array | null = null;

  constructor(options: MockH264SourceOptions) {
    this._width = options.width ?? 360;
    this._height = options.height ?? 780;
    this._fps = options.fps ?? 15;
    this._onChunk = options.onChunk;

    this._canvas = new OffscreenCanvas(this._width, this._height);
    this._ctx = this._canvas.getContext('2d')!;
  }

  start(): void {
    if (this._running) return;
    this._running = true;
    this._startTime = performance.now();
    this._frameCount = 0;

    this._encoder = new VideoEncoder({
      output: (chunk: EncodedVideoChunk, meta?: EncodedVideoChunkMetadata) => {
        // If we get a codec description (avcC format), convert to Annex B
        if (meta?.decoderConfig?.description) {
          const desc = meta.decoderConfig.description;
          const descBytes =
            desc instanceof ArrayBuffer
              ? new Uint8Array(desc)
              : new Uint8Array(
                  (desc as ArrayBufferView).buffer,
                  (desc as ArrayBufferView).byteOffset,
                  (desc as ArrayBufferView).byteLength,
                );
          this._pendingDescription = avcCToAnnexB(descBytes);
        }

        // Extract chunk data
        const chunkData = new Uint8Array(chunk.byteLength);
        chunk.copyTo(chunkData);

        // Convert avcC length-prefixed NALUs to Annex B start codes
        const annexBData = lengthPrefixedToAnnexB(chunkData);

        const keyFrame = chunk.type === 'key';

        // For keyframes, prepend SPS/PPS from the description
        if (keyFrame && this._pendingDescription) {
          const combined = new Uint8Array(this._pendingDescription.length + annexBData.length);
          combined.set(this._pendingDescription, 0);
          combined.set(annexBData, this._pendingDescription.length);
          this._onChunk(combined, true, chunk.timestamp);
        } else {
          this._onChunk(annexBData, keyFrame, chunk.timestamp);
        }
      },
      error: (err: DOMException) => {
        console.error('[mock-h264-source] encoder error:', err);
      },
    });

    this._encoder.configure({
      codec: avcCodecForResolution(this._width, this._height),
      width: this._width,
      height: this._height,
      bitrate: 500_000,
      framerate: this._fps,
      latencyMode: 'realtime',
      avc: { format: 'avc' }, // Request avcC format (we convert to Annex B)
    });

    this._scheduleFrames();
  }

  stop(): void {
    if (!this._running) return;
    this._running = false;
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
    if (this._encoder && this._encoder.state !== 'closed') {
      try {
        this._encoder.close();
      } catch {
        /* ignore */
      }
    }
    this._encoder = null;
  }

  setFps(fps: number): void {
    this._fps = Math.max(1, Math.min(30, fps));
    this._keyFrameInterval = Math.round(this._fps * 2);
    if (this._running) {
      // Restart frame scheduling with new interval
      if (this._timer) clearInterval(this._timer);
      this._scheduleFrames();
    }
  }

  private _scheduleFrames(): void {
    const interval = Math.round(1000 / this._fps);
    this._timer = setInterval(() => {
      if (!this._running || !this._encoder || this._encoder.state === 'closed') return;
      this._encodeFrame();
    }, interval);
  }

  private _encodeFrame(): void {
    const elapsed = performance.now() - this._startTime;
    const ctx = this._ctx;
    const w = this._width;
    const h = this._height;
    const frame = this._frameCount;

    // Cycling hue background
    const hue = (frame * 3) % 360;
    ctx.fillStyle = `hsl(${hue}, 40%, 15%)`;
    ctx.fillRect(0, 0, w, h);

    // Grid pattern
    ctx.strokeStyle = `hsl(${hue}, 30%, 25%)`;
    ctx.lineWidth = 1;
    for (let x = 0; x < w; x += 40) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
      ctx.stroke();
    }
    for (let y = 0; y < h; y += 40) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.stroke();
    }

    // Moving circle
    const cx = w / 2 + Math.cos(frame * 0.05) * (w * 0.3);
    const cy = h / 2 + Math.sin(frame * 0.07) * (h * 0.3);
    const radius = 30 + Math.sin(frame * 0.1) * 10;
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.fillStyle = `hsl(${(hue + 180) % 360}, 70%, 60%)`;
    ctx.fill();

    // Second moving element — bouncing rectangle
    const rx = ((frame * 2) % (w + 60)) - 30;
    const ry = h * 0.7 + Math.sin(frame * 0.08) * 40;
    ctx.fillStyle = `hsl(${(hue + 90) % 360}, 60%, 50%)`;
    ctx.fillRect(rx - 20, ry - 15, 40, 30);

    // Frame counter (large)
    ctx.fillStyle = '#fff';
    ctx.font = `bold ${Math.round(w * 0.12)}px monospace`;
    ctx.textAlign = 'center';
    ctx.fillText(`#${frame}`, w / 2, h * 0.35);

    // Timestamp
    ctx.font = `${Math.round(w * 0.05)}px monospace`;
    ctx.fillStyle = '#aaa';
    ctx.fillText(`${(elapsed / 1000).toFixed(1)}s`, w / 2, h * 0.42);

    // FPS display
    ctx.fillText(`${this._fps} fps`, w / 2, h * 0.48);

    // Resolution
    ctx.font = `${Math.round(w * 0.04)}px monospace`;
    ctx.fillStyle = '#666';
    ctx.fillText(`${w}x${h}`, w / 2, h * 0.54);

    // MOCK watermark
    ctx.font = `bold ${Math.round(w * 0.08)}px monospace`;
    ctx.fillStyle = 'rgba(255, 255, 255, 0.08)';
    ctx.fillText('MOCK', w / 2, h * 0.9);

    // Encode
    const videoFrame = new VideoFrame(this._canvas, {
      timestamp: Math.round(elapsed * 1000), // microseconds
    });

    const keyFrame = frame % this._keyFrameInterval === 0;
    this._encoder!.encode(videoFrame, { keyFrame });
    videoFrame.close();

    this._frameCount++;
  }
}

// Convert avcC box description to Annex B (SPS + PPS with start codes)
function avcCToAnnexB(avcC: Uint8Array): Uint8Array {
  const startCode = new Uint8Array([0, 0, 0, 1]);
  const parts: Uint8Array[] = [];

  try {
    // avcC format: https://wiki.multimedia.cx/index.php/MPEG-4_Part_15
    // Skip first 5 bytes (configurationVersion, profile, compat, level, lengthSizeMinusOne)
    let offset = 5;

    // SPS
    const numSPS = avcC[offset] & 0x1f;
    offset++;
    for (let i = 0; i < numSPS; i++) {
      const spsLen = (avcC[offset] << 8) | avcC[offset + 1];
      offset += 2;
      parts.push(startCode);
      parts.push(avcC.subarray(offset, offset + spsLen));
      offset += spsLen;
    }

    // PPS
    const numPPS = avcC[offset];
    offset++;
    for (let i = 0; i < numPPS; i++) {
      const ppsLen = (avcC[offset] << 8) | avcC[offset + 1];
      offset += 2;
      parts.push(startCode);
      parts.push(avcC.subarray(offset, offset + ppsLen));
      offset += ppsLen;
    }
  } catch {
    // Fallback: return as-is with start code
    return new Uint8Array([...startCode, ...avcC]);
  }

  const totalLen = parts.reduce((s, p) => s + p.length, 0);
  const result = new Uint8Array(totalLen);
  let pos = 0;
  for (const part of parts) {
    result.set(part, pos);
    pos += part.length;
  }
  return result;
}

// Pick AVC Baseline codec string with appropriate level for the resolution.
// Level limits (max coded area in pixels):
//   3.0 = 414,720   3.1 = 921,600   4.0 = 2,097,152   5.1 = 36,864,000
function avcCodecForResolution(w: number, h: number): string {
  // Coded dimensions are rounded up to 16-pixel macroblock boundaries
  const codedArea = Math.ceil(w / 16) * 16 * (Math.ceil(h / 16) * 16);
  if (codedArea <= 414_720) return 'avc1.42E01E'; // Baseline L3.0
  if (codedArea <= 921_600) return 'avc1.42E01F'; // Baseline L3.1
  if (codedArea <= 2_097_152) return 'avc1.42E028'; // Baseline L4.0
  return 'avc1.42E033'; // Baseline L5.1
}

// Convert length-prefixed NAL units (avcC format) to Annex B start codes
function lengthPrefixedToAnnexB(data: Uint8Array): Uint8Array {
  const startCode = new Uint8Array([0, 0, 0, 1]);
  const parts: Uint8Array[] = [];
  let offset = 0;

  while (offset < data.length - 3) {
    const naluLen =
      (data[offset] << 24) | (data[offset + 1] << 16) | (data[offset + 2] << 8) | data[offset + 3];
    offset += 4;

    if (naluLen <= 0 || offset + naluLen > data.length) break;

    parts.push(startCode);
    parts.push(data.subarray(offset, offset + naluLen));
    offset += naluLen;
  }

  if (parts.length === 0) {
    // Data might already be Annex B or unknown format — pass through with start code
    const result = new Uint8Array(startCode.length + data.length);
    result.set(startCode, 0);
    result.set(data, startCode.length);
    return result;
  }

  const totalLen = parts.reduce((s, p) => s + p.length, 0);
  const result = new Uint8Array(totalLen);
  let pos = 0;
  for (const part of parts) {
    result.set(part, pos);
    pos += part.length;
  }
  return result;
}
