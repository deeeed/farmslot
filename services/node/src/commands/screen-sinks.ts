import type { CaptureSink, SinkStats, StreamSink } from './screen-types.js';

export function createSinkStats(): SinkStats {
  return { frames: 0, bytes: 0, droppedFrames: 0 };
}

export function buildStreamSink(
  key: string,
  slotId: string,
  onFrame: (frame: Buffer) => void,
): StreamSink {
  return {
    key,
    sinkType: 'stream',
    slotId,
    onFrame,
    stats: createSinkStats(),
  };
}

export function trackSinkFrame(sink: CaptureSink, bytes: number): void {
  sink.stats.frames += 1;
  sink.stats.bytes += bytes;
}
