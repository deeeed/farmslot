export interface CapturedFrame {
  timestampMs: number;
  receivedAtUnixMs: number;
  data: string;
}

/** Keep the last observed repaint in each source-clock sampling window.
 * Dropping every frame too close to the preceding one can lose the final
 * repaint of an otherwise idle page indefinitely. */
export class RecordingFrameSampler {
  private originMs: number | undefined;
  private bucket = -1;
  private pending: CapturedFrame | undefined;
  private lastTimestampMs = -Infinity;

  constructor(private readonly maxFps: number) {
    if (!Number.isFinite(maxFps) || maxFps <= 0)
      throw new Error('Recording maxFps must be positive.');
  }

  accept(frame: CapturedFrame): CapturedFrame | undefined {
    if (!Number.isFinite(frame.timestampMs) || frame.timestampMs < this.lastTimestampMs)
      throw new Error('Recording frame timestamp is invalid or moved backwards.');
    this.lastTimestampMs = frame.timestampMs;
    this.originMs ??= frame.timestampMs;
    const bucket = Math.floor(((frame.timestampMs - this.originMs) * this.maxFps) / 1000);
    const ready = bucket !== this.bucket ? this.pending : undefined;
    this.bucket = bucket;
    this.pending = frame;
    return ready;
  }

  finish(): CapturedFrame | undefined {
    const frame = this.pending;
    this.pending = undefined;
    return frame;
  }
}
