import { readFile } from 'node:fs/promises';
import { hostname } from 'node:os';

import WebSocket from 'ws';

import { expandTilde } from '@farmslot/capabilities/fs-watch';
import {
  type Frame,
  type NodeFsChangedPayload,
  type NodeFsWatchResult,
  PROTOCOL_VERSION,
  type RecipeRuntimeCapabilityDeclaration,
  type RequestFrame,
  type ResponseFrame,
} from '@farmslot/protocol';

import { captureHelperPath } from './commands/capture-helper-path.js';
import { exec } from './commands/exec.js';
import { ExecRequests } from './commands/exec-requests.js';
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
import { NativeNodeSessions } from './commands/native-session.js';
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
import { NodeSources } from './commands/sources.js';
import {
  collectMetrics,
  startMetricsSubscription,
  stopMetricsSubscription,
} from './commands/system-metrics.js';
import * as tmux from './commands/tmux.js';
import { startTmuxWorkerWatch, stopTmuxWorkerWatch } from './commands/tmux-worker-watch.js';
import {
  startWorkspaceWatch,
  stopAllWorkspaceWatches,
  stopWorkspaceWatch,
} from './commands/workspace-watch.js';
import { resolveGatewayCredential } from './gateway-credential.js';
import {
  authenticateNode,
  describeHandshakeFailure,
  isDeterministicHandshakeRejection,
  registerNode,
} from './gateway-handshake.js';

const GATEWAY_URL = process.env.GATEWAY_URL ?? 'ws://localhost:7777';
const MACHINE_NAME = process.env.MACHINE_NAME ?? hostname();
const MAX_TRANSPORT_BACKOFF = 2_000;
const AUTH_RETRY_DELAY = 30_000;
const nativeSessions = new NativeNodeSessions(MACHINE_NAME);
const sources = new NodeSources(MACHINE_NAME);

const execConnections = new Map<WebSocket, ExecRequests>();
let ws: WebSocket | null = null;
let backoff = 500;
let disposed = false;
// One hint per distinct auth-rejection cause per process — the rejection
// itself still logs every cycle.
let lastAuthHint: string | null = null;

function connect(): void {
  if (disposed) return;

  console.log(`Connecting to gateway at ${GATEWAY_URL} as "${MACHINE_NAME}"...`);
  const socket = new WebSocket(GATEWAY_URL, { handshakeTimeout: 5_000 });
  ws = socket;
  const requests = new ExecRequests();
  execConnections.set(socket, requests);

  socket.on('open', () => {
    console.log('Transport open; authenticating and registering with gateway');
    // Backoff is NOT reset here: a socket that opens and is then rejected by
    // auth or registration would otherwise retry at the floor forever
    // (observed post-ADR-051 as a 500ms spin). It resets in handshake() once
    // the gateway has ACKed node.connect.
    void handshake(socket);
  });

  socket.on('message', async (raw: Buffer) => {
    try {
      const frame: Frame = JSON.parse(raw.toString());
      if (frame.type === 'req') {
        if (disposed && frame.method !== 'exec.cancel') {
          sendResponse(frame.id, false, undefined, 'Node is shutting down.', undefined, socket);
          return;
        }
        await handleRequest(frame, socket, requests);
      }
    } catch (err) {
      console.error('Failed to handle message:', err);
    }
  });

  socket.on('close', () => {
    void requests.close().then(() => execConnections.delete(socket));
    if (ws !== socket) {
      // A superseded socket closing late must not tear down the subscriptions
      // the current socket owns, nor schedule a second reconnect chain.
      console.log('Superseded gateway socket closed');
      return;
    }
    console.log('Disconnected from gateway');
    nativeSessions.stopObservation();
    fsWatchStopAll();
    stopAllWorkspaceWatches();
    stopMetricsSubscription();
    stopAllCaptures();
    stopAllResourceWatches();
    stopTmuxWorkerWatch();
    ws = null;
    scheduleReconnect();
  });

  socket.on('error', (err) => {
    console.error('WebSocket error:', err.message);
  });
}

function scheduleReconnect(): void {
  if (disposed) return;
  console.log(`Reconnecting in ${backoff}ms...`);
  setTimeout(() => connect(), backoff);
  backoff = Math.min(backoff * 2, MAX_TRANSPORT_BACKOFF);
}

/**
 * auth.connect, then node.connect, on the socket this attempt owns. The node
 * is "connected" only once the gateway ACKs node.connect: auth alone does not
 * list the machine, and a registration refusal (native-owner mismatch,
 * machine assigned to another principal) used to sit silently on an open
 * socket forever. Every failure closes THIS socket and reports the gateway's
 * code and message; a socket that was superseded while awaiting never touches
 * the newer one.
 */
async function handshake(socket: WebSocket): Promise<void> {
  let step = 'authentication';
  try {
    // Re-read on every connection attempt so issued/rotated node credentials take
    // effect on reconnect without restarting the daemon.
    const credential = resolveGatewayCredential();
    await authenticateNode(socket, { machine: MACHINE_NAME, credential });
    step = 'registration';
    const capabilities = await collectCaptureCapabilities();
    await registerNode(socket, {
      machine: MACHINE_NAME,
      pid: process.pid,
      capabilities,
      nativeSessions: nativeSessions.declaration,
      gatewayUrl: GATEWAY_URL,
      execCancellation: true,
      observationCapabilities: { workers: 1, files: 1, workspace: 1 },
    });
    if (ws !== socket) {
      // Superseded while awaiting: the newer socket runs its own handshake and
      // owns backoff state. Release this one without disturbing it.
      socket.close();
      return;
    }
    // One source owner per daemon, reannounced only on this authenticated socket.
    try {
      await nativeSessions.startObservation((receipt) => {
        if (ws === socket && socket.readyState === WebSocket.OPEN)
          socket.send(
            JSON.stringify({ type: 'event', event: 'node.native.observation', payload: receipt }),
          );
      });
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !('code' in error) ||
        error.code !== 'NATIVE_SOURCE_UNAVAILABLE'
      )
        throw error;
      // The source failure is explicit; imperative commands keep their existing route.
      const receipt = nativeSessions.observationReceipt();
      if (receipt && ws === socket && socket.readyState === WebSocket.OPEN)
        socket.send(
          JSON.stringify({ type: 'event', event: 'node.native.observation', payload: receipt }),
        );
    }
    if (ws !== socket || socket.readyState !== WebSocket.OPEN) return;
    // Registered — this connection is healthy, so future transport drops
    // start their retry climb from the floor again, and a later auth
    // regression earns a fresh hint.
    backoff = 500;
    lastAuthHint = null;
    console.log(`Registered with gateway as "${MACHINE_NAME}" (protocol ${PROTOCOL_VERSION})`);
  } catch (err) {
    const failure = describeHandshakeFailure(err);
    console.error(`Gateway ${step} failed [${failure.code}]: ${failure.message}`);
    if (failure.userAction) console.error(`Next: ${failure.userAction}`);
    if (ws === socket && isDeterministicHandshakeRejection(err)) {
      // Retrying faster cannot fix these — go straight to the ceiling. The
      // credential-issue hint applies ONLY to the node-subject rejection;
      // other refusals (bad token, rate limit, owner mismatch) already carry
      // the gateway's own message, and each hint prints once per process.
      backoff = AUTH_RETRY_DELAY;
      if (/node-subject principal/i.test(failure.message) && lastAuthHint !== 'node-subject') {
        lastAuthHint = 'node-subject';
        console.error(
          `This gateway requires a node-subject credential for "${MACHINE_NAME}". ` +
            `Fix: farmslot credential issue --principal <node-principal> --subject node --machine ${MACHINE_NAME} --secret-file <private-node-file>. ` +
            `For farmdev use $HOME/.farmslot-automation/${MACHINE_NAME}-node-automation.secret and restart farmdev; ` +
            `for another local stack use <FARMSLOT_HOME>/node.secret and restart it; for a remote node use deploy-node.sh --node-token-file <private-node-file>.`,
        );
      }
    }
    // Close only the socket this attempt owns; its close handler decides
    // whether a reconnect is due.
    socket.close();
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
  responseSocket?: WebSocket,
): void {
  const destination = responseSocket ?? ws;
  if (!destination || destination.readyState !== WebSocket.OPEN) return;
  const frame: ResponseFrame = {
    type: 'res',
    id,
    ok,
    payload: ok ? payload : undefined,
    error: ok ? undefined : { code: errorCode ?? 'EXEC_ERROR', message: error ?? 'Unknown error' },
  };
  destination.send(JSON.stringify(frame));
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

async function handleRequest(
  frame: RequestFrame,
  socket: WebSocket,
  requests: ExecRequests,
): Promise<void> {
  const params = (frame.params ?? {}) as Record<string, unknown>;
  const responseSocket =
    params.requestScoped === true || frame.method === 'exec.cancel' ? socket : undefined;

  try {
    switch (frame.method) {
      case 'sources.materialize': {
        const result = await sources.materialize(
          params.lock as import('@farmslot/protocol').SourceLock,
        );
        sendResponse(frame.id, true, result, undefined, undefined, socket);
        break;
      }
      case 'sources.verify': {
        const result = await sources.verify(params.lock as import('@farmslot/protocol').SourceLock);
        sendResponse(frame.id, true, result, undefined, undefined, socket);
        break;
      }
      case 'sources.status': {
        sendResponse(frame.id, true, await sources.status(), undefined, undefined, socket);
        break;
      }
      case 'native.session': {
        sendResponse(
          frame.id,
          true,
          params.observe === true
            ? await nativeSessions.routeObserved(params)
            : await nativeSessions.route(params),
          undefined,
          undefined,
          socket,
        );
        break;
      }
      case 'exec.cancel': {
        const requestId = requireString(params, 'requestId');
        sendResponse(
          frame.id,
          true,
          { cancelled: requests.cancel(requestId) },
          undefined,
          undefined,
          socket,
        );
        break;
      }
      case 'exec': {
        if (params.requestScoped !== undefined && typeof params.requestScoped !== 'boolean') {
          throw new Error('requestScoped must be a boolean');
        }
        const requestScoped = params.requestScoped === true;
        const closeoutTimeoutMs = params.closeoutTimeoutMs;
        if (
          closeoutTimeoutMs !== undefined &&
          (typeof closeoutTimeoutMs !== 'number' ||
            !Number.isInteger(closeoutTimeoutMs) ||
            closeoutTimeoutMs < 1 ||
            closeoutTimeoutMs > 300_000)
        ) {
          throw new Error('closeoutTimeoutMs must be an integer from 1 to 300000.');
        }
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
        const execute = (signal?: AbortSignal) =>
          exec(
            {
              ...command,
              cwd,
              timeout,
              maxBuffer,
              ...(typeof closeoutTimeoutMs === 'number' ? { closeoutTimeoutMs } : {}),
              ...(requestScoped ? { requestScoped: true } : {}),
            },
            (stream, data) => {
              const destination = responseSocket ?? ws;
              if (!destination || destination.readyState !== WebSocket.OPEN) return;
              destination.send(
                JSON.stringify({
                  type: 'event',
                  event: 'node.exec.output',
                  payload: { requestId: frame.id, machine: MACHINE_NAME, stream, data },
                }),
              );
            },
            signal,
          );
        const result = requestScoped ? await requests.run(frame.id, execute) : await execute();
        sendResponse(frame.id, true, result, undefined, undefined, responseSocket);
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
          if (ws !== socket || socket.readyState !== WebSocket.OPEN) return;
          socket.send(
            JSON.stringify({
              type: 'event',
              event: 'node.tmux.workers.changed',
              payload: { machine: MACHINE_NAME, ...change },
            }),
          );
        });
        sendResponse(
          frame.id,
          true,
          { watching: true, observations: 1 },
          undefined,
          undefined,
          socket,
        );
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
        if (params.workspace === 1) {
          const identity = {
            requestId: frame.id,
            machine: MACHINE_NAME,
            path: watchPath,
            workspace: 1,
          };
          const push = (payload: unknown) => {
            if (ws === socket && socket.readyState === WebSocket.OPEN)
              socket.send(JSON.stringify({ type: 'event', event: 'node.fs.changed', payload }));
          };
          await startWorkspaceWatch(
            frame.id,
            watchPath,
            () => push({ ...identity, kind: 'updated' }),
            (error) => push({ ...identity, kind: 'error', error: { message: error.message } }),
          );
          if (ws !== socket || socket.readyState !== WebSocket.OPEN) {
            stopWorkspaceWatch(frame.id);
            break;
          }
          sendResponse(frame.id, true, { workspace: 1, ready: true }, undefined, undefined, socket);
          break;
        }
        const observations = params.observations === 1;
        const sendChange = (payload: NodeFsChangedPayload) => {
          if (ws !== socket || socket.readyState !== WebSocket.OPEN) return;
          socket.send(
            JSON.stringify({
              type: 'event',
              event: 'node.fs.changed',
              payload,
            }),
          );
        };
        const identity = { requestId: frame.id, machine: MACHINE_NAME, path: watchPath };
        fsWatchStart(
          frame.id,
          { path: watchPath },
          (content) => sendChange({ ...identity, content }),
          observations
            ? {
                onUnavailable: (observation) =>
                  sendChange({ ...identity, content: '' as const, ...observation }),
              }
            : {},
        );
        let initial: NodeFsWatchResult['initial'] = undefined;
        if (observations) {
          try {
            initial = { kind: 'updated', content: await readFile(expandTilde(watchPath), 'utf-8') };
          } catch (error) {
            const failure = error as NodeJS.ErrnoException;
            initial =
              failure.code === 'ENOENT'
                ? { kind: 'deleted', content: '' }
                : {
                    kind: 'error',
                    content: '',
                    error: {
                      message: failure.message,
                      ...(failure.code ? { code: failure.code } : {}),
                    },
                  };
          }
        }
        sendResponse(
          frame.id,
          true,
          { watching: true, observations: 1, initial },
          undefined,
          undefined,
          socket,
        );
        break;
      }

      case 'fs.watch.stop': {
        const stopId = requireString(params, 'requestId');
        const stopped = stopWorkspaceWatch(stopId) || fsWatchStop(stopId);
        sendResponse(frame.id, true, { stopped });
        break;
      }

      case 'system.metrics': {
        // Keep a completed census queued for the subscribed node.metrics event; an ad-hoc
        // gauge RPC must not consume the only process sample before the gateway sees it.
        const metrics = await collectMetrics({
          consumeProcessInventory: false,
          machine: MACHINE_NAME,
        });
        sendResponse(frame.id, true, metrics);
        break;
      }

      case 'system.metrics.subscribe': {
        const interval = typeof params.intervalMs === 'number' ? params.intervalMs : 30_000;
        startMetricsSubscription(
          interval,
          (metrics) => {
            if (!ws || ws.readyState !== WebSocket.OPEN) return;
            ws.send(
              JSON.stringify({
                type: 'event',
                event: 'node.metrics',
                payload: { machine: MACHINE_NAME, metrics },
              }),
            );
          },
          MACHINE_NAME,
        );
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
      responseSocket,
    );
  }
}

async function shutdown(): Promise<void> {
  nativeSessions.stopObservation();
  if (disposed) return;
  console.log('Shutting down node...');
  disposed = true;
  await Promise.all([...execConnections.values()].map((requests) => requests.close()));
  stopScreenControlServer();
  stopAllCaptures();
  stopAllResourceWatches();
  stopTmuxWorkerWatch();
  ws?.close();
  await tmux.closeTmuxObservation();
  process.exit(0);
}

for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) {
  process.on(signal, () => {
    void shutdown();
  });
}

if (process.platform === 'darwin') {
  startScreenControlServer();
}

connect();
