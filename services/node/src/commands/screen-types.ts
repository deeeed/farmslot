import type { ChildProcess } from 'node:child_process';
import type { WriteStream } from 'node:fs';

import type { BrowserContextParams } from '@farmslot/protocol';

export interface ScreenCaptureConfig extends BrowserContextParams {
  slotId: string;
  platform: string;
  resourceId?: string;
  maxFps?: number;
  maxSize?: number;
  windowAppName?: string;
  iosWindowName?: string;
  androidSerial?: string;
  targetPid?: number;
}

export interface AndroidCapture {
  proc: ChildProcess;
  slotId: string;
  width: number;
  height: number;
  buffer: Buffer;
  onFrame: (frame: Buffer) => void;
  restartCount: number;
  config: ScreenCaptureConfig;
}

export interface TargetSelector {
  rawCommand: string;
  windowName?: string;
  appName?: string;
  pid?: number;
}

export interface SinkStats {
  frames: number;
  bytes: number;
  droppedFrames: number;
}

export interface StreamSink {
  key: string;
  sinkType: 'stream';
  slotId: string;
  onFrame: (frame: Buffer) => void;
  stats: SinkStats;
}

export interface ProbeSink {
  key: string;
  sinkType: 'probe';
  slotId: string;
  probeId: string;
  stats: SinkStats;
  lastFrameAtMs: number;
}

export interface RecordingSink {
  key: string;
  sinkType: 'record';
  slotId: string;
  recordingId: string;
  fifoPath: string;
  minFrameIntervalMs: number;
  lastWriteAtMs: number;
  latestChunk: Buffer | null;
  tickTimer: ReturnType<typeof setInterval> | null;
  writer: WriteStream;
  queue: Buffer[];
  queueBytes: number;
  backpressured: boolean;
  maxQueueBytes: number;
  stats: SinkStats;
  droppedDueToBackpressure: boolean;
}

export type CaptureSink = StreamSink | ProbeSink | RecordingSink;

export interface MacWindowSession {
  targetKey: string;
  sessionId: string;
  selector: TargetSelector;
  maxFps: number;
  maxSize: number;
  windowIndex: number;
  width: number;
  height: number;
  sinks: Map<string, CaptureSink>;
  lastPayload: Uint8Array | null;
  lastKeyFrame: boolean;
}

export interface PendingAdd {
  targetKey: string;
  selector: TargetSelector;
  firstSink: CaptureSink;
  key: string;
  slotId: string;
  resolve: () => void;
  reject: (err: Error) => void;
}

export interface MachineCapture {
  proc: ChildProcess;
  maxFps: number;
  maxSize: number;
  sessions: Map<string, MacWindowSession>;
  sinkToTarget: Map<string, string>;
  windowIndexToTarget: Map<number, string>;
  buffer: Buffer;
  pendingAdd: PendingAdd | null;
  addQueue: Array<PendingAdd & { config: ScreenCaptureConfig }>;
  nextSessionOrdinal: number;
}

export interface StartRecordingParams {
  recordingId: string;
  outputPath: string;
  windowName?: string;
  appName?: string;
  targetPid?: number;
  maxFps?: number;
  maxSize?: number;
}

export interface StartProbeParams {
  probeId: string;
  windowName?: string;
  appName?: string;
  targetPid?: number;
  maxFps?: number;
  maxSize?: number;
}
