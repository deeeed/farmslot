import { hostname } from 'node:os';

import WebSocket from 'ws';

import {
  type Frame,
  type GatewayAuthConnectResult,
  Methods,
  PROTOCOL_VERSION,
  type RecipeRuntimeCapabilityDeclaration,
  type RequestFrame,
  type ResponseFrame,
} from '@farmslot/protocol';

import { captureHelperPath } from './commands/capture-helper-path.js';
import { exec } from './commands/exec.js';
import {
  fsCheckIgnore,
  fsDelete,
  fsExists,
  fsHash,
  fsList,
  fsMkdir,
  fsRead,
  fsReadBase64,
  fsReadChunk,
  fsRealpath,
  fsRename,
  fsStat,
  fsWatchStart,
  fsWatchStop,
  fsWatchStopAll,
  fsWrite,
  fsWriteChunk,
  fsWriteFiles,
} from './commands/fs.js';
import {
  getResourceWatchRuntimeStats,
  type ResourceStatusChange,
  startResourceWatch,
  stopAllResourceWatches,
  stopResourceWatch,
  type WatchInstruction,
} from './commands/resource-watch.js';
import {
  type ScreenCaptureConfig,
  startCapture,
  stopAllCaptures,
  stopCapture,
} from './commands/screen.js';
import { startScreenControlServer, stopScreenControlServer } from './commands/screen-control.js';
import {
  collectMetrics,
  startMetricsSubscription,
  stopMetricsSubscription,
} from './commands/system-metrics.js';
import * as tmux from './commands/tmux.js';
import { startTmuxWorkerWatch, stopTmuxWorkerWatch } from './commands/tmux-worker-watch.js';
import { isDeterministicAuthRejection, resolveGatewayCredential } from './gateway-credential.js';

const GATEWAY_URL = process.env.GATEWAY_URL ?? 'ws://localhost:7777';
const MACHINE_NAME = process.env.MACHINE_NAME ?? hostname();
const MAX_BACKOFF = 30_000;

let ws: WebSocket | null = null;
let backoff = 500;
let disposed = false;
// One hint per distinct auth-rejection cause per process — the rejection
// itself still logs every cycle.
let lastAuthHint: string | null = null;

function connect(): void {
  if (disposed) return;

  console.log(`Connecting to gateway at ${GATEWAY_URL} as "${MACHINE_NAME}"...`);
  ws = new WebSocket(GATEWAY_URL);

  ws.on('open', () => {
    console.log('Connected to gateway');
    // Backoff is NOT reset here: a socket that opens and is then rejected by
    // auth would otherwise retry at the floor forever (observed post-ADR-051
    // as a 500ms spin). It resets in authenticateThenRegister once auth
    // actually succeeds.
    authenticateThenRegister();
  });

  ws.on('message', async (raw: Buffer) => {
    try {
      const frame: Frame = JSON.parse(raw.toString());
      if (frame.type === 'req') {
        await handleRequest(frame);
      }
    } catch (err) {
      console.error('Failed to handle message:', err);
    }
  });

  ws.on('close', () => {
    console.log('Disconnected from gateway');
    fsWatchStopAll();
    stopMetricsSubscription();
    stopAllCaptures();
    stopAllResourceWatches();
    stopTmuxWorkerWatch();
    ws = null;
    scheduleReconnect();
  });

  ws.on('error', (err) => {
    console.error('WebSocket error:', err.message);
  });
}

function scheduleReconnect(): void {
  if (disposed) return;
  console.log(`Reconnecting in ${backoff}ms...`);
  setTimeout(() => connect(), backoff);
  backoff = Math.min(backoff * 2, MAX_BACKOFF);
}

function sendGatewayRequest<T>(method: string, params: unknown): Promise<T> {
  const socket = ws;
  if (!socket || socket.readyState !== WebSocket.OPEN)
    throw new Error('Gateway WebSocket is not open');
  const id = `${method}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const frame: RequestFrame = { type: 'req', id, method, params };
  return new Promise<T>((resolve, reject) => {
    const onMessage = (raw: Buffer) => {
      const parsed = JSON.parse(raw.toString()) as Frame;
      if (parsed.type !== 'res' || parsed.id !== id) return;
      socket.off('message', onMessage);
      if (parsed.ok) {
        resolve(parsed.payload as T);
      } else {
        reject(new Error(parsed.error?.message ?? 'Gateway request failed'));
      }
    };
    socket.on('message', onMessage);
    socket.send(JSON.stringify(frame));
  });
}

async function authenticateThenRegister(): Promise<void> {
  try {
    // Re-read on every connection attempt so issued/rotated node credentials take
    // effect on reconnect without restarting the daemon.
    const gatewayCredential = resolveGatewayCredential();
    await sendGatewayRequest<GatewayAuthConnectResult>(Methods.AUTH_CONNECT, {
      clientKind: 'node',
      clientName: MACHINE_NAME,
      protocolVersion: PROTOCOL_VERSION,
      ...(gatewayCredential?.token ? { token: gatewayCredential.token } : {}),
      ...(gatewayCredential?.password ? { password: gatewayCredential.password } : {}),
    });
    // Auth accepted — this connection is healthy, so future transport drops
    // start their retry climb from the floor again, and a later auth
    // regression earns a fresh hint.
    backoff = 500;
    lastAuthHint = null;
    const connectFrame: RequestFrame = {
      type: 'req',
      id: 'connect-0',
      method: 'node.connect',
      params: {
        machine: MACHINE_NAME,
        pid: process.pid,
        protocolVersion: PROTOCOL_VERSION,
        capabilities: await collectCaptureCapabilities(),
      },
    };
    ws?.send(JSON.stringify(connectFrame));
  } catch (err) {
    const message = (err as Error).message;
    console.error(`Gateway authentication failed: ${message}`);
    if (isDeterministicAuthRejection(message)) {
      // Retrying faster cannot fix these — go straight to the ceiling. The
      // credential-issue hint applies ONLY to the node-subject rejection;
      // generic auth failures (bad token, rate limit) get no misleading
      // advice, and each distinct cause prints its hint once per process.
      backoff = MAX_BACKOFF;
      if (/node-subject principal/i.test(message) && lastAuthHint !== 'node-subject') {
        lastAuthHint = 'node-subject';
        console.error(
          `This gateway requires a node-subject credential for "${MACHINE_NAME}". ` +
            `Fix: farmslot credential issue --subject node --machine ${MACHINE_NAME} --write-node-env ` +
            `(remote machines: deliver the secret via deploy-node.sh), then the next retry picks it up.`,
        );
      }
    }
    ws?.close();
  }
}

interface CaptureHelperDoctorDocument {
  ok?: boolean;
  checks?: Array<{ ok?: boolean; required?: boolean; code?: string; message?: string }>;
}

async function collectCaptureCapabilities(): Promise<RecipeRuntimeCapabilityDeclaration[]> {
  if (process.platform !== 'darwin') {
    return captureCapabilities('unsupported', 'capture-helper capture is macOS-only');
  }
  try {
    const helper = shellQuote(captureHelperPath());
    const { stdout, stderr, exitCode } = await exec({
      cmd: `${helper} doctor --json`,
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
    });
    if (exitCode !== 0) {
      throw new Error(stderr.trim() || stdout.trim() || `exit ${exitCode}`);
    }
    const doctor = JSON.parse(stdout) as CaptureHelperDoctorDocument;
    if (doctor.ok === false) {
      const failed = (doctor.checks ?? []).filter((check) => check.required && !check.ok);
      const reason =
        failed
          .map((check) => check.message ?? check.code)
          .filter(Boolean)
          .join('; ') || 'capture-helper doctor reported required failures';
      return captureCapabilities('unsupported', reason);
    }
    return captureCapabilities('supported');
  } catch (error) {
    // Capability discovery is recoverable: report unsupported status so the gateway can show
    // the install/permission problem instead of hiding the node.
    return captureCapabilities(
      'unsupported',
      `capture-helper doctor failed: ${errorMessage(error)}`,
    );
  }
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function captureCapabilities(
  status: RecipeRuntimeCapabilityDeclaration['status'],
  reason?: string,
): RecipeRuntimeCapabilityDeclaration[] {
  const unsupported = status === 'unsupported';
  return [
    {
      capability: 'capture.screenshot',
      status,
      provider: 'capture-helper',
      ...(unsupported ? { reason } : { platforms: ['macos'], artifactTypes: ['image/png'] }),
    },
    {
      capability: 'capture.stream',
      status,
      provider: 'capture-helper',
      ...(unsupported ? { reason } : { platforms: ['macos'], modes: ['framed-h264'] }),
    },
    {
      capability: 'record.video',
      status,
      provider: 'capture-helper',
      ...(unsupported
        ? { reason }
        : { platforms: ['macos'], modes: ['full_run'], artifactTypes: ['video/mp4'] }),
    },
  ];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sendResponse(
  id: string,
  ok: boolean,
  payload?: unknown,
  error?: string,
  errorCode?: string,
): void {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  const frame: ResponseFrame = {
    type: 'res',
    id,
    ok,
    payload: ok ? payload : undefined,
    error: ok ? undefined : { code: errorCode ?? 'EXEC_ERROR', message: error ?? 'Unknown error' },
  };
  ws.send(JSON.stringify(frame));
}

// Extract a string param, throwing if missing
function requireString(params: Record<string, unknown>, key: string): string {
  const val = params[key];
  if (typeof val !== 'string') throw new Error(`Missing required string param: ${key}`);
  return val;
}

function requireNumber(params: Record<string, unknown>, key: string): number {
  const val = params[key];
  if (typeof val !== 'number' || !Number.isFinite(val)) {
    throw new Error(`Missing required number param: ${key}`);
  }
  return val;
}

function parseScreenCaptureConfig(params: Record<string, unknown>): ScreenCaptureConfig {
  const slotId = requireString(params, 'slotId');
  const platform = requireString(params, 'platform');
  return {
    slotId,
    platform,
    ...(typeof params.resourceId === 'string' ? { resourceId: params.resourceId } : {}),
    ...(typeof params.maxFps === 'number' ? { maxFps: params.maxFps } : {}),
    ...(typeof params.maxSize === 'number' ? { maxSize: params.maxSize } : {}),
    ...(typeof params.windowAppName === 'string' ? { windowAppName: params.windowAppName } : {}),
    ...(typeof params.iosWindowName === 'string' ? { iosWindowName: params.iosWindowName } : {}),
    ...(typeof params.androidSerial === 'string' ? { androidSerial: params.androidSerial } : {}),
    ...(typeof params.browserPid === 'number' ? { browserPid: params.browserPid } : {}),
    ...(typeof params.cdpPort === 'number' ? { cdpPort: params.cdpPort } : {}),
    ...(typeof params.repo === 'string' ? { repo: params.repo } : {}),
    ...(typeof params.runtimeDir === 'string' ? { runtimeDir: params.runtimeDir } : {}),
  };
}

async function handleRequest(frame: RequestFrame): Promise<void> {
  const params = (frame.params ?? {}) as Record<string, unknown>;

  try {
    switch (frame.method) {
      case 'exec': {
        const hasCmd = typeof params.cmd === 'string';
        const hasArgv = Array.isArray(params.argv);
        if (hasCmd === hasArgv) {
          throw new Error('exec requires exactly one of cmd or argv');
        }
        let command: { cmd: string } | { argv: string[] };
        if (hasCmd) {
          command = { cmd: params.cmd as string };
        } else {
          const rawArgv = params.argv;
          if (!Array.isArray(rawArgv)) throw new Error('exec requires exactly one of cmd or argv');
          const argv = rawArgv.map((arg: unknown) => {
            if (typeof arg !== 'string') {
              throw new Error('exec argv must contain only strings');
            }
            return arg;
          });
          if (argv.length === 0) throw new Error('exec argv must contain at least one element');
          command = { argv };
        }
        const cwd = typeof params.cwd === 'string' ? params.cwd : undefined;
        const timeout = typeof params.timeout === 'number' ? params.timeout : undefined;
        const maxBuffer = typeof params.maxBuffer === 'number' ? params.maxBuffer : undefined;
        const result = await exec({ ...command, cwd, timeout, maxBuffer }, (stream, data) => {
          if (!ws || ws.readyState !== WebSocket.OPEN) return;
          ws.send(
            JSON.stringify({
              type: 'event',
              event: 'node.exec.output',
              payload: { requestId: frame.id, machine: MACHINE_NAME, stream, data },
            }),
          );
        });
        sendResponse(frame.id, true, result);
        break;
      }

      case 'tmux.capture': {
        const session = requireString(params, 'session');
        const lines = typeof params.lines === 'number' ? params.lines : 200;
        const result = await tmux.capture(session, lines);
        sendResponse(frame.id, true, { lines: result });
        break;
      }

      case 'tmux.send': {
        const session = requireString(params, 'session');
        const text = requireString(params, 'text');
        const enter = typeof params.enter === 'boolean' ? params.enter : true;
        await tmux.send(session, text, enter);
        sendResponse(frame.id, true, { sent: true });
        break;
      }

      case 'tmux.resize': {
        const target = requireString(params, 'target');
        const cols = requireNumber(params, 'cols');
        const rows = requireNumber(params, 'rows');
        await tmux.resizePane(target, cols, rows);
        sendResponse(frame.id, true, { resized: true });
        break;
      }

      case 'tmux.list': {
        const sessions = await tmux.listSessions();
        sendResponse(frame.id, true, { sessions });
        break;
      }

      case 'tmux.panes': {
        const panes = await tmux.listPanes();
        sendResponse(frame.id, true, { panes });
        break;
      }

      case 'tmux.worker.watch.start': {
        const intervalMs = typeof params.intervalMs === 'number' ? params.intervalMs : undefined;
        startTmuxWorkerWatch(intervalMs, (change) => {
          if (!ws || ws.readyState !== WebSocket.OPEN) return;
          ws.send(
            JSON.stringify({
              type: 'event',
              event: 'node.tmux.workers.changed',
              payload: { machine: MACHINE_NAME, ...change },
            }),
          );
        });
        sendResponse(frame.id, true, { watching: true });
        break;
      }

      case 'tmux.worker.watch.stop': {
        stopTmuxWorkerWatch();
        sendResponse(frame.id, true, { stopped: true });
        break;
      }

      case 'fs.list': {
        const root = requireString(params, 'root');
        const relPath = requireString(params, 'relPath');
        const result = await fsList({ root, relPath });
        sendResponse(frame.id, true, result);
        break;
      }

      case 'fs.read': {
        const root = requireString(params, 'root');
        const relPath = requireString(params, 'relPath');
        const result = await fsRead({ root, relPath });
        sendResponse(frame.id, true, result);
        break;
      }

      case 'fs.readBase64': {
        const root = requireString(params, 'root');
        const relPath = requireString(params, 'relPath');
        const maxBytes = typeof params.maxBytes === 'number' ? params.maxBytes : undefined;
        const result = await fsReadBase64({ root, relPath, maxBytes });
        sendResponse(frame.id, true, result);
        break;
      }

      case 'fs.readChunk': {
        const root = requireString(params, 'root');
        const relPath = requireString(params, 'relPath');
        const offset = requireNumber(params, 'offset');
        const length = requireNumber(params, 'length');
        const result = await fsReadChunk({ root, relPath, offset, length });
        sendResponse(frame.id, true, result);
        break;
      }

      case 'fs.writeChunk': {
        const root = requireString(params, 'root');
        const relPath = requireString(params, 'relPath');
        const offset = requireNumber(params, 'offset');
        const content = requireString(params, 'content');
        const truncate = params.truncate === true;
        const mode =
          typeof params.mode === 'number' && Number.isInteger(params.mode)
            ? params.mode
            : undefined;
        const result = await fsWriteChunk({ root, relPath, offset, content, truncate, mode });
        sendResponse(frame.id, true, result);
        break;
      }

      case 'fs.hash': {
        const root = requireString(params, 'root');
        const relPath = requireString(params, 'relPath');
        const result = await fsHash({ root, relPath });
        sendResponse(frame.id, true, result);
        break;
      }

      case 'fs.stat': {
        const root = requireString(params, 'root');
        const relPath = requireString(params, 'relPath');
        const result = await fsStat({ root, relPath });
        sendResponse(frame.id, true, result);
        break;
      }

      case 'fs.realpath': {
        const root = requireString(params, 'root');
        const relPath = requireString(params, 'relPath');
        const result = await fsRealpath({ root, relPath });
        sendResponse(frame.id, true, result);
        break;
      }

      case 'fs.write': {
        const root = requireString(params, 'root');
        const relPath = requireString(params, 'relPath');
        const content = requireString(params, 'content');
        const result = await fsWrite({ root, relPath, content });
        sendResponse(frame.id, true, result);
        break;
      }

      case 'fs.writeFiles': {
        const root = requireString(params, 'root');
        const relPath = requireString(params, 'relPath');
        const rawFiles = params.files;
        if (!Array.isArray(rawFiles)) {
          throw new Error('Missing required array param: files');
        }
        const files = rawFiles.map((entry) => {
          const file = entry as Record<string, unknown>;
          if (typeof file.path !== 'string' || typeof file.content !== 'string') {
            throw new Error('fs.writeFiles entries require string path and content');
          }
          return {
            path: file.path,
            content: file.content,
            mode: typeof file.mode === 'number' ? file.mode : undefined,
          };
        });
        const result = await fsWriteFiles({ root, relPath, files });
        sendResponse(frame.id, true, result);
        break;
      }

      case 'fs.rename': {
        const root = requireString(params, 'root');
        const oldRelPath = requireString(params, 'oldRelPath');
        const newRelPath = requireString(params, 'newRelPath');
        const result = await fsRename({ root, oldRelPath, newRelPath });
        sendResponse(frame.id, true, result);
        break;
      }

      case 'fs.delete': {
        const root = requireString(params, 'root');
        const relPath = requireString(params, 'relPath');
        const result = await fsDelete({ root, relPath });
        sendResponse(frame.id, true, result);
        break;
      }

      case 'fs.mkdir': {
        const root = requireString(params, 'root');
        const relPath = requireString(params, 'relPath');
        const result = await fsMkdir({ root, relPath });
        sendResponse(frame.id, true, result);
        break;
      }

      case 'fs.exists': {
        const root = requireString(params, 'root');
        const relPath = requireString(params, 'relPath');
        const result = await fsExists({ root, relPath });
        sendResponse(frame.id, true, result);
        break;
      }

      case 'fs.checkIgnore': {
        const repoPath = requireString(params, 'repoPath');
        const names = Array.isArray((params as Record<string, unknown>).names)
          ? ((params as Record<string, unknown>).names as unknown[]).filter(
              (n): n is string => typeof n === 'string',
            )
          : [];
        const result = await fsCheckIgnore({ repoPath, names });
        sendResponse(frame.id, true, result);
        break;
      }

      case 'fs.watch': {
        const watchPath = requireString(params, 'path');
        fsWatchStart(frame.id, { path: watchPath }, (content) => {
          if (!ws || ws.readyState !== WebSocket.OPEN) return;
          ws.send(
            JSON.stringify({
              type: 'event',
              event: 'node.fs.changed',
              payload: { requestId: frame.id, machine: MACHINE_NAME, path: watchPath, content },
            }),
          );
        });
        sendResponse(frame.id, true, { watching: true });
        break;
      }

      case 'fs.watch.stop': {
        const stopId = requireString(params, 'requestId');
        const stopped = fsWatchStop(stopId);
        sendResponse(frame.id, true, { stopped });
        break;
      }

      case 'system.metrics': {
        // Keep a completed census queued for the subscribed node.metrics event; an ad-hoc
        // gauge RPC must not consume the only process sample before the gateway sees it.
        const metrics = await collectMetrics({ consumeProcessInventory: false });
        sendResponse(frame.id, true, metrics);
        break;
      }

      case 'system.metrics.subscribe': {
        const interval = typeof params.intervalMs === 'number' ? params.intervalMs : 30_000;
        startMetricsSubscription(interval, (metrics) => {
          if (!ws || ws.readyState !== WebSocket.OPEN) return;
          ws.send(
            JSON.stringify({
              type: 'event',
              event: 'node.metrics',
              payload: { machine: MACHINE_NAME, metrics },
            }),
          );
        });
        sendResponse(frame.id, true, { subscribed: true, intervalMs: interval });
        break;
      }

      case 'system.metrics.unsubscribe': {
        stopMetricsSubscription();
        sendResponse(frame.id, true, { unsubscribed: true });
        break;
      }

      case 'screen.subscribe': {
        const config = parseScreenCaptureConfig(params);
        await startCapture(config, (frame: Buffer) => {
          if (!ws || ws.readyState !== WebSocket.OPEN) return;
          // Backpressure: drop P-frames when buffer is > 1MB
          if (ws.bufferedAmount > 1_048_576) {
            if (frame.length > 1 && (frame[1] & 1) === 0) return; // not keyframe
          }
          ws.send(frame);
        });
        sendResponse(frame.id, true, { ok: true });
        break;
      }

      case 'screen.unsubscribe': {
        stopCapture(parseScreenCaptureConfig(params));
        sendResponse(frame.id, true, { ok: true });
        break;
      }

      case 'screen.thumbnail': {
        const { screenshotForSlot } = await import('./commands/screen.js');
        const result = await screenshotForSlot(params as Record<string, unknown>);
        sendResponse(frame.id, true, result);
        break;
      }

      case 'resource.watch.start': {
        const slotId = requireString(params, 'slotId');
        const resources = params.resources as WatchInstruction[];
        const count = startResourceWatch(slotId, resources, (change: ResourceStatusChange) => {
          if (!ws || ws.readyState !== WebSocket.OPEN) return;
          ws.send(
            JSON.stringify({
              type: 'event',
              event: 'node.resource.changed',
              payload: { machine: MACHINE_NAME, ...change },
            }),
          );
        });
        sendResponse(frame.id, true, { watching: true, count });
        break;
      }

      case 'resource.watch.stop': {
        const stopSlotId = requireString(params, 'slotId');
        stopResourceWatch(stopSlotId);
        sendResponse(frame.id, true, { stopped: true });
        break;
      }

      case 'health.check': {
        sendResponse(frame.id, true, {
          machine: MACHINE_NAME,
          pid: process.pid,
          uptime: process.uptime(),
          platform: process.platform,
          resourceWatches: getResourceWatchRuntimeStats(),
        });
        break;
      }

      default:
        sendResponse(frame.id, false, undefined, `Unknown method: ${frame.method}`);
    }
  } catch (err) {
    const error = err as NodeJS.ErrnoException;
    sendResponse(
      frame.id,
      false,
      undefined,
      err instanceof Error ? err.message : String(err),
      typeof error.code === 'string' ? error.code : undefined,
    );
  }
}

function shutdown(): void {
  console.log('Shutting down node...');
  disposed = true;
  stopScreenControlServer();
  stopAllCaptures();
  stopAllResourceWatches();
  stopTmuxWorkerWatch();
  ws?.close();
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

if (process.platform === 'darwin') {
  startScreenControlServer();
}

connect();
