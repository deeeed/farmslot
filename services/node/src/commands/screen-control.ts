import { existsSync, unlinkSync } from 'node:fs';
import { createServer, type Server } from 'node:net';

import {
  getMacOsCaptureOwnerStatus,
  startMacOsProbe,
  startMacOsRecording,
  stopMacOsProbe,
  stopMacOsRecording,
} from './screen.js';

interface RecordStartRequest {
  op: 'record.start';
  recordingId: string;
  outputPath: string;
  windowName?: string;
  appName?: string;
  targetPid?: number;
  maxFps?: number;
  maxSize?: number;
}

interface RecordStopRequest {
  op: 'record.stop';
  recordingId: string;
}

interface StatusRequest {
  op: 'status';
}

interface ProbeStartRequest {
  op: 'probe.start';
  probeId: string;
  windowName?: string;
  appName?: string;
  targetPid?: number;
  maxFps?: number;
  maxSize?: number;
}

interface ProbeStopRequest {
  op: 'probe.stop';
  probeId: string;
}

type ControlRequest =
  | RecordStartRequest
  | RecordStopRequest
  | ProbeStartRequest
  | ProbeStopRequest
  | StatusRequest;

let server: Server | null = null;
let exitHookInstalled = false;

function socketPath(): string {
  return (
    process.env.SCREEN_CONTROL_SOCKET ??
    `/tmp/farmslot-screen-control-${typeof process.getuid === 'function' ? process.getuid() : '0'}.sock`
  );
}

function cleanupSocket(): void {
  const path = socketPath();
  if (existsSync(path)) {
    try {
      unlinkSync(path);
    } catch {
      /* ignore */
    }
  }
}

async function handleRequest(request: ControlRequest): Promise<Record<string, unknown>> {
  switch (request.op) {
    case 'record.start': {
      const result = await startMacOsRecording({
        recordingId: request.recordingId,
        outputPath: request.outputPath,
        windowName: request.windowName,
        appName: request.appName,
        targetPid: request.targetPid,
        maxFps: request.maxFps,
        maxSize: request.maxSize,
      });
      return { ok: true, ...result };
    }
    case 'record.stop': {
      stopMacOsRecording(request.recordingId);
      return { ok: true, recordingId: request.recordingId };
    }
    case 'probe.start': {
      const result = await startMacOsProbe({
        probeId: request.probeId,
        windowName: request.windowName,
        appName: request.appName,
        targetPid: request.targetPid,
        maxFps: request.maxFps,
        maxSize: request.maxSize,
      });
      return { ok: true, ...result };
    }
    case 'probe.stop': {
      stopMacOsProbe(request.probeId);
      return { ok: true, probeId: request.probeId };
    }
    case 'status': {
      return { ok: true, socketPath: socketPath(), ...getMacOsCaptureOwnerStatus() };
    }
    default:
      return { ok: false, error: `unknown op: ${(request as { op?: string }).op ?? 'unknown'}` };
  }
}

export function startScreenControlServer(): void {
  if (process.platform !== 'darwin' || server) return;

  cleanupSocket();
  const path = socketPath();
  server = createServer((socket) => {
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk.toString();
      const newline = buffer.indexOf('\n');
      if (newline === -1) return;
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      (async () => {
        try {
          const request = JSON.parse(line) as ControlRequest;
          const response = await handleRequest(request);
          socket.end(`${JSON.stringify(response)}\n`);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          socket.end(`${JSON.stringify({ ok: false, error: message })}\n`);
        }
      })().catch(() => {
        socket.end(`${JSON.stringify({ ok: false, error: 'unexpected control-plane failure' })}\n`);
      });
    });
  });

  server.listen(path, () => {
    console.log(`[screen-control] listening on ${path}`);
  });

  server.on('error', (err) => {
    console.error(`[screen-control] error: ${err.message}`);
  });

  if (!exitHookInstalled) {
    exitHookInstalled = true;
    process.on('exit', cleanupSocket);
    process.on('SIGTERM', cleanupSocket);
    process.on('SIGINT', cleanupSocket);
  }
}

export function stopScreenControlServer(): void {
  if (!server) return;
  server.close();
  server = null;
  cleanupSocket();
}

export function getScreenControlSocketPath(): string {
  return socketPath();
}
