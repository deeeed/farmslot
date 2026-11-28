import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs, {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import fsPromises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

import { WebSocket, WebSocketServer } from 'ws';

import { NativeSessionClient } from '@farmslot/agent-runtime/native';
import { observeAntigravityAccount } from '@farmslot/agent-runtime/native/antigravity';
import {
  canonicalTrustedExecutablesDigest,
  EMPTY_TRUSTED_EXECUTABLES_DIGEST,
  NativeHostObservation,
  type NativeSourceReceipt,
  type NativeSourceSnapshot,
} from '@farmslot/agent-runtime/native/observation';
import { routeNativeProfile } from '@farmslot/agent-runtime/native/profile-service';
import {
  DEFAULT_CLAUDE_MODEL,
  Methods,
  type NativeProfileStatusResult,
  normalizeRunner,
  type Principal,
  type RequestFrame,
} from '@farmslot/protocol';

import { computeCandidateStrategyFingerprint } from '../evals/package-store.js';
import { getNode, registerNode, unregisterByWs } from '../fleet/machine-registry.js';
import { handleNodeResponse, sendNodeRequest } from '../fleet/node-rpc.js';
import { createPoolWatcherHandlers, NATIVE_POOL_CHANGE_COALESCE_MS } from '../fleet/state.js';
import { resolvePreviewExecution, resolvePreviewModel } from '../methods/dispatch/preview.js';
import { axesForTrialTransport } from '../methods/eval/candidate-setup.js';
import {
  GatewayNativeObservations,
  nativeReadInterests,
} from '../resources/native-observations.js';
import { resolveRunDispatchRunnerModel } from '../run-engine/dispatch-policy.js';
import { createGatewayAuthRuntime } from '../security/auth.js';

import {
  loadTrustedNativeExecutableSnapshot,
  resolveTrustedNativeExecutable,
  resolveTrustedNativeExecutablesForNode,
  routeNativeExecution,
} from './native/node.js';
import { MACHINE_RUNNER_PATH_FIELDS } from './launch-command.js';
import {
  ModelCatalogFormatError,
  NodeModelCatalogs,
  nodeModelCatalogs,
  parseAntigravityModelCatalog,
} from './model-catalog.js';
import {
  assertRunnerTransport,
  getRunnerDefinition,
  isKnownRunner,
  runnerRequiresAccountResolvedModel,
  runnerSupportsEffort,
  runnerSupportsNativeTaskReuse,
} from './registry.js';
import { getHostRunnerSubscriptions } from './status-provider.js';
import { makeVars } from './test-fixtures.js';
import { resolveStrictAccountDispatchModel } from './visible-models.js';

test('antigravity registers as a native-only ACP runner with agy alias and node model catalog', () => {
  assert.equal(normalizeRunner('agy'), 'antigravity');
  assert.equal(isKnownRunner('antigravity'), true);
  assert.equal(isKnownRunner('agy'), true);
  const definition = getRunnerDefinition('antigravity');
  assert.equal(definition.id, 'antigravity');
  assert.equal(definition.nativeTransport, 'acp');
  assert.equal(definition.nativeOnly, true);
  assert.equal(definition.sessionContinuation.native, true);
  assert.equal(definition.sessionContinuation.terminal, null);
  assert.equal(definition.observabilityScope, 'none');
  assert.deepEqual(definition.nativeChoices?.modes, ['default', 'plan']);
  assert.equal(definition.nativeChoices?.efforts, undefined);
  assert.equal(runnerSupportsEffort('antigravity', 'gemini-3.8-flash-low', 'high'), false);
  assert.equal(runnerSupportsNativeTaskReuse('antigravity'), true);
  assert.ok(definition.modelCatalog && 'nodeCommand' in definition.modelCatalog);
  assert.equal(definition.modelCatalog.nodeCommand, 'agy');
  assert.equal(definition.modelCatalog.slotPathKey, 'antigravityPath');
  assert.equal(definition.modelCatalog.flatCatalog, true);
  assert.equal(definition.modelCatalog.strictAccountCatalog, true);
  assert.doesNotThrow(() => assertRunnerTransport('antigravity', 'native'));
  assert.throws(() => assertRunnerTransport('antigravity', 'tmux'), /requires native transport/);
});

test('parseAntigravityModelCatalog preserves stable IDs and display names and rejects empty output', () => {
  const sample = [
    '\r\u001b[32m⠋ Fetching available models...\u001b[0m\rgemini-4-neon-high\tGemini 4 Neon (High)',
    'gemini-3.8-flash-low\tGemini 3.8 Flash (Low)',
    'claude-opus-5-5-high   Claude Opus 5.5 (High)',
    'gemini-3.8-flash-low\tDuplicate Ignored',
  ].join('\n');

  const listing = parseAntigravityModelCatalog(sample);
  assert.deepEqual(listing.ids, [
    'gemini-4-neon-high',
    'gemini-3.8-flash-low',
    'claude-opus-5-5-high',
  ]);
  assert.deepEqual(listing.nativeIds, listing.ids);
  assert.deepEqual(listing.labels, {
    'gemini-4-neon-high': 'Gemini 4 Neon (High)',
    'gemini-3.8-flash-low': 'Gemini 3.8 Flash (Low)',
    'claude-opus-5-5-high': 'Claude Opus 5.5 (High)',
  });
  assert.equal(listing.flatCatalog, true);
  assert.equal(listing.strictAccountCatalog, true);

  assert.throws(
    () => parseAntigravityModelCatalog('Fetching available models...\n'),
    ModelCatalogFormatError,
  );
});

test('NodeModelCatalogs preserves Antigravity display names and blocks unavailable account models', () => {
  const store = new NodeModelCatalogs();
  const listing = parseAntigravityModelCatalog(
    'gemini-4-neon-high\tGemini 4 Neon (High)\ngemini-3.8-flash-low\tGemini 3.8 Flash (Low)\n',
  );
  assert.equal(store.accept('antigravity', 'macwork', listing), true);

  const result = store.result('antigravity');
  assert.equal(result.status, 'ready');
  assert.deepEqual(result.models, [
    { id: 'gemini-4-neon-high', label: 'Gemini 4 Neon (High)', reasoningModes: [], listed: true },
    {
      id: 'gemini-3.8-flash-low',
      label: 'Gemini 3.8 Flash (Low)',
      reasoningModes: [],
      listed: true,
    },
  ]);
  assert.deepEqual(store.labels('antigravity'), {
    'gemini-4-neon-high': 'Gemini 4 Neon (High)',
    'gemini-3.8-flash-low': 'Gemini 3.8 Flash (Low)',
  });

  // Available model passes
  assert.equal(store.blocker('antigravity', 'gemini-3.8-flash-low', 'macwork', 'native'), null);
  // Unavailable model on a strict account catalog is blocked even on a single-node fleet
  assert.match(
    store.blocker('antigravity', 'gemini-unavailable-99', 'macwork', 'native') ?? '',
    /not available for the macwork account/,
  );

  // Model labels scoped to authorized machines must not leak labels from unauthorized machines.
  const otherListing = parseAntigravityModelCatalog('gemini-secret-node-only\tSecret Node Model\n');
  assert.equal(store.accept('antigravity', 'secret-machine', otherListing), true);
  assert.deepEqual(store.labels('antigravity', ['macwork']), {
    'gemini-4-neon-high': 'Gemini 4 Neon (High)',
    'gemini-3.8-flash-low': 'Gemini 3.8 Flash (Low)',
  });
  assert.deepEqual(store.labels('antigravity', []), {});
});

test('Antigravity dispatch without a model never inherits Claude default and requires explicit/account-resolved model', () => {
  assert.equal(runnerRequiresAccountResolvedModel('antigravity'), true);
  assert.equal(runnerRequiresAccountResolvedModel('claude'), false);
  assert.equal(resolvePreviewModel({ runner: 'antigravity', model: null }), 'unknown');
  // Non-strictAccountCatalog / legacy custom runners preserve DEFAULT_CLAUDE_MODEL fallback compatibility.
  assert.equal(resolvePreviewModel({ runner: 'custom-legacy', model: null }), DEFAULT_CLAUDE_MODEL);
  assert.deepEqual(
    resolvePreviewExecution({ runner: 'claude', model: 'opus' }, { runner: 'antigravity' }),
    {
      runner: 'antigravity',
      model: 'unknown',
    },
  );
  assert.deepEqual(
    resolveRunDispatchRunnerModel(
      { metrics: { runner: 'antigravity', model: null, nudgeCount: 0 } },
      { runner: 'claude', model: 'opus' },
    ),
    { runner: 'antigravity', model: 'unknown' },
  );

  const isolatedHome = mkdtempSync(join(tmpdir(), 'agy-visible-models-'));
  const prevHome = process.env.FARMSLOT_HOME;
  try {
    process.env.FARMSLOT_HOME = isolatedHome;
    assert.throws(
      () => resolveStrictAccountDispatchModel('antigravity', undefined),
      /Select an explicit antigravity model available to the selected account before dispatch/,
    );
    assert.equal(
      resolveStrictAccountDispatchModel('antigravity', 'gemini-3.8-flash-low'),
      'gemini-3.8-flash-low',
    );
  } finally {
    if (prevHome === undefined) delete process.env.FARMSLOT_HOME;
    else process.env.FARMSLOT_HOME = prevHome;
    rmSync(isolatedHome, { recursive: true, force: true });
  }
});

test('eval strategy resolves native-only transport before hashing so omitted and explicit native share one fingerprint', () => {
  const baseAxes = {
    runner: { name: 'antigravity' },
    model: { name: 'gemini-3.8-flash-low' },
  };
  const omitted = axesForTrialTransport(baseAxes, undefined);
  const explicit = axesForTrialTransport(baseAxes, 'native');
  assert.equal(omitted.transport, 'native');
  assert.deepEqual(omitted, explicit);
  assert.equal(
    computeCandidateStrategyFingerprint({
      axes: omitted,
      source: { kind: 'merged-pr', repo: 'example/repo', prNumber: 1, baseSha: 'a'.repeat(40) },
      startRef: 'main',
      taskProfile: 'dev',
    }),
    computeCandidateStrategyFingerprint({
      axes: explicit,
      source: { kind: 'merged-pr', repo: 'example/repo', prNumber: 1, baseSha: 'a'.repeat(40) },
      startRef: 'main',
      taskProfile: 'dev',
    }),
  );
  assert.throws(() => axesForTrialTransport(baseAxes, 'tmux'), /requires native transport/);
});

test('resolveTrustedNativeExecutable and resolveTrustedNativeExecutablesForNode share MACHINE_RUNNER_PATH_FIELDS', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agy-pool-exec-'));
  const prevPoolDir = process.env.FARMSLOT_POOL_DIR;
  try {
    const tempPoolRoot = join(root, 'pool');
    mkdirSync(tempPoolRoot, { recursive: true });
    const configuredBin = join(root, 'custom-bin', 'agy');
    const configuredPi = join(root, 'custom-bin', 'pi');
    writeFileSync(
      join(tempPoolRoot, 'macwork.json'),
      JSON.stringify({
        machine: 'macwork',
        project: 'demo',
        host: 'localhost',
        ssh_user: process.env.USER || 'operator',
        os: process.platform,
        platform: 'cli',
        antigravity_path: configuredBin,
        pi_path: configuredPi,
        slots: [{ id: 'macwork-1', enabled: true, mode: 'dispatch', repo: root, session: 's1' }],
      }),
    );
    process.env.FARMSLOT_POOL_DIR = tempPoolRoot;
    assert.equal(MACHINE_RUNNER_PATH_FIELDS.antigravity, 'antigravity_path');
    assert.equal(await resolveTrustedNativeExecutable('antigravity', 'local'), configuredBin);
    assert.equal(await resolveTrustedNativeExecutable('agy', 'macwork'), configuredBin);
    assert.deepEqual(await resolveTrustedNativeExecutablesForNode('macwork'), {
      antigravity: configuredBin,
      pi: configuredPi,
    });

    // Canonical `<machine>.json` must win even when an auxiliary pool sorts earlier (canary-review-node.json).
    const canaryBin = join(root, 'canary-bin', 'agy');
    const primaryBin = join(root, 'primary-bin', 'agy');
    writeFileSync(
      join(tempPoolRoot, 'canary-review-node.json'),
      JSON.stringify({
        machine: 'review-node',
        project: 'canary',
        host: 'review-node.example',
        ssh_user: 'operator',
        os: process.platform,
        platform: 'cli',
        antigravity_path: canaryBin,
        slots: [
          { id: 'review-canary-1', enabled: true, mode: 'dispatch', repo: root, session: 's2' },
        ],
      }),
    );
    writeFileSync(
      join(tempPoolRoot, 'review-node.json'),
      JSON.stringify({
        machine: 'review-node',
        project: 'primary',
        host: 'review-node.example',
        ssh_user: 'operator',
        os: process.platform,
        platform: 'cli',
        antigravity_path: primaryBin,
        slots: [
          { id: 'review-primary-1', enabled: true, mode: 'dispatch', repo: root, session: 's3' },
        ],
      }),
    );
    assert.equal(await resolveTrustedNativeExecutable('antigravity', 'review-node'), primaryBin);
    assert.deepEqual(await resolveTrustedNativeExecutablesForNode('review-node'), {
      antigravity: primaryBin,
    });

    // Multiple auxiliary pools for a machine without `<machine>.json` must fail closed as ambiguous.
    writeFileSync(
      join(tempPoolRoot, 'aux-a-ambiguous.json'),
      JSON.stringify({
        machine: 'ambiguous-node',
        project: 'a',
        host: 'ambiguous.example',
        ssh_user: 'operator',
        os: process.platform,
        platform: 'cli',
        antigravity_path: canaryBin,
        slots: [{ id: 'ambig-1', enabled: true, mode: 'dispatch', repo: root, session: 's4' }],
      }),
    );
    writeFileSync(
      join(tempPoolRoot, 'aux-b-ambiguous.json'),
      JSON.stringify({
        machine: 'ambiguous-node',
        project: 'b',
        host: 'ambiguous.example',
        ssh_user: 'operator',
        os: process.platform,
        platform: 'cli',
        antigravity_path: primaryBin,
        slots: [{ id: 'ambig-2', enabled: true, mode: 'dispatch', repo: root, session: 's5' }],
      }),
    );
    await assert.rejects(
      resolveTrustedNativeExecutable('antigravity', 'ambiguous-node'),
      /ambiguous pool settings/,
    );
    await assert.rejects(
      resolveTrustedNativeExecutablesForNode('ambiguous-node'),
      /ambiguous pool settings/,
    );

    // Canonical pool determines local classification BEFORE selecting executables:
    // 1) Canonical remote + auxiliary localhost for the same machine must NOT classify as local.
    const remoteOnlyPoolRoot = join(root, 'pool-canonical-remote');
    mkdirSync(remoteOnlyPoolRoot, { recursive: true });
    writeFileSync(
      join(remoteOnlyPoolRoot, 'review-node.json'),
      JSON.stringify({
        machine: 'review-node',
        project: 'primary',
        host: 'review-node.example',
        ssh_user: 'operator',
        os: process.platform,
        platform: 'cli',
        antigravity_path: primaryBin,
        slots: [{ id: 'r1', enabled: true, mode: 'dispatch', repo: root, session: 's1' }],
      }),
    );
    writeFileSync(
      join(remoteOnlyPoolRoot, 'canary-review-node.json'),
      JSON.stringify({
        machine: 'review-node',
        project: 'canary',
        host: 'localhost',
        ssh_user: 'operator',
        os: process.platform,
        platform: 'cli',
        antigravity_path: canaryBin,
        slots: [{ id: 'r2', enabled: true, mode: 'dispatch', repo: root, session: 's2' }],
      }),
    );
    process.env.FARMSLOT_POOL_DIR = remoteOnlyPoolRoot;
    assert.equal(await resolveTrustedNativeExecutable('antigravity', 'local'), undefined);
    assert.equal(await resolveTrustedNativeExecutablesForNode('local'), undefined);
    assert.equal(await resolveTrustedNativeExecutable('antigravity', 'review-node'), primaryBin);

    // 2) Converse: canonical localhost + auxiliary remote for the same machine MUST classify as local.
    const localCanonPoolRoot = join(root, 'pool-canonical-local');
    mkdirSync(localCanonPoolRoot, { recursive: true });
    writeFileSync(
      join(localCanonPoolRoot, 'local-box.json'),
      JSON.stringify({
        machine: 'local-box',
        project: 'primary',
        host: 'localhost',
        ssh_user: process.env.USER || 'operator',
        os: process.platform,
        platform: 'cli',
        antigravity_path: primaryBin,
        slots: [{ id: 'l1', enabled: true, mode: 'dispatch', repo: root, session: 's1' }],
      }),
    );
    writeFileSync(
      join(localCanonPoolRoot, 'canary-local-box.json'),
      JSON.stringify({
        machine: 'local-box',
        project: 'canary',
        host: 'local-box.example',
        ssh_user: 'operator',
        os: process.platform,
        platform: 'cli',
        antigravity_path: canaryBin,
        slots: [{ id: 'l2', enabled: true, mode: 'dispatch', repo: root, session: 's2' }],
      }),
    );
    process.env.FARMSLOT_POOL_DIR = localCanonPoolRoot;
    assert.equal(await resolveTrustedNativeExecutable('antigravity', 'local'), primaryBin);
    assert.equal(await resolveTrustedNativeExecutable('antigravity', 'local-box'), primaryBin);
  } finally {
    if (prevPoolDir === undefined) delete process.env.FARMSLOT_POOL_DIR;
    else process.env.FARMSLOT_POOL_DIR = prevPoolDir;
    rmSync(root, { recursive: true, force: true });
  }
});

interface TypedNodeTransport {
  ws: WebSocket;
  close(): Promise<void>;
}

interface TypedNodeTransportOptions {
  onClientCreated?: (clientSocket: WebSocket, wss: WebSocketServer) => void;
}

/** Real loopback WebSocket transport so gateway node-RPC tests inspect actual wire frames without casts. */
async function createTypedNodeTransport(
  onRequest: (frame: RequestFrame) => Promise<unknown>,
  options?: TypedNodeTransportOptions,
): Promise<TypedNodeTransport> {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  let clientSocket: WebSocket | undefined;
  let serverSocket: WebSocket | undefined;
  let closed = false;
  const ignoreHandshakeTeardownError = () => {
    // Expected ECONNRESET / closed-before-open socket error emitted when terminating a failed handshake.
  };
  const terminateSocket = async (socket: WebSocket | undefined): Promise<void> => {
    if (!socket) return;
    socket.on('error', ignoreHandshakeTeardownError);
    if (socket.readyState === WebSocket.CLOSED) return;
    const closedP = new Promise<void>((resolve) => {
      socket.once('close', () => resolve());
    });
    if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
      socket.terminate();
    }
    await closedP;
  };
  const closeTransport = async () => {
    if (closed) return;
    closed = true;
    await Promise.all([
      terminateSocket(clientSocket),
      terminateSocket(serverSocket),
      new Promise<void>((resolve) => {
        wss.close(() => resolve());
      }),
    ]);
  };
  try {
    await new Promise<void>((resolve, reject) => {
      wss.once('listening', resolve);
      wss.once('error', reject);
    });
    const address = wss.address();
    assert(address && typeof address !== 'string');
    const serverSocketReady = new Promise<WebSocket>((resolve) => {
      wss.once('connection', (socket) => {
        serverSocket = socket;
        resolve(socket);
      });
    });
    const client = new WebSocket(`ws://127.0.0.1:${address.port}`);
    clientSocket = client;
    await new Promise<void>((resolve, reject) => {
      client.once('open', () => resolve());
      client.once('error', reject);
      options?.onClientCreated?.(client, wss);
    });
    const connectedServerSocket = await serverSocketReady;
    client.on('message', (raw) => {
      const frame = JSON.parse(String(raw)) as RequestFrame;
      void onRequest(frame).then(
        (payload) =>
          handleNodeResponse(frame.id, true, payload, undefined, undefined, connectedServerSocket),
        (err: unknown) => {
          const error = err as Error & { code?: string };
          handleNodeResponse(
            frame.id,
            false,
            undefined,
            error instanceof Error ? error.message : String(err),
            error?.code,
            connectedServerSocket,
          );
        },
      );
    });
    return {
      ws: connectedServerSocket,
      close: closeTransport,
    };
  } catch (error) {
    await closeTransport();
    throw error;
  }
}

test('createTypedNodeTransport cleans up listener and sockets on pre-open client error and throwing setup hook', async () => {
  const ignoreFallbackError = () => {
    // Expected socket error during fallback test teardown if helper cleanup regresses.
  };
  const runFailureCase = async (
    inject: (client: WebSocket, wss: WebSocketServer) => void,
    expectedError: RegExp,
  ) => {
    let capturedClient: WebSocket | undefined;
    let capturedWss: WebSocketServer | undefined;
    const capturedServerSockets: WebSocket[] = [];
    let sawListeningPort = false;
    const unhandledRejections: unknown[] = [];
    const onUnhandledRejection = (reason: unknown) => {
      unhandledRejections.push(reason);
    };
    process.on('unhandledRejection', onUnhandledRejection);
    try {
      await assert.rejects(
        createTypedNodeTransport(async () => ({}), {
          onClientCreated(client, wss) {
            capturedClient = client;
            capturedWss = wss;
            wss.on('connection', (socket) => {
              capturedServerSockets.push(socket);
            });
            const addr = wss.address();
            sawListeningPort = Boolean(addr && typeof addr !== 'string' && addr.port > 0);
            inject(client, wss);
          },
        }),
        expectedError,
      );
      for (let i = 0; i < 4; i++) await new Promise((resolve) => setImmediate(resolve));
      assert.equal(
        sawListeningPort,
        true,
        'listener must have been acquired before error injection',
      );
      assert.ok(capturedWss);
      assert.ok(capturedClient);
      assert.equal(
        capturedWss.address(),
        null,
        'WebSocketServer listener must be closed before acquisition rejects',
      );
      assert.equal(
        capturedClient.readyState,
        WebSocket.CLOSED,
        `client socket must be CLOSED before acquisition rejects (readyState=${capturedClient.readyState})`,
      );
      assert.deepEqual(
        unhandledRejections,
        [],
        'transport acquisition failure must not leave unhandled rejections',
      );
    } finally {
      process.off('unhandledRejection', onUnhandledRejection);
      if (capturedClient && capturedClient.readyState !== WebSocket.CLOSED) {
        capturedClient.on('error', ignoreFallbackError);
        capturedClient.terminate();
      }
      for (const socket of capturedServerSockets) {
        if (socket.readyState !== WebSocket.CLOSED) {
          socket.on('error', ignoreFallbackError);
          socket.terminate();
        }
      }
      if (capturedWss && capturedWss.address() !== null) {
        await new Promise<void>((resolve) => capturedWss!.close(() => resolve()));
      }
    }
  };

  await runFailureCase(
    (client) => client.emit('error', new Error('injected pre-open client error')),
    /injected pre-open client error/,
  );
  await runFailureCase(() => {
    throw new Error('injected onClientCreated hook throw');
  }, /injected onClientCreated hook throw/);
});

test('remote Antigravity status runs shared observeAntigravityAccount across node boundary with cleanup and failure isolation', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agy-remote-node-status-'));
  const pidFile = join(root, 'child.pid');
  const fakeAgy = join(root, 'agy');
  const launcherExit127 = join(root, 'agy-exit-127');
  writeFileSync(
    fakeAgy,
    `#!/usr/bin/env node
const fs = require('node:fs');
if (process.argv.includes('--version')) {
  console.log('1.5.12');
  process.exit(0);
}
fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
const signedOut = process.env.AGY_TEST_SIGNED_OUT === '1';
const send = (msg) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\\n');
require('node:readline').createInterface({ input: process.stdin }).on('line', (line) => {
  const m = JSON.parse(line);
  if (m.method === 'initialize') {
    return send({ id: m.id, result: { protocolVersion: 1, agentInfo: { name: 'Antigravity ACP Server', version: '1.5.12' } } });
  }
  if (m.method === 'session/list') {
    if (signedOut) {
      return send({ id: m.id, error: { code: -32000, message: 'Authentication required' } });
    }
    return send({ id: m.id, result: { sessions: [] } });
  }
});
`,
  );
  chmodSync(fakeAgy, 0o700);
  writeFileSync(
    launcherExit127,
    `#!/usr/bin/env node
if (process.argv.includes('--version')) {
  console.log('1.5.12');
  process.exit(0);
}
process.stderr.write('launcher dependency temporarily missing\\n');
process.exit(127);
`,
  );
  chmodSync(launcherExit127, 0o700);

  const machine = 'remote-agy-host';
  let transportMode: 'observe' | 'rpc-error' = 'observe';
  const transport = await createTypedNodeTransport(async (frame) => {
    assert.equal(frame.method, 'native.account.observe');
    const p = (frame.params ?? {}) as Record<string, unknown>;
    assert.equal(p.runner, 'antigravity');
    // Host-level account probes must use stable host cwd '/' rather than an unprepared slot checkout.
    assert.equal(p.cwd, '/');
    if (transportMode === 'rpc-error') throw new Error('node connection reset');
    const extraEnv =
      p.env && typeof p.env === 'object' && !Array.isArray(p.env)
        ? (p.env as Record<string, string>)
        : {};
    return observeAntigravityAccount({
      cwd: '/',
      executable: typeof p.executable === 'string' ? p.executable : undefined,
      env: { ...process.env, ...extraEnv },
    });
  });
  registerNode(machine, 1, transport.ws);
  try {
    const baseVars = makeVars({
      machine,
      host: 'remote-agy.example',
      sshUser: 'operator',
      sshTarget: 'operator@remote-agy.example',
      remoteRepo: join(root, 'unprepared-slot-checkout-does-not-exist'),
      antigravityPath: fakeAgy,
    });

    const authenticated = await getHostRunnerSubscriptions(baseVars, {
      runners: ['antigravity', 'unknown-peer'],
    });
    const agyAuth = authenticated.find((s) => s.runner === 'antigravity');
    assert.equal(agyAuth?.source, 'antigravity-auth');
    assert.equal(agyAuth?.loginMethod, 'agy 1.5.12');
    assert.deepEqual(agyAuth?.outcome, { identity: 'observed', quota: 'absent' });
    assert.equal(authenticated.find((s) => s.runner === 'unknown-peer')?.source, 'unsupported');
    // Confirm the spawned ACP child exited before the remote status call returned.
    const childPid = Number(readFileSync(pidFile, 'utf8').trim());
    assert.throws(() => process.kill(childPid, 0), { code: 'ESRCH' });

    const signedOut = await getHostRunnerSubscriptions(
      { ...baseVars, machineEnv: { AGY_TEST_SIGNED_OUT: '1' } },
      { runners: ['antigravity'] },
    );
    assert.equal(signedOut[0]?.source, 'error');
    assert.equal(signedOut[0]?.error, 'not-logged-in');
    assert.deepEqual(signedOut[0]?.outcome, { identity: 'absent', quota: 'absent' });

    // Existing launcher exiting 127 must remain identity: 'failed' (never absent / not-installed / not-logged-in).
    const exit127 = await getHostRunnerSubscriptions(
      { ...baseVars, antigravityPath: launcherExit127 },
      { runners: ['antigravity'] },
    );
    assert.equal(exit127[0]?.source, 'error');
    assert.notEqual(exit127[0]?.error, 'not-logged-in');
    assert.notEqual(exit127[0]?.error, 'agy not found');
    assert.deepEqual(exit127[0]?.outcome, { identity: 'failed', quota: 'absent' });

    const missing = await getHostRunnerSubscriptions(
      { ...baseVars, antigravityPath: join(root, 'missing-agy') },
      { runners: ['antigravity'] },
    );
    assert.equal(missing[0]?.source, 'error');
    assert.equal(missing[0]?.error, 'agy not found');
    assert.deepEqual(missing[0]?.outcome, { identity: 'absent', quota: 'absent' });

    transportMode = 'rpc-error';
    const transportFailed = await getHostRunnerSubscriptions(baseVars, {
      runners: ['antigravity', 'unknown-peer'],
    });
    const agyFailed = transportFailed.find((s) => s.runner === 'antigravity');
    assert.equal(agyFailed?.source, 'error');
    assert.match(agyFailed?.error ?? '', /node connection reset/);
    assert.deepEqual(agyFailed?.outcome, { identity: 'failed', quota: 'absent' });
    assert.equal(transportFailed.find((s) => s.runner === 'unknown-peer')?.source, 'unsupported');
  } finally {
    unregisterByWs(transport.ws);
    await transport.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('gateway observation owner syncs remote executables before fence so first and concurrent profile reads succeed with one current sample', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'agy-gw-fence-'));
  const farmHome = join(root, 'farm-home');
  const tempPoolRoot = join(root, 'pool');
  const nodeStateRoot = join(root, 'node-state');
  const profileDir = join(root, 'work-profile');
  const probeLog = join(root, 'probes.log');
  const fakeAgyV1 = join(root, 'bin-v1', 'agy');
  const fakeAgyV2 = join(root, 'bin-v2', 'agy');
  mkdirSync(farmHome, { recursive: true });
  mkdirSync(tempPoolRoot, { recursive: true });
  mkdirSync(nodeStateRoot, { recursive: true, mode: 0o700 });
  chmodSync(nodeStateRoot, 0o700);
  mkdirSync(profileDir, { recursive: true });
  mkdirSync(dirname(fakeAgyV1), { recursive: true });
  mkdirSync(dirname(fakeAgyV2), { recursive: true });

  const writeFakeAgy = (target: string, version: string) => {
    writeFileSync(
      target,
      `#!/usr/bin/env node
const fs = require('node:fs');
if (process.argv.includes('--version')) {
  fs.appendFileSync(${JSON.stringify(probeLog)}, ${JSON.stringify(`${version}\n`)});
  console.log(${JSON.stringify(version)});
  process.exit(0);
}
const send = (msg) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\\n');
require('node:readline').createInterface({ input: process.stdin }).on('line', (line) => {
  const m = JSON.parse(line);
  if (m.method === 'initialize') {
    return send({ id: m.id, result: { protocolVersion: 1, agentInfo: { name: 'Antigravity ACP Server', version: ${JSON.stringify(version)} } } });
  }
  if (m.method === 'session/list') {
    return send({ id: m.id, result: { sessions: [] } });
  }
});
`,
    );
    chmodSync(target, 0o700);
  };
  writeFakeAgy(fakeAgyV1, '1.5.12');
  writeFakeAgy(fakeAgyV2, '1.5.13');

  const prevPoolDir = process.env.FARMSLOT_POOL_DIR;
  const prevFarmHome = process.env.FARMSLOT_HOME;
  const prevPath = process.env.PATH;
  const prevAgyEnv = process.env.FARMSLOT_AGY_EXECUTABLE;
  const machine = 'remote-fenced-agy';
  const machine2 = 'remote-fenced-clean';
  const writePool = (agyPath?: string) => {
    writeFileSync(
      join(tempPoolRoot, `${machine}.json`),
      JSON.stringify({
        machine,
        project: 'demo',
        host: 'remote-fenced-agy.example',
        ssh_user: 'operator',
        os: process.platform,
        platform: 'cli',
        ...(agyPath ? { antigravity_path: agyPath } : {}),
        slots: [{ id: `${machine}-1`, enabled: true, mode: 'dispatch', repo: root, session: 's1' }],
      }),
    );
  };
  writePool(fakeAgyV1);
  writeFileSync(
    join(tempPoolRoot, `${machine2}.json`),
    JSON.stringify({
      machine: machine2,
      project: 'demo',
      host: 'remote-fenced-clean.example',
      ssh_user: 'operator',
      os: process.platform,
      platform: 'cli',
      slots: [{ id: `${machine2}-1`, enabled: true, mode: 'dispatch', repo: root, session: 's2' }],
    }),
  );

  process.env.FARMSLOT_POOL_DIR = tempPoolRoot;
  process.env.FARMSLOT_HOME = farmHome;
  delete process.env.FARMSLOT_AGY_EXECUTABLE;
  process.env.PATH = `${dirname(process.execPath)}:/usr/bin:/bin`;

  const auth = createGatewayAuthRuntime({ FARMSLOT_HOME: farmHome });
  const roles = [{ role: 'admin' as const, scope: { kind: 'global' as const } }];
  const ownerRecord = auth.writer.createPrincipal(
    { type: 'person', displayName: 'Fenced Owner' },
    roles,
    'fenced-owner',
  );
  auth.writer.createPrincipal(
    {
      type: 'node',
      machine,
      displayName: 'Remote Fenced Node',
      nativeOwnerPrincipalId: ownerRecord.id,
    },
    [],
    'node-fenced',
  );
  auth.writer.createPrincipal(
    {
      type: 'node',
      machine: machine2,
      displayName: 'Remote Clean Node',
      nativeOwnerPrincipalId: ownerRecord.id,
    },
    [],
    'node-fenced-clean',
  );
  const principal: Principal = {
    id: ownerRecord.id,
    subject: { type: 'person', displayName: 'Fenced Owner' },
    roles,
  };

  const nodeClient = new NativeSessionClient(nodeStateRoot, machine);
  const node2StateRoot = join(root, 'node2-state');
  mkdirSync(node2StateRoot, { recursive: true, mode: 0o700 });
  const node2Client = new NativeSessionClient(node2StateRoot, machine2);
  await routeNativeProfile(nodeClient, ownerRecord.id, Methods.NATIVE_PROFILE_ADD, {
    profileId: 'work',
    runner: 'antigravity',
    directory: profileDir,
  });
  await routeNativeProfile(node2Client, ownerRecord.id, Methods.NATIVE_PROFILE_ADD, {
    profileId: 'work',
    runner: 'antigravity',
    directory: profileDir,
  });

  let poolSnapshotReads = 0;
  const invalidatedKeys: Array<{ family: string; nodeId?: string; scope?: string }> = [];
  const observations = new GatewayNativeObservations(
    (key) => {
      invalidatedKeys.push({
        family: key.family,
        ...('nodeId' in key ? { nodeId: key.nodeId } : { scope: key.scope }),
      });
    },
    undefined,
    () => {
      poolSnapshotReads++;
      return loadTrustedNativeExecutableSnapshot();
    },
  );
  let nodeExecutables: Record<string, string> = {};
  let nodeExecutablesDigest = EMPTY_TRUSTED_EXECUTABLES_DIGEST;
  let configureCalls = 0;
  const configuredPayloads: Array<Record<string, string>> = [];
  let pendingConfigureGate: { entered: Promise<void>; release: () => void } | undefined;
  let lastReceipt: NativeSourceReceipt | undefined;
  let registeredWs: WebSocket | undefined;
  let nodeObs!: NativeHostObservation;
  const startNodeObservation = () => {
    nodeObs?.stop();
    nodeObs = new NativeHostObservation(
      nodeClient,
      ownerRecord.id,
      (receipt) => {
        lastReceipt = receipt;
        if (registeredWs) observations.acceptRemote(registeredWs, receipt, () => true);
      },
      undefined,
      undefined,
      (runner) => nodeExecutables[runner],
      nodeExecutablesDigest,
    );
    return nodeObs.start();
  };

  let node2Executables: Record<string, string> = {};
  let node2ExecutablesDigest = EMPTY_TRUSTED_EXECUTABLES_DIGEST;
  let configureCalls2 = 0;
  const configuredPayloads2: Array<Record<string, string>> = [];
  let node2SampleCalls = 0;
  let registeredWs2: WebSocket | undefined;
  const node2Obs = new NativeHostObservation(
    node2Client,
    ownerRecord.id,
    (receipt) => {
      if (registeredWs2) observations.acceptRemote(registeredWs2, receipt, () => true);
    },
    undefined,
    async () => {
      node2SampleCalls++;
      return [
        (await routeNativeProfile(
          node2Client,
          ownerRecord.id,
          Methods.NATIVE_PROFILE_STATUS,
          { profileId: 'work' },
          { resolveExecutable: (runner) => node2Executables[runner] },
        )) as NativeProfileStatusResult,
      ];
    },
    (runner) => node2Executables[runner],
    node2ExecutablesDigest,
  );

  const makeNodeHandler = () => async (frame: RequestFrame) => {
    const p = (frame.params ?? {}) as Record<string, unknown>;
    if (frame.method === 'native.observation.configure') {
      configureCalls++;
      const incoming =
        p.executables && typeof p.executables === 'object' && !Array.isArray(p.executables)
          ? (p.executables as Record<string, string>)
          : {};
      configuredPayloads.push({ ...incoming });
      if (pendingConfigureGate) {
        const gate = pendingConfigureGate;
        pendingConfigureGate = undefined;
        await gate.entered;
      }
      nodeExecutables = { ...incoming };
      nodeExecutablesDigest = canonicalTrustedExecutablesDigest(nodeExecutables);
      return nodeObs.setExecutableConfig(nodeExecutablesDigest);
    }
    if (frame.method === 'native.session') {
      assert.equal(p.observe, true);
      assert.equal(p.method, Methods.NATIVE_PROFILE_STATUS);
      const profileId = (p.params as { profileId: string }).profileId;
      return nodeObs.read(() => nodeObs.profileStatus(profileId));
    }
    throw new Error(`Unexpected node method: ${frame.method}`);
  };

  const transport2 = await createTypedNodeTransport(async (frame: RequestFrame) => {
    const p = (frame.params ?? {}) as Record<string, unknown>;
    if (frame.method === 'native.observation.configure') {
      configureCalls2++;
      const incoming =
        p.executables && typeof p.executables === 'object' && !Array.isArray(p.executables)
          ? (p.executables as Record<string, string>)
          : {};
      configuredPayloads2.push({ ...incoming });
      node2Executables = { ...incoming };
      node2ExecutablesDigest = canonicalTrustedExecutablesDigest(node2Executables);
      return node2Obs.setExecutableConfig(node2ExecutablesDigest);
    }
    if (frame.method === 'native.session') {
      const profileId = (p.params as { profileId: string }).profileId;
      return node2Obs.read(() => node2Obs.profileStatus(profileId));
    }
    throw new Error(`Unexpected node2 method: ${frame.method}`);
  });
  let transport2Closed = false;
  t.after(async () => {
    if (!transport2Closed) {
      transport2Closed = true;
      unregisterByWs(transport2.ws);
      await transport2.close();
    }
  });
  registeredWs2 = transport2.ws;

  let activeTransport = await createTypedNodeTransport(makeNodeHandler());
  registeredWs = activeTransport.ws;

  const clientConn = {};
  registerNode(
    machine,
    1,
    activeTransport.ws,
    undefined,
    undefined,
    {
      ownerPrincipalId: ownerRecord.id,
      supportsStandaloneDelegation: true,
      supportsProfiles: true,
      supportsObservations: true,
      supportsObservationConfiguration: true,
    },
    { principalId: 'node-fenced', valid: () => true },
  );
  registerNode(
    machine2,
    1,
    transport2.ws,
    undefined,
    undefined,
    {
      ownerPrincipalId: ownerRecord.id,
      supportsStandaloneDelegation: true,
      supportsProfiles: true,
      supportsObservations: true,
      supportsObservationConfiguration: true,
    },
    { principalId: 'node-fenced-clean', valid: () => true },
  );
  observations.attachClient(clientConn, () => principal);

  const waitUntil = async (predicate: () => Promise<boolean> | boolean, label: string) => {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      if (await predicate()) return;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error(`Timed out waiting for ${label}`);
  };

  try {
    // Register a catalog interest so we can prove model discovery notices still refresh catalog view.
    const catalogInterests = nativeReadInterests(
      Methods.NATIVE_SESSION_CATALOG,
      {},
      ownerRecord.id,
    );
    assert.ok(catalogInterests);
    await observations.read(
      clientConn,
      catalogInterests,
      async () => ({ contexts: [], runners: [] }),
      () => null,
    );

    await startNodeObservation();
    await node2Obs.start();
    assert.ok(lastReceipt?.ready);

    const readThroughGateway = async (
      targetMachine = machine,
    ): Promise<NativeProfileStatusResult> => {
      const params = { executionNodeId: targetMachine, profileId: 'work' };
      const interests = nativeReadInterests(Methods.NATIVE_PROFILE_STATUS, params, ownerRecord.id);
      assert.ok(interests);
      const { payload } = await observations.read(
        clientConn,
        interests,
        async () => {
          const registeredNode = getNode(targetMachine);
          assert.ok(registeredNode);
          const envelope = await sendNodeRequest(
            registeredNode,
            'native.session',
            {
              owner: ownerRecord.id,
              method: Methods.NATIVE_PROFILE_STATUS,
              params,
              observe: true,
            },
            { requireSameConnection: true },
          );
          return observations.unwrapRemote<NativeProfileStatusResult>(
            registeredNode.ws,
            targetMachine,
            envelope,
          );
        },
        () => null,
      );
      return payload;
    };

    const waitForReadyRead = async (
      targetMachine = machine,
    ): Promise<NativeProfileStatusResult> => {
      let result: NativeProfileStatusResult | undefined;
      await waitUntil(async () => {
        try {
          result = await readThroughGateway(targetMachine);
          return true;
        } catch (error) {
          if ((error as { code?: string }).code === 'NATIVE_PROFILES_UNAVAILABLE') return false;
          throw error;
        }
      }, `ready profile status for ${targetMachine}`);
      assert.ok(result);
      return result;
    };

    // Cold clean node (no overrides) receives explicit {} acknowledgement and skips redundant sampling.
    const cleanFirst = await waitForReadyRead(machine2);
    assert.equal(cleanFirst.account.installed, false);
    assert.equal(configureCalls2, 1);
    assert.deepEqual(configuredPayloads2, [{}]);
    assert.equal(
      node2SampleCalls,
      1,
      'empty-map acknowledgement on a cold node must not repeat the initial account sample',
    );

    // First marked read on configured node succeeds after registration sync with v1.
    const first = await waitForReadyRead(machine);
    assert.equal(first.account.installed, true);
    assert.equal(first.account.login, 'authenticated');
    assert.equal(first.account.version, '1.5.12');
    assert.ok(first.loginCommand.includes(fakeAgyV1));
    assert.equal(configureCalls, 1);
    const probesAfterFirst = readFileSync(probeLog, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean).length;
    assert.equal(probesAfterFirst, 1);

    // Second read with unchanged pool config does zero extra configures, zero probes, zero pool scans.
    const poolReadsSteady = poolSnapshotReads;
    const second = await readThroughGateway(machine);
    assert.equal(second.account.version, '1.5.12');
    assert.equal(configureCalls, 1);
    assert.equal(poolSnapshotReads, poolReadsSteady);
    assert.equal(
      readFileSync(probeLog, 'utf8').trim().split('\n').filter(Boolean).length,
      probesAfterFirst,
    );

    // Model discovery notice refreshes the catalog view and performs ZERO executable/pool scans or configures.
    const invalidationsBeforeDiscovery = invalidatedKeys.length;
    observations.catalogChanged({ scope: 'all', reason: 'catalog' });
    assert.ok(
      invalidatedKeys
        .slice(invalidationsBeforeDiscovery)
        .some((k) => k.family === 'native-session' && k.scope === 'owner'),
      'model discovery notice must still invalidate the catalog view',
    );
    assert.equal(poolSnapshotReads, poolReadsSteady, 'discovery must perform zero pool scans');
    assert.equal(configureCalls, 1, 'discovery must send zero configure RPCs to configured node');
    assert.equal(configureCalls2, 1, 'discovery must send zero configure RPCs to clean node');

    // Actual pool edit reads ONE shared pool snapshot for all connected nodes, skips unchanged machine2,
    // keeps picker reads non-blocking (NATIVE_PROFILES_UNAVAILABLE) while refreshing, then serves v2.
    let releaseGate!: () => void;
    const gatePromise = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    pendingConfigureGate = { entered: gatePromise, release: releaseGate };
    writePool(fakeAgyV2);
    observations.catalogChanged({ scope: 'all', reason: 'pool' });
    assert.equal(
      poolSnapshotReads,
      poolReadsSteady + 1,
      'pool edit must read one shared pool snapshot across all connected nodes',
    );
    assert.equal(
      configureCalls2,
      1,
      'unchanged connected node must receive zero extra configure RPCs on another node pool edit',
    );
    await waitUntil(() => configureCalls === 2, 'background configure RPC for changed node');
    await assert.rejects(
      readThroughGateway(machine),
      { code: 'NATIVE_PROFILES_UNAVAILABLE' },
      'picker read must report pending sample immediately instead of blocking on configure RPC',
    );
    const invalidationsBeforeRelease = invalidatedKeys.length;
    releaseGate();
    await waitUntil(
      () =>
        invalidatedKeys
          .slice(invalidationsBeforeRelease)
          .some((k) => k.family === 'profiles' && k.nodeId === machine),
      'profiles invalidation after background configure completes',
    );
    const [concurrentA, concurrentB] = await Promise.all([
      readThroughGateway(machine),
      readThroughGateway(machine),
    ]);
    assert.equal(concurrentA.account.version, '1.5.13');
    assert.equal(concurrentB.account.version, '1.5.13');
    assert.ok(concurrentA.loginCommand.includes(fakeAgyV2));
    assert.ok(concurrentB.loginCommand.includes(fakeAgyV2));
    assert.equal(configureCalls, 2);
    assert.equal(
      readFileSync(probeLog, 'utf8').trim().split('\n').filter(Boolean).length,
      probesAfterFirst + 1,
    );

    // Disconnect the node, remove the antigravity_path override from pool while disconnected,
    // then reconnect the same node (which still holds fakeAgyV2 in memory): gateway must
    // explicitly configure {} on reconnect so the removed binary is not returned.
    nodeObs.stop();
    unregisterByWs(activeTransport.ws);
    observations.disconnectRemote(activeTransport.ws);
    await activeTransport.close();
    registeredWs = undefined;

    writePool(undefined);
    observations.catalogChanged({ scope: 'all', reason: 'pool' });

    activeTransport = await createTypedNodeTransport(makeNodeHandler());
    registeredWs = activeTransport.ws;
    registerNode(
      machine,
      1,
      activeTransport.ws,
      undefined,
      undefined,
      {
        ownerPrincipalId: ownerRecord.id,
        supportsStandaloneDelegation: true,
        supportsProfiles: true,
        supportsObservations: true,
        supportsObservationConfiguration: true,
      },
      { principalId: 'node-fenced', valid: () => true },
    );
    await startNodeObservation();

    const afterReconnect = await waitForReadyRead(machine);
    assert.equal(afterReconnect.account.installed, false);
    assert.equal(configureCalls, 3);
    assert.deepEqual(configuredPayloads.at(-1), {});

    // Older node without supportsObservationConfiguration fails closed when a custom path is configured.
    nodeObs.stop();
    unregisterByWs(activeTransport.ws);
    observations.disconnectRemote(activeTransport.ws);
    await activeTransport.close();
    registeredWs = undefined;
    writePool(fakeAgyV1);
    observations.catalogChanged({ scope: 'all', reason: 'pool' });
    activeTransport = await createTypedNodeTransport(makeNodeHandler());
    registeredWs = activeTransport.ws;
    registerNode(
      machine,
      1,
      activeTransport.ws,
      undefined,
      undefined,
      {
        ownerPrincipalId: ownerRecord.id,
        supportsStandaloneDelegation: true,
        supportsProfiles: true,
        supportsObservations: true,
      },
      { principalId: 'node-fenced', valid: () => true },
    );
    await startNodeObservation();
    await assert.rejects(
      readThroughGateway(machine),
      /Execution node upgrade required for configured runner executables/,
    );
  } finally {
    nodeObs?.stop();
    node2Obs.stop();
    observations.detachClient(clientConn);
    observations.dispose();
    unregisterByWs(activeTransport.ws);
    await activeTransport.close();
    if (!transport2Closed) {
      transport2Closed = true;
      unregisterByWs(transport2.ws);
      await transport2.close();
    }
    if (prevPoolDir === undefined) delete process.env.FARMSLOT_POOL_DIR;
    else process.env.FARMSLOT_POOL_DIR = prevPoolDir;
    if (prevFarmHome === undefined) delete process.env.FARMSLOT_HOME;
    else process.env.FARMSLOT_HOME = prevFarmHome;
    if (prevPath === undefined) delete process.env.PATH;
    else process.env.PATH = prevPath;
    if (prevAgyEnv === undefined) delete process.env.FARMSLOT_AGY_EXECUTABLE;
    else process.env.FARMSLOT_AGY_EXECUTABLE = prevAgyEnv;
    rmSync(root, { recursive: true, force: true });
  }
});

test('local observation retains executable map and reads one shared pool snapshot per pool edit across multiple active profiles', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agy-local-multi-profile-'));
  const farmHome = join(root, 'farm-home');
  const tempPoolRoot = join(root, 'pool');
  const localStateRoot = join(root, 'local-state');
  const fakeAgyV1 = join(root, 'bin-v1', 'agy');
  const fakeAgyV2 = join(root, 'bin-v2', 'agy');
  mkdirSync(farmHome, { recursive: true });
  mkdirSync(tempPoolRoot, { recursive: true });
  mkdirSync(localStateRoot, { recursive: true, mode: 0o700 });
  chmodSync(localStateRoot, 0o700);
  mkdirSync(dirname(fakeAgyV1), { recursive: true });
  mkdirSync(dirname(fakeAgyV2), { recursive: true });

  const writeFakeAgy = (target: string, version: string) => {
    writeFileSync(
      target,
      `#!/usr/bin/env node
if (process.argv.includes('--version')) {
  console.log(${JSON.stringify(version)});
  process.exit(0);
}
const send = (msg) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\\n');
require('node:readline').createInterface({ input: process.stdin }).on('line', (line) => {
  const m = JSON.parse(line);
  if (m.method === 'initialize') {
    return send({ id: m.id, result: { protocolVersion: 1, agentInfo: { name: 'Antigravity ACP Server', version: ${JSON.stringify(version)} } } });
  }
  if (m.method === 'session/list') {
    return send({ id: m.id, result: { sessions: [] } });
  }
});
`,
    );
    chmodSync(target, 0o700);
  };
  writeFakeAgy(fakeAgyV1, '1.5.12');
  writeFakeAgy(fakeAgyV2, '1.5.13');

  const writeLocalPool = (agyPath: string) => {
    writeFileSync(
      join(tempPoolRoot, 'maclocal.json'),
      JSON.stringify({
        machine: 'maclocal',
        project: 'demo',
        host: 'localhost',
        ssh_user: process.env.USER || 'operator',
        os: process.platform,
        platform: 'cli',
        antigravity_path: agyPath,
        slots: [{ id: 'maclocal-1', enabled: true, mode: 'dispatch', repo: root, session: 's1' }],
      }),
    );
  };
  writeLocalPool(fakeAgyV1);

  const prevPoolDir = process.env.FARMSLOT_POOL_DIR;
  const prevFarmHome = process.env.FARMSLOT_HOME;
  const prevOwner = process.env.FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID;
  const prevPath = process.env.PATH;
  const prevAgyEnv = process.env.FARMSLOT_AGY_EXECUTABLE;
  let observations: GatewayNativeObservations | undefined;
  try {
    process.env.FARMSLOT_POOL_DIR = tempPoolRoot;
    process.env.FARMSLOT_HOME = farmHome;
    delete process.env.FARMSLOT_AGY_EXECUTABLE;
    process.env.PATH = `${dirname(process.execPath)}:/usr/bin:/bin`;

    const auth = createGatewayAuthRuntime({ FARMSLOT_HOME: farmHome });
    const ownerRecord = auth.writer.createPrincipal(
      { type: 'person', displayName: 'Local Owner' },
      [{ role: 'admin' as const, scope: { kind: 'global' as const } }],
      'local-owner',
    );
    process.env.FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID = ownerRecord.id;

    const localClient = new NativeSessionClient(localStateRoot, 'local');
    const profileIds = ['local-a', 'local-b', 'local-c'];
    for (const profileId of profileIds) {
      const dir = join(root, `profile-${profileId}`);
      mkdirSync(dir, { recursive: true });
      await routeNativeProfile(localClient, ownerRecord.id, Methods.NATIVE_PROFILE_ADD, {
        profileId,
        runner: 'antigravity',
        directory: dir,
      });
    }

    let poolSnapshotReads = 0;
    const localInvalidations: Array<{ family: string; nodeId?: string }> = [];
    observations = new GatewayNativeObservations(
      (key) => {
        localInvalidations.push({
          family: key.family,
          ...('nodeId' in key ? { nodeId: key.nodeId } : {}),
        });
      },
      localClient,
      () => {
        poolSnapshotReads++;
        return loadTrustedNativeExecutableSnapshot();
      },
    );

    const clientConn = {};
    const principal: Principal = {
      id: ownerRecord.id,
      subject: { type: 'person', displayName: 'Local Owner' },
      roles: [{ role: 'admin' as const, scope: { kind: 'global' as const } }],
    };
    observations.attachClient(clientConn, () => principal);

    // macOS FSEvents can deliver the preceding provider-accounts.json write asynchronously while
    // arming; retryable `arming-source-changed` is expected in production and retried once.
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await observations.startLocal(ownerRecord.id);
        break;
      } catch (error) {
        const reason = (error as { reason?: string } | undefined)?.reason;
        if (reason !== 'arming-source-changed' || attempt === 2) throw error;
      }
    }
    // Initial startLocal reads the pool snapshot ONCE even though 3 active local profiles were sampled.
    assert.equal(poolSnapshotReads, 1);

    const readLocalProfile = async (profileId: string): Promise<NativeProfileStatusResult> => {
      const params = { executionNodeId: 'local', profileId };
      const interests = nativeReadInterests(Methods.NATIVE_PROFILE_STATUS, params, ownerRecord.id);
      assert.ok(interests);
      const { payload } = await observations!.read(
        clientConn,
        interests,
        async () =>
          (await observations!.localProfileStatus(
            ownerRecord.id,
            profileId,
          )) as NativeProfileStatusResult,
        () => null,
      );
      return payload;
    };

    for (const profileId of profileIds) {
      const status = await readLocalProfile(profileId);
      assert.equal(status.account.version, '1.5.12');
      assert.ok(status.loginCommand.includes(fakeAgyV1));
    }
    assert.equal(poolSnapshotReads, 1);

    // Real pool edit refreshes all 3 active local profiles with EXACTLY ONE shared pool snapshot read.
    const invalidationsBefore = localInvalidations.length;
    writeLocalPool(fakeAgyV2);
    observations.catalogChanged({ scope: 'all', reason: 'pool' });
    assert.equal(
      poolSnapshotReads,
      2,
      'pool edit must take exactly one shared pool snapshot even across 3 active local profiles',
    );
    const deadline = Date.now() + 5_000;
    while (
      Date.now() < deadline &&
      !localInvalidations
        .slice(invalidationsBefore)
        .some((k) => k.family === 'profiles' && k.nodeId === 'local')
    ) {
      await new Promise((r) => setTimeout(r, 20));
    }
    for (const profileId of profileIds) {
      const updated = await readLocalProfile(profileId);
      assert.equal(updated.account.version, '1.5.13');
      assert.ok(updated.loginCommand.includes(fakeAgyV2));
    }
    assert.equal(
      poolSnapshotReads,
      2,
      'sampling 3 active local profiles must reuse retained local map with zero extra pool scans',
    );
  } finally {
    observations?.dispose();
    if (prevPoolDir === undefined) delete process.env.FARMSLOT_POOL_DIR;
    else process.env.FARMSLOT_POOL_DIR = prevPoolDir;
    if (prevFarmHome === undefined) delete process.env.FARMSLOT_HOME;
    else process.env.FARMSLOT_HOME = prevFarmHome;
    if (prevOwner === undefined) delete process.env.FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID;
    else process.env.FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID = prevOwner;
    if (prevPath === undefined) delete process.env.PATH;
    else process.env.PATH = prevPath;
    if (prevAgyEnv === undefined) delete process.env.FARMSLOT_AGY_EXECUTABLE;
    else process.env.FARMSLOT_AGY_EXECUTABLE = prevAgyEnv;
    rmSync(root, { recursive: true, force: true });
  }
});

test('ambiguous local pool fails closed at startup without PATH fallback, caches error until pool edit, and coalesces paired watcher events', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agy-local-ambig-coalesce-'));
  const farmHome = join(root, 'farm-home');
  const tempPoolRoot = join(root, 'pool');
  const localStateRoot = join(root, 'local-state');
  const profileDir = join(root, 'profile-work');
  const pathBinDir = join(root, 'path-bin');
  const pathProbeLog = join(root, 'path-fallback-called.log');
  const canonicalAgy = join(root, 'canonical-bin', 'agy');
  const canonicalAgyV2 = join(root, 'canonical-bin-v2', 'agy');
  mkdirSync(farmHome, { recursive: true });
  mkdirSync(tempPoolRoot, { recursive: true });
  mkdirSync(localStateRoot, { recursive: true, mode: 0o700 });
  chmodSync(localStateRoot, 0o700);
  mkdirSync(profileDir, { recursive: true });
  mkdirSync(pathBinDir, { recursive: true });
  mkdirSync(dirname(canonicalAgy), { recursive: true });
  mkdirSync(dirname(canonicalAgyV2), { recursive: true });

  const writeFakeAgy = (target: string, version: string, logFile?: string) => {
    writeFileSync(
      target,
      `#!/usr/bin/env node
const fs = require('node:fs');
${logFile ? `fs.appendFileSync(${JSON.stringify(logFile)}, 'called\\n');` : ''}
if (process.argv.includes('--version')) {
  console.log(${JSON.stringify(version)});
  process.exit(0);
}
const send = (msg) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\\n');
require('node:readline').createInterface({ input: process.stdin }).on('line', (line) => {
  const m = JSON.parse(line);
  if (m.method === 'initialize') {
    return send({ id: m.id, result: { protocolVersion: 1, agentInfo: { name: 'Antigravity ACP Server', version: ${JSON.stringify(version)} } } });
  }
  if (m.method === 'session/list') {
    return send({ id: m.id, result: { sessions: [] } });
  }
});
`,
    );
    chmodSync(target, 0o700);
  };
  // Put an executable named `agy` on PATH to prove ambiguous startup NEVER falls back to PATH.
  writeFakeAgy(join(pathBinDir, 'agy'), '0.0.0-path-fallback', pathProbeLog);
  writeFakeAgy(canonicalAgy, '1.5.14');
  writeFakeAgy(canonicalAgyV2, '1.5.15');

  // Two auxiliary local pools for the same machine and NO canonical `local-ambig.json`.
  for (const name of ['aux-local-a.json', 'aux-local-b.json']) {
    writeFileSync(
      join(tempPoolRoot, name),
      JSON.stringify({
        machine: 'local-ambig',
        project: name,
        host: 'localhost',
        ssh_user: process.env.USER || 'operator',
        os: process.platform,
        platform: 'cli',
        antigravity_path: canonicalAgy,
        slots: [{ id: `slot-${name}`, enabled: true, mode: 'dispatch', repo: root, session: 's1' }],
      }),
    );
  }

  const prevPoolDir = process.env.FARMSLOT_POOL_DIR;
  const prevFarmHome = process.env.FARMSLOT_HOME;
  const prevOwner = process.env.FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID;
  const prevPath = process.env.PATH;
  const prevAgyEnv = process.env.FARMSLOT_AGY_EXECUTABLE;
  let observations: GatewayNativeObservations | undefined;
  let poolHandlers: ReturnType<typeof createPoolWatcherHandlers> | undefined;
  try {
    process.env.FARMSLOT_POOL_DIR = tempPoolRoot;
    process.env.FARMSLOT_HOME = farmHome;
    delete process.env.FARMSLOT_AGY_EXECUTABLE;
    process.env.PATH = `${pathBinDir}:${dirname(process.execPath)}:/usr/bin:/bin`;

    const auth = createGatewayAuthRuntime({ FARMSLOT_HOME: farmHome });
    const ownerRecord = auth.writer.createPrincipal(
      { type: 'person', displayName: 'Ambig Owner' },
      [{ role: 'admin' as const, scope: { kind: 'global' as const } }],
      'ambig-owner',
    );
    process.env.FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID = ownerRecord.id;

    const localClient = new NativeSessionClient(localStateRoot, 'local');
    await routeNativeProfile(localClient, ownerRecord.id, Methods.NATIVE_PROFILE_ADD, {
      profileId: 'work',
      runner: 'antigravity',
      directory: profileDir,
    });

    let poolSnapshotReads = 0;
    const localInvalidations: Array<{ family: string; nodeId?: string }> = [];
    observations = new GatewayNativeObservations(
      (key) => {
        localInvalidations.push({
          family: key.family,
          ...('nodeId' in key ? { nodeId: key.nodeId } : {}),
        });
      },
      localClient,
      () => {
        poolSnapshotReads++;
        return loadTrustedNativeExecutableSnapshot();
      },
    );

    const clientConn = {};
    const principal: Principal = {
      id: ownerRecord.id,
      subject: { type: 'person', displayName: 'Ambig Owner' },
      roles: [{ role: 'admin' as const, scope: { kind: 'global' as const } }],
    };
    observations.attachClient(clientConn, () => principal);

    // 1) Startup succeeds (gateway stays healthy), does NOT execute PATH fallback, and reads once.
    await observations.startLocal(ownerRecord.id);
    assert.equal(poolSnapshotReads, 1);
    assert.equal(
      existsSync(pathProbeLog),
      false,
      'ambiguous local pool must not fall back to PATH executable at startup',
    );

    const readLocalProfile = async (): Promise<NativeProfileStatusResult> => {
      const params = { executionNodeId: 'local', profileId: 'work' };
      const interests = nativeReadInterests(Methods.NATIVE_PROFILE_STATUS, params, ownerRecord.id);
      assert.ok(interests);
      const { payload } = await observations!.read(
        clientConn,
        interests,
        async () =>
          (await observations!.localProfileStatus(
            ownerRecord.id,
            'work',
          )) as NativeProfileStatusResult,
        () => null,
      );
      return payload;
    };

    // 2) Repeated passive profile reads fail closed with NATIVE_PROFILES_UNAVAILABLE + reason,
    //    reusing the cached ambiguity failure with ZERO extra pool rescans.
    for (let i = 0; i < 2; i++) {
      await assert.rejects(readLocalProfile(), (error: unknown) => {
        const err = error as { code?: string; message?: string };
        assert.equal(err.code, 'NATIVE_PROFILES_UNAVAILABLE');
        assert.match(err.message ?? '', /ambiguous pool settings/);
        return true;
      });
    }
    assert.equal(
      poolSnapshotReads,
      1,
      'ambiguous failure must be cached until the next real pool edit',
    );
    assert.equal(existsSync(pathProbeLog), false);

    // 3) Coalesce paired Chokidar raw + all delivery for one canonical pool fix into ONE snapshot read,
    //    preserving immediate delivery to other watchers, then handle a second distinct edit.
    let otherWatcherDeliveries = 0;
    poolHandlers = createPoolWatcherHandlers({
      directory: tempPoolRoot,
      onPoolFileChanged: () => {
        otherWatcherDeliveries++;
      },
      onNativePoolChanged: () => {
        observations!.catalogChanged({ scope: 'all', reason: 'pool' });
      },
    });

    const canonicalFile = join(tempPoolRoot, 'local-ambig.json');
    const writeCanonical = (agyPath: string) => {
      writeFileSync(
        canonicalFile,
        JSON.stringify({
          machine: 'local-ambig',
          project: 'canonical',
          host: 'localhost',
          ssh_user: process.env.USER || 'operator',
          os: process.platform,
          platform: 'cli',
          antigravity_path: agyPath,
          slots: [{ id: 'slot-canon', enabled: true, mode: 'dispatch', repo: root, session: 's1' }],
        }),
      );
    };

    const invBeforeEdit1 = localInvalidations.length;
    writeCanonical(canonicalAgy);
    poolHandlers.onRaw('change', 'local-ambig.json', { watchedPath: tempPoolRoot });
    poolHandlers.onAll('change', canonicalFile);
    assert.equal(otherWatcherDeliveries, 2, 'other watchers keep existing paired behavior');

    const waitForLocalInvalidation = async (since: number, label: string) => {
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        if (
          localInvalidations
            .slice(since)
            .some((k) => k.family === 'profiles' && k.nodeId === 'local')
        ) {
          return;
        }
        await new Promise((r) => setTimeout(r, 15));
      }
      throw new Error(`Timed out waiting for ${label}`);
    };

    await waitForLocalInvalidation(invBeforeEdit1, 'first coalesced pool edit');
    assert.equal(
      poolSnapshotReads,
      2,
      'paired raw + all delivery for one edit must read the pool snapshot exactly once',
    );
    const recovered = await readLocalProfile();
    assert.equal(recovered.account.version, '1.5.14');
    assert.ok(recovered.loginCommand.includes(canonicalAgy));

    // Second distinct edit after the first coalesced notice flushes triggers one more snapshot read.
    const invBeforeEdit2 = localInvalidations.length;
    writeCanonical(canonicalAgyV2);
    poolHandlers.onRaw('change', 'local-ambig.json', { watchedPath: tempPoolRoot });
    poolHandlers.onAll('change', canonicalFile);
    await waitForLocalInvalidation(invBeforeEdit2, 'second coalesced pool edit');
    assert.equal(
      poolSnapshotReads,
      3,
      'second distinct pool edit must trigger exactly one additional snapshot read',
    );
    const afterEdit2 = await readLocalProfile();
    assert.equal(afterEdit2.account.version, '1.5.15');
    assert.ok(afterEdit2.loginCommand.includes(canonicalAgyV2));
  } finally {
    poolHandlers?.dispose();
    observations?.dispose();
    if (prevPoolDir === undefined) delete process.env.FARMSLOT_POOL_DIR;
    else process.env.FARMSLOT_POOL_DIR = prevPoolDir;
    if (prevFarmHome === undefined) delete process.env.FARMSLOT_HOME;
    else process.env.FARMSLOT_HOME = prevFarmHome;
    if (prevOwner === undefined) delete process.env.FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID;
    else process.env.FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID = prevOwner;
    if (prevPath === undefined) delete process.env.PATH;
    else process.env.PATH = prevPath;
    if (prevAgyEnv === undefined) delete process.env.FARMSLOT_AGY_EXECUTABLE;
    else process.env.FARMSLOT_AGY_EXECUTABLE = prevAgyEnv;
    rmSync(root, { recursive: true, force: true });
  }
});

test('stale in-flight local executable refresh cannot clear newer pool ambiguity error or reopen PATH fallback', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agy-local-fence-race-'));
  const farmHome = join(root, 'farm-home');
  const tempPoolRoot = join(root, 'pool');
  const localStateRoot = join(root, 'local-state');
  const profileDir1 = join(root, 'profile-work-1');
  const profileDir2 = join(root, 'profile-work-2');
  const pathBinDir = join(root, 'path-bin');
  const pathProbeLog = join(root, 'path-fallback-called.log');
  const fastAgy = join(root, 'fast-bin', 'agy');
  const heldAgy = join(root, 'held-bin', 'agy');
  const holdStartedMarker = join(root, 'hold-started.marker');
  const holdReleaseMarker = join(root, 'hold-release.marker');
  const holdDoneMarker = join(root, 'hold-done.marker');
  for (const dir of [
    farmHome,
    tempPoolRoot,
    localStateRoot,
    profileDir1,
    profileDir2,
    pathBinDir,
    dirname(fastAgy),
    dirname(heldAgy),
  ]) {
    mkdirSync(dir, { recursive: true });
  }
  chmodSync(localStateRoot, 0o700);

  const writeFakeAgy = (
    target: string,
    version: string,
    opts?: {
      logFile?: string;
      startedMarker?: string;
      releaseMarker?: string;
      doneMarker?: string;
    },
  ) => {
    const holdSnippet =
      opts?.startedMarker && opts?.releaseMarker
        ? `
  : > ${JSON.stringify(opts.startedMarker)}
  i=0
  while [ ! -f ${JSON.stringify(opts.releaseMarker)} ] && [ "$i" -lt 200 ]; do
    sleep 0.02
    i=$((i + 1))
  done
  printf '%s\\n' ${JSON.stringify(version)}
  exit 0
`
        : `
  printf '%s\\n' ${JSON.stringify(version)}
  exit 0
`;
    writeFileSync(
      target,
      `#!/bin/sh
${opts?.logFile ? `printf 'called\\n' >> ${JSON.stringify(opts.logFile)}` : ''}
for arg in "$@"; do
  if [ "$arg" = "--version" ]; then
    ${holdSnippet}
  fi
done
while IFS= read -r line; do
  id=$(printf '%s\\n' "$line" | sed -n 's/.*"id":"\\([^"]*\\)".*/\\1/p')
  case "$line" in
    *'"initialize"'*)
      printf '{"jsonrpc":"2.0","id":"%s","result":{"protocolVersion":1,"agentInfo":{"name":"Antigravity ACP Server","version":"%s"}}}\\n' "$id" ${JSON.stringify(version)}
      ;;
    *'"session/list"'*)
      ${opts?.doneMarker ? `: > ${JSON.stringify(opts.doneMarker)}` : ''}
      printf '{"jsonrpc":"2.0","id":"%s","result":{"sessions":[]}}\\n' "$id"
      exit 0
      ;;
  esac
done
`,
    );
    chmodSync(target, 0o700);
  };

  writeFakeAgy(join(pathBinDir, 'agy'), '0.0.0-path-fallback', { logFile: pathProbeLog });
  writeFakeAgy(fastAgy, '1.5.19');
  writeFakeAgy(heldAgy, '1.5.20', {
    startedMarker: holdStartedMarker,
    releaseMarker: holdReleaseMarker,
    doneMarker: holdDoneMarker,
  });

  // Two auxiliary localhost pools plus a canonical pool file that initially disambiguates them.
  for (const name of ['aux-local-a.json', 'aux-local-b.json']) {
    writeFileSync(
      join(tempPoolRoot, name),
      JSON.stringify({
        machine: 'local-fence',
        project: name,
        host: 'localhost',
        ssh_user: process.env.USER || 'operator',
        os: process.platform,
        platform: 'cli',
        antigravity_path: fastAgy,
        slots: [{ id: `slot-${name}`, enabled: true, mode: 'dispatch', repo: root, session: 's1' }],
      }),
    );
  }
  const canonicalFile = join(tempPoolRoot, 'local-fence.json');
  const writeCanonical = (agyPath: string) => {
    writeFileSync(
      canonicalFile,
      JSON.stringify({
        machine: 'local-fence',
        project: 'canonical',
        host: 'localhost',
        ssh_user: process.env.USER || 'operator',
        os: process.platform,
        platform: 'cli',
        antigravity_path: agyPath,
        slots: [{ id: 'slot-canon', enabled: true, mode: 'dispatch', repo: root, session: 's1' }],
      }),
    );
  };
  writeCanonical(fastAgy);

  const prevPoolDir = process.env.FARMSLOT_POOL_DIR;
  const prevFarmHome = process.env.FARMSLOT_HOME;
  const prevOwner = process.env.FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID;
  const prevPath = process.env.PATH;
  const prevAgyEnv = process.env.FARMSLOT_AGY_EXECUTABLE;
  let observations: GatewayNativeObservations | undefined;
  try {
    process.env.FARMSLOT_POOL_DIR = tempPoolRoot;
    process.env.FARMSLOT_HOME = farmHome;
    delete process.env.FARMSLOT_AGY_EXECUTABLE;
    process.env.PATH = `${pathBinDir}:${dirname(process.execPath)}:/usr/bin:/bin`;

    const auth = createGatewayAuthRuntime({ FARMSLOT_HOME: farmHome });
    const ownerRecord = auth.writer.createPrincipal(
      { type: 'person', displayName: 'Fence Owner' },
      [{ role: 'admin' as const, scope: { kind: 'global' as const } }],
      'fence-owner',
    );
    process.env.FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID = ownerRecord.id;

    const localClient = new NativeSessionClient(localStateRoot, 'local');
    await routeNativeProfile(localClient, ownerRecord.id, Methods.NATIVE_PROFILE_ADD, {
      profileId: 'work',
      runner: 'antigravity',
      directory: profileDir1,
    });

    const localInvalidations: Array<{ family: string; nodeId?: string }> = [];
    let onNextLocalProfileInvalidation: (() => void) | undefined;
    observations = new GatewayNativeObservations((key) => {
      const entry = {
        family: key.family,
        ...('nodeId' in key ? { nodeId: key.nodeId } : {}),
      };
      localInvalidations.push(entry);
      if (
        entry.family === 'profiles' &&
        entry.nodeId === 'local' &&
        onNextLocalProfileInvalidation
      ) {
        const cb = onNextLocalProfileInvalidation;
        onNextLocalProfileInvalidation = undefined;
        cb();
      }
    }, localClient);

    const clientConn = {};
    const principal: Principal = {
      id: ownerRecord.id,
      subject: { type: 'person', displayName: 'Fence Owner' },
      roles: [{ role: 'admin' as const, scope: { kind: 'global' as const } }],
    };
    observations.attachClient(clientConn, () => principal);

    const readLocalProfile = async (): Promise<NativeProfileStatusResult> => {
      const params = { executionNodeId: 'local', profileId: 'work' };
      const interests = nativeReadInterests(Methods.NATIVE_PROFILE_STATUS, params, ownerRecord.id);
      assert.ok(interests);
      const { payload } = await observations!.read(
        clientConn,
        interests,
        async () =>
          (await observations!.localProfileStatus(
            ownerRecord.id,
            'work',
          )) as NativeProfileStatusResult,
        () => null,
      );
      return payload;
    };

    // macOS FSEvents can deliver the preceding provider-accounts.json write asynchronously while
    // arming; retryable `arming-source-changed` is expected in production and retried once.
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await observations.startLocal(ownerRecord.id);
        break;
      } catch (error) {
        const reason = (error as { reason?: string } | undefined)?.reason;
        if (reason !== 'arming-source-changed' || attempt === 2) throw error;
      }
    }
    const readLocalSessionList = async () => {
      const params = { executionNodeId: 'local' };
      const interests = nativeReadInterests(Methods.NATIVE_SESSION_LIST, params, ownerRecord.id);
      assert.ok(interests);
      const { payload } = await observations!.read(
        clientConn,
        interests,
        async () => ({ sessions: [], unavailableExecutionNodes: [] }),
        () => null,
      );
      return payload;
    };

    const initial = await readLocalProfile();
    assert.equal(initial.account.version, '1.5.19');
    await readLocalSessionList();

    const pollFor = async (predicate: () => boolean, label: string) => {
      const deadline = Date.now() + 3_000;
      while (Date.now() < deadline) {
        if (predicate()) return;
        await new Promise((r) => setTimeout(r, 15));
      }
      throw new Error(`Timed out waiting for ${label}`);
    };

    // 1) A marked `native.profile.status` read admitted before the ambiguity edit and held after
    //    capturing the cached profile MUST reject once the pool becomes ambiguous, while a
    //    simultaneously held `native.session.list` read SURVIVES profile-only ambiguity with zero
    //    `native-session` invalidations.
    let readCaptured!: () => void;
    const readCapturedPromise = new Promise<void>((resolve) => {
      readCaptured = resolve;
    });
    let sessionListEntered!: () => void;
    const sessionListEnteredPromise = new Promise<void>((resolve) => {
      sessionListEntered = resolve;
    });
    let releaseStraddlingRead!: () => void;
    const straddlingGate = new Promise<void>((resolve) => {
      releaseStraddlingRead = resolve;
    });
    const sessionInvBeforeAmbig = localInvalidations.filter(
      (k) => k.family === 'native-session' && k.nodeId === 'local',
    ).length;
    const straddlingParams = { executionNodeId: 'local', profileId: 'work' };
    const straddlingInterests = nativeReadInterests(
      Methods.NATIVE_PROFILE_STATUS,
      straddlingParams,
      ownerRecord.id,
    );
    assert.ok(straddlingInterests);
    const sessionListInterests = nativeReadInterests(
      Methods.NATIVE_SESSION_LIST,
      { executionNodeId: 'local' },
      ownerRecord.id,
    );
    assert.ok(sessionListInterests);
    const straddlingReadPromise = observations.read(
      clientConn,
      straddlingInterests,
      async () => {
        const cached = (await observations!.localProfileStatus(
          ownerRecord.id,
          'work',
        )) as NativeProfileStatusResult;
        readCaptured();
        await straddlingGate;
        return cached;
      },
      () => null,
    );
    const heldSessionListPromise = observations.read(
      clientConn,
      sessionListInterests,
      async () => {
        sessionListEntered();
        await straddlingGate;
        return { sessions: [], unavailableExecutionNodes: [] };
      },
      () => null,
    );
    await Promise.all([readCapturedPromise, sessionListEnteredPromise]);
    unlinkSync(canonicalFile);
    observations.catalogChanged({ scope: 'all', reason: 'pool' });
    releaseStraddlingRead();
    await assert.rejects(straddlingReadPromise, (error: unknown) => {
      const err = error as { code?: string; message?: string };
      assert.equal(err.code, 'NATIVE_PROFILES_UNAVAILABLE');
      assert.match(err.message ?? '', /ambiguous pool settings/);
      return true;
    });
    const heldSessionList = await heldSessionListPromise;
    assert.deepEqual(heldSessionList.payload, { sessions: [], unavailableExecutionNodes: [] });
    assert.equal(
      localInvalidations.filter((k) => k.family === 'native-session' && k.nodeId === 'local')
        .length,
      sessionInvBeforeAmbig,
      'pool ambiguity must not invalidate unaffected native-session observers',
    );
    await readLocalSessionList();

    // Recover back to canonical fastAgy before exercising the held refresh race.
    const invBeforeBaselineRecover = localInvalidations.length;
    writeCanonical(fastAgy);
    observations.catalogChanged({ scope: 'all', reason: 'pool' });
    await pollFor(
      () =>
        localInvalidations
          .slice(invBeforeBaselineRecover)
          .some((k) => k.family === 'profiles' && k.nodeId === 'local'),
      'baseline canonical pool recovery',
    );
    assert.equal((await readLocalProfile()).account.version, '1.5.19');

    // 2) Start a valid refresh pointing to `heldAgy` (B) and wait until its probe is genuinely in flight.
    writeCanonical(heldAgy);
    observations.catalogChanged({ scope: 'all', reason: 'pool' });
    await pollFor(() => existsSync(holdStartedMarker), 'in-flight held refresh to start');

    // 3) While B is still in flight, remove the canonical file so the local pool becomes ambiguous.
    unlinkSync(canonicalFile);
    observations.catalogChanged({ scope: 'all', reason: 'pool' });
    const invalidationsAfterAmbiguity = localInvalidations.length;

    // 4) Release B and wait until its ACP probe finishes and the inner observer settles.
    writeFileSync(holdReleaseMarker, 'release');
    await pollFor(() => existsSync(holdDoneMarker), 'held refresh ACP probe to finish');
    await new Promise((r) => setTimeout(r, 80));

    // BEFORE any `readLocalProfile()` call can repair state:
    // - Releasing stale B must NOT publish a stale `profiles` invalidation.
    // - The inner observer must NOT have cached B.
    assert.equal(
      localInvalidations
        .slice(invalidationsAfterAmbiguity)
        .filter((k) => k.family === 'profiles' && k.nodeId === 'local').length,
      0,
      'stale B refresh finishing after pool ambiguity must not emit a profiles invalidation',
    );
    await assert.rejects(
      async () => observations!.localProfileStatus(ownerRecord.id, 'work'),
      (error: unknown) => {
        const err = error as { code?: string };
        assert.equal(err.code, 'NATIVE_PROFILES_UNAVAILABLE');
        return true;
      },
      'inner observer must not cache stale executable B after pool ambiguity',
    );

    // 5) Observe the actual next background sample BEFORE any profile read can repair state:
    //    adding a second active profile forces `NativeHostObservation` to re-arm and publish a
    //    `native-session` + `profiles` receipt only after its real background sample runs.
    const invBeforeRearm = localInvalidations.length;
    await routeNativeProfile(localClient, ownerRecord.id, Methods.NATIVE_PROFILE_ADD, {
      profileId: 'work-2',
      runner: 'antigravity',
      directory: profileDir2,
    });
    await pollFor(
      () =>
        localInvalidations
          .slice(invBeforeRearm)
          .some((k) => k.family === 'native-session' && k.nodeId === 'local'),
      'post-ambiguity background re-arm sample',
    );
    assert.equal(
      existsSync(pathProbeLog),
      false,
      'actual next background profile sample while pool is ambiguous must NEVER fall back to PATH',
    );

    // Passive profile reads still fail closed with the ambiguity error.
    await assert.rejects(readLocalProfile(), (error: unknown) => {
      const err = error as { code?: string; message?: string };
      assert.equal(err.code, 'NATIVE_PROFILES_UNAVAILABLE');
      assert.match(err.message ?? '', /ambiguous pool settings/);
      return true;
    });

    // 6) First legitimate recovery publication: when the canonical pool is restored, reading
    //    directly from the VERY FIRST `profiles` invalidation callback must observe a ready state
    //    (no "refreshing" error).
    let firstRecoveryReadPromise: Promise<NativeProfileStatusResult> | undefined;
    const firstRecoveryCallbackFired = new Promise<void>((resolve) => {
      onNextLocalProfileInvalidation = () => {
        firstRecoveryReadPromise = readLocalProfile();
        resolve();
      };
    });
    writeCanonical(fastAgy);
    observations.catalogChanged({ scope: 'all', reason: 'pool' });
    await Promise.race([
      firstRecoveryCallbackFired,
      new Promise<never>((_resolve, reject) =>
        setTimeout(() => reject(new Error('Timed out waiting for first recovery callback')), 3_000),
      ),
    ]);
    assert.ok(firstRecoveryReadPromise);
    const recovered = await firstRecoveryReadPromise;
    assert.equal(recovered.account.version, '1.5.19');
    assert.ok(recovered.loginCommand.includes(fastAgy));
    assert.equal(existsSync(pathProbeLog), false);
  } finally {
    observations?.dispose();
    if (prevPoolDir === undefined) delete process.env.FARMSLOT_POOL_DIR;
    else process.env.FARMSLOT_POOL_DIR = prevPoolDir;
    if (prevFarmHome === undefined) delete process.env.FARMSLOT_HOME;
    else process.env.FARMSLOT_HOME = prevFarmHome;
    if (prevOwner === undefined) delete process.env.FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID;
    else process.env.FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID = prevOwner;
    if (prevPath === undefined) delete process.env.PATH;
    else process.env.PATH = prevPath;
    if (prevAgyEnv === undefined) delete process.env.FARMSLOT_AGY_EXECUTABLE;
    else process.env.FARMSLOT_AGY_EXECUTABLE = prevAgyEnv;
    rmSync(root, { recursive: true, force: true });
  }
});

test('NativeHostObservation configuration epoch fences resolved/rejected refreshes and final startup scan', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agy-epoch-inner-'));
  const farmHome = join(root, 'farm-home');
  const localStateRoot = join(root, 'local-state');
  mkdirSync(farmHome, { recursive: true });
  mkdirSync(localStateRoot, { recursive: true, mode: 0o700 });
  chmodSync(localStateRoot, 0o700);

  const prevFarmHome = process.env.FARMSLOT_HOME;
  const prevOwner = process.env.FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID;
  let obs: NativeHostObservation | undefined;
  try {
    process.env.FARMSLOT_HOME = farmHome;
    const auth = createGatewayAuthRuntime({ FARMSLOT_HOME: farmHome });
    const ownerRecord = auth.writer.createPrincipal(
      { type: 'person', displayName: 'Epoch Owner' },
      [{ role: 'admin' as const, scope: { kind: 'global' as const } }],
      'epoch-owner',
    );
    const ownerId = ownerRecord.id;
    process.env.FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID = ownerId;

    // Part 1: Controlled deferred settlement on `NativeHostObservation` for resolved AND rejected
    // held refreshes plus first legitimate recovery publication (zero timers).
    const makeStatus = (version: string): NativeProfileStatusResult => ({
      profile: {
        id: 'work',
        runner: 'antigravity',
        directory: join(root, 'profile-work'),
        accountContextId: '22222222-2222-4222-8222-222222222222',
        state: 'active',
      },
      account: {
        runner: 'antigravity',
        installed: true,
        executable: `/opt/agy-${version}`,
        version,
        login: 'authenticated',
        mode: 'subscription',
        identityQuality: 'unavailable',
        observedAt: '2026-11-28T00:00:00.000Z',
      },
      loginCommand: `/opt/agy-${version}`,
    });

    const sampleQueue: Array<() => Promise<NativeProfileStatusResult[]>> = [
      async () => [makeStatus('1.5.19')],
    ];
    const publishedReceipts: NativeSourceReceipt[] = [];
    const client = new NativeSessionClient(localStateRoot, 'local');
    obs = new NativeHostObservation(
      client,
      ownerId,
      (receipt) => {
        publishedReceipts.push(receipt);
      },
      farmHome,
      async () => {
        const next = sampleQueue.shift();
        assert.ok(next, 'unexpected background sample without scheduled handler');
        return next();
      },
      undefined,
      canonicalTrustedExecutablesDigest({ antigravity: '/opt/agy-1.5.19' }),
    );
    await obs.start();
    assert.equal((await obs.profileStatus('work')).account.version, '1.5.19');

    // 1a) Hold a resolved refresh for executable B, invalidate to ambiguous, then resolve B.
    let resolveSampleB!: (value: NativeProfileStatusResult[]) => void;
    let sampleBStarted!: () => void;
    const sampleBStartedPromise = new Promise<void>((resolve) => {
      sampleBStarted = resolve;
    });
    sampleQueue.push(
      () =>
        new Promise<NativeProfileStatusResult[]>((resolve) => {
          resolveSampleB = resolve;
          sampleBStarted();
        }),
    );
    const setBP = obs.setExecutableConfig(
      canonicalTrustedExecutablesDigest({ antigravity: '/opt/agy-1.5.20' }),
    );
    await sampleBStartedPromise;
    const receiptsBeforeInvalidate = publishedReceipts.length;
    const revBeforeInvalidate = obs.current().revision;
    obs.invalidateExecutableConfig('invalid:pool-resolution-failed:1');
    assert.equal(
      obs.current().revision,
      revBeforeInvalidate,
      'profile-only invalidation must not advance the shared source receipt revision',
    );
    assert.equal(
      publishedReceipts.length,
      receiptsBeforeInvalidate,
      'profile-only invalidation must not publish a receipt that would interrupt session reads',
    );

    resolveSampleB([makeStatus('1.5.20')]);
    await setBP;
    assert.equal(
      obs.current().revision,
      revBeforeInvalidate,
      'stale resolved sample B must not advance the receipt',
    );
    assert.equal(
      publishedReceipts.length,
      receiptsBeforeInvalidate,
      'stale resolved sample B must not publish a stale profile invalidation',
    );
    await assert.rejects(obs.profileStatus('work'), (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'NATIVE_PROFILES_UNAVAILABLE');
      return true;
    });

    // 1b) Hold a REJECTED refresh for executable C, invalidate, then reject C.
    let rejectSampleC!: (err: Error) => void;
    let sampleCStarted!: () => void;
    const sampleCStartedPromise = new Promise<void>((resolve) => {
      sampleCStarted = resolve;
    });
    sampleQueue.push(
      () =>
        new Promise<NativeProfileStatusResult[]>((_resolve, reject) => {
          rejectSampleC = reject;
          sampleCStarted();
        }),
    );
    const setCP = obs.setExecutableConfig(
      canonicalTrustedExecutablesDigest({ antigravity: '/opt/agy-1.5.21' }),
    );
    await sampleCStartedPromise;
    obs.invalidateExecutableConfig('invalid:pool-resolution-failed:2');
    const receiptsAfterSecondInvalidate = publishedReceipts.length;
    const revAfterSecondInvalidate = obs.current().revision;
    rejectSampleC(new Error('stale probe failure'));
    await setCP;
    assert.equal(obs.current().revision, revAfterSecondInvalidate);
    assert.equal(publishedReceipts.length, receiptsAfterSecondInvalidate);
    await assert.rejects(obs.profileStatus('work'), (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'NATIVE_PROFILES_UNAVAILABLE');
      return true;
    });

    // 1c) Legitimate recovery back to the original digest publishes once and serves fresh data.
    sampleQueue.push(async () => [makeStatus('1.5.22')]);
    const receiptsBeforeRecover = publishedReceipts.length;
    await obs.setExecutableConfig(
      canonicalTrustedExecutablesDigest({ antigravity: '/opt/agy-1.5.19' }),
    );
    assert.equal(publishedReceipts.length, receiptsBeforeRecover + 1);
    assert.deepEqual(publishedReceipts.at(-1)?.changed, ['profiles']);
    assert.equal((await obs.profileStatus('work')).account.version, '1.5.22');

    // 1d) Controlled arming interleaving: gate the final `after = await scan()` ITSELF (scan #2,
    //     after `observeAccounts()` has already resolved) and invalidate executable config while
    //     suspended inside that final scan. Moving `sampleChanged` before `await scan()` makes this
    //     control fail.
    const armingReceipts: NativeSourceReceipt[] = [];
    let finalScanEntered!: () => void;
    const finalScanEnteredP = new Promise<void>((resolve) => {
      finalScanEntered = resolve;
    });
    let releaseFinalScan!: () => void;
    const finalScanGate = new Promise<void>((resolve) => {
      releaseFinalScan = resolve;
    });
    class GatedFinalScanObservation extends NativeHostObservation {
      scanCalls = 0;
      protected override async scan(): Promise<NativeSourceSnapshot> {
        if (++this.scanCalls === 2) {
          finalScanEntered();
          await finalScanGate;
        }
        return super.scan();
      }
    }
    const armingObs = new GatedFinalScanObservation(
      client,
      ownerId,
      (receipt) => {
        armingReceipts.push(receipt);
      },
      farmHome,
      async () => [makeStatus('1.5.19')],
      undefined,
      canonicalTrustedExecutablesDigest({ antigravity: '/opt/agy-1.5.19' }),
    );
    try {
      const startPromise = armingObs.start();
      await finalScanEnteredP;
      armingObs.invalidateExecutableConfig('invalid:arming-final-scan');
      releaseFinalScan();
      await assert.rejects(startPromise, (error: unknown) => {
        const err = error as { code?: string; reason?: string };
        assert.equal(err.code, 'NATIVE_SOURCE_UNAVAILABLE');
        assert.equal(err.reason, 'arming-source-changed');
        return true;
      });
      assert.equal(armingObs.scanCalls, 2);
      assert.equal(
        armingReceipts.some((r) => r.ready),
        false,
        'arming invalidated during final scan must never publish a ready receipt',
      );
      assert.equal(armingObs.current().ready, false);
    } finally {
      armingObs.stop();
    }
  } finally {
    obs?.stop();
    if (prevFarmHome === undefined) delete process.env.FARMSLOT_HOME;
    else process.env.FARMSLOT_HOME = prevFarmHome;
    if (prevOwner === undefined) delete process.env.FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID;
    else process.env.FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID = prevOwner;
    rmSync(root, { recursive: true, force: true });
  }
});

test('combined local rearming recovery defers profiles until commit and supports read from first callback', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'agy-epoch-rearm-'));
  const farmHome = join(root, 'farm-home');
  const rearmPoolDir = join(root, 'rearm-pool');
  const rearmStateRoot = join(root, 'rearm-local-state');
  mkdirSync(farmHome, { recursive: true });
  mkdirSync(rearmPoolDir, { recursive: true });
  mkdirSync(rearmStateRoot, { recursive: true, mode: 0o700 });
  chmodSync(rearmStateRoot, 0o700);

  const prevPoolDir = process.env.FARMSLOT_POOL_DIR;
  const prevFarmHome = process.env.FARMSLOT_HOME;
  const prevOwner = process.env.FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID;
  let rearmObs: GatewayNativeObservations | undefined;
  try {
    process.env.FARMSLOT_HOME = farmHome;
    process.env.FARMSLOT_POOL_DIR = rearmPoolDir;
    const auth = createGatewayAuthRuntime({ FARMSLOT_HOME: farmHome });
    const ownerRecord = auth.writer.createPrincipal(
      { type: 'person', displayName: 'Rearm Owner' },
      [{ role: 'admin' as const, scope: { kind: 'global' as const } }],
      'rearm-owner',
    );
    const ownerId = ownerRecord.id;
    process.env.FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID = ownerId;
    const rearmClient = new NativeSessionClient(rearmStateRoot, 'local');
    const rearmAgy = join(root, 'rearm-bin', 'agy');
    mkdirSync(dirname(rearmAgy), { recursive: true });
    writeFileSync(
      rearmAgy,
      `#!/bin/sh
for arg in "$@"; do
  if [ "$arg" = "--version" ]; then
    printf '1.5.25\\n'
    exit 0
  fi
done
while IFS= read -r line; do
  id=$(printf '%s\\n' "$line" | sed -n 's/.*"id":"\\([^"]*\\)".*/\\1/p')
  case "$line" in
    *'"initialize"'*)
      printf '{"jsonrpc":"2.0","id":"%s","result":{"protocolVersion":1,"agentInfo":{"name":"Antigravity ACP Server","version":"1.5.25"}}}\\n' "$id"
      ;;
    *'"session/list"'*)
      printf '{"jsonrpc":"2.0","id":"%s","result":{"sessions":[]}}\\n' "$id"
      exit 0
      ;;
  esac
done
`,
    );
    chmodSync(rearmAgy, 0o700);
    const rearmProfileDir = join(root, 'rearm-profile');
    mkdirSync(rearmProfileDir, { recursive: true });
    await routeNativeProfile(rearmClient, ownerId, Methods.NATIVE_PROFILE_ADD, {
      profileId: 'rearm-work',
      runner: 'antigravity',
      directory: rearmProfileDir,
    });
    const writeRearmCanonical = () =>
      writeFileSync(
        join(rearmPoolDir, 'rearm-local.json'),
        JSON.stringify({
          machine: 'rearm-local',
          project: 'rearm',
          host: 'localhost',
          ssh_user: process.env.USER || 'operator',
          os: process.platform,
          platform: 'cli',
          antigravity_path: rearmAgy,
          slots: [{ id: 'slot-rearm', enabled: true, mode: 'dispatch', repo: root, session: 's1' }],
        }),
      );
    for (const aux of ['rearm-aux-a.json', 'rearm-aux-b.json']) {
      writeFileSync(
        join(rearmPoolDir, aux),
        JSON.stringify({
          machine: 'rearm-local',
          project: aux,
          host: 'localhost',
          ssh_user: process.env.USER || 'operator',
          os: process.platform,
          platform: 'cli',
          antigravity_path: rearmAgy,
          slots: [
            { id: `slot-${aux}`, enabled: true, mode: 'dispatch', repo: root, session: 's1' },
          ],
        }),
      );
    }

    const rearmEvents: string[] = [];
    let firstRearmProfileRead: Promise<NativeProfileStatusResult> | undefined;
    let firstRearmProfileFired!: () => void;
    const firstRearmProfileFiredP = new Promise<void>((resolve) => {
      firstRearmProfileFired = resolve;
    });
    const rearmConn = {};
    const rearmPrincipal: Principal = {
      id: ownerId,
      subject: { type: 'person', displayName: 'Rearm Owner' },
      roles: [{ role: 'admin' as const, scope: { kind: 'global' as const } }],
    };
    const readRearmProfile = async (): Promise<NativeProfileStatusResult> => {
      const interests = nativeReadInterests(
        Methods.NATIVE_PROFILE_STATUS,
        { executionNodeId: 'local', profileId: 'rearm-work' },
        ownerId,
      );
      assert.ok(interests);
      const { payload } = await rearmObs!.read(
        rearmConn,
        interests,
        async () =>
          (await rearmObs!.localProfileStatus(ownerId, 'rearm-work')) as NativeProfileStatusResult,
        () => null,
      );
      return payload;
    };
    let captureRearmRecovery = false;
    rearmObs = new GatewayNativeObservations((key) => {
      if ('nodeId' in key && key.nodeId === 'local') {
        rearmEvents.push(key.family);
        if (captureRearmRecovery && key.family === 'profiles' && !firstRearmProfileRead) {
          firstRearmProfileRead = readRearmProfile();
          firstRearmProfileFired();
        }
      }
    }, rearmClient);
    rearmObs.attachClient(rearmConn, () => rearmPrincipal);
    await rearmObs.startLocal(ownerId);
    const sessInterests = nativeReadInterests(
      Methods.NATIVE_SESSION_LIST,
      { executionNodeId: 'local' },
      ownerId,
    );
    assert.ok(sessInterests);
    await rearmObs.read(
      rearmConn,
      sessInterests,
      async () => ({ sessions: [], unavailableExecutionNodes: [] }),
      () => null,
    );
    await assert.rejects(readRearmProfile(), { code: 'NATIVE_PROFILES_UNAVAILABLE' });

    // Transition the local observer to `!ready` through a single injected `lstat` scan error
    // (no filesystem mutation, so no stray macOS FSEvents collide with `local.retry()`).
    // Restoring the canonical pool then runs `local.retry()` and publishes `['native-session', 'profiles']`.
    const origLstat = fsPromises.lstat;
    let injectScanError = true;
    const lstatMock = t.mock.method(
      fsPromises,
      'lstat',
      async (...args: Parameters<typeof origLstat>) => {
        if (injectScanError && String(args[0]) === rearmStateRoot) {
          injectScanError = false;
          throw Object.assign(new Error('injected scan error'), { code: 'EIO' });
        }
        return origLstat(...args);
      },
    );
    syncBuiltinESMExports();
    try {
      await assert.rejects(
        rearmObs.read(
          rearmConn,
          sessInterests,
          async () => ({ sessions: [], unavailableExecutionNodes: [] }),
          () => null,
        ),
        { code: 'NATIVE_SOURCE_UNAVAILABLE' },
      );
    } finally {
      lstatMock.mock.restore();
      syncBuiltinESMExports();
    }

    rearmEvents.length = 0;
    captureRearmRecovery = true;
    writeRearmCanonical();
    rearmObs.catalogChanged({ scope: 'all', reason: 'pool' });
    await Promise.race([
      firstRearmProfileFiredP,
      new Promise<never>((_r, reject) =>
        setTimeout(() => reject(new Error('Timed out waiting for combined rearm recovery')), 3_000),
      ),
    ]);
    assert.ok(firstRearmProfileRead);
    const rearmRecovered = await firstRearmProfileRead;
    assert.equal(rearmRecovered.account.version, '1.5.25');
    assert.ok(
      rearmEvents.includes('native-session'),
      'combined rearming notice must still publish native-session immediately',
    );
    assert.ok(
      rearmEvents.indexOf('native-session') < rearmEvents.indexOf('profiles'),
      'native-session portion must publish before deferred profiles recovery notice',
    );
  } finally {
    rearmObs?.dispose();
    if (prevPoolDir === undefined) delete process.env.FARMSLOT_POOL_DIR;
    else process.env.FARMSLOT_POOL_DIR = prevPoolDir;
    if (prevFarmHome === undefined) delete process.env.FARMSLOT_HOME;
    else process.env.FARMSLOT_HOME = prevFarmHome;
    if (prevOwner === undefined) delete process.env.FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID;
    else process.env.FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID = prevOwner;
    rmSync(root, { recursive: true, force: true });
  }
});

test('held local native.session.list rejects when account refresh consumes session metadata change and survives profile-only refresh', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'agy-local-session-refresh-'));
  const silentWatchDir = mkdtempSync(join(tmpdir(), 'agy-local-silent-watch-'));
  const farmHome = join(root, 'farm-home');
  const fixturePoolPath = join(root, 'pool');
  const stateRoot = join(root, 'local-state');
  const sessionsDir = join(stateRoot, 'sessions');
  mkdirSync(farmHome, { recursive: true });
  mkdirSync(fixturePoolPath, { recursive: true });
  mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
  chmodSync(stateRoot, 0o700);
  mkdirSync(sessionsDir, { recursive: true, mode: 0o700 });
  chmodSync(sessionsDir, 0o700);
  const metadataFile = join(sessionsDir, 'metadata.json');
  writeFileSync(metadataFile, JSON.stringify({ revision: 'rev-1' }), { mode: 0o600 });

  // Silence fs.watch so watcher delivery cannot race ahead of refreshAccounts(); only the
  // account refresh scan itself can observe and consume the metadata.json revision change.
  const origWatch = fs.watch;
  const watchMock = t.mock.method(
    fs,
    'watch',
    (_path: unknown, options: { recursive?: boolean }, listener: never) =>
      origWatch(silentWatchDir, options, listener),
  );
  syncBuiltinESMExports();

  const prevPoolDir = process.env.FARMSLOT_POOL_DIR;
  const prevFarmHome = process.env.FARMSLOT_HOME;
  const prevOwner = process.env.FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID;
  let gatewayObs: GatewayNativeObservations | undefined;
  try {
    process.env.FARMSLOT_HOME = farmHome;
    process.env.FARMSLOT_POOL_DIR = fixturePoolPath;
    const auth = createGatewayAuthRuntime({ FARMSLOT_HOME: farmHome });
    const ownerRecord = auth.writer.createPrincipal(
      { type: 'person', displayName: 'Refresh Facet Owner' },
      [{ role: 'admin' as const, scope: { kind: 'global' as const } }],
      'refresh-facet-owner',
    );
    const ownerId = ownerRecord.id;
    process.env.FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID = ownerId;
    const writeLocalPool = (agyPath: string) =>
      writeFileSync(
        join(fixturePoolPath, 'local.json'),
        JSON.stringify({
          machine: 'local-refresh',
          project: 'refresh',
          host: 'localhost',
          ssh_user: process.env.USER || 'operator',
          os: process.platform,
          platform: 'cli',
          antigravity_path: agyPath,
          slots: [
            { id: 'slot-refresh', enabled: true, mode: 'dispatch', repo: root, session: 's1' },
          ],
        }),
      );
    writeLocalPool('/opt/agy-v1');

    const localClient = new NativeSessionClient(stateRoot, 'local');
    const events: string[] = [];
    gatewayObs = new GatewayNativeObservations((key) => {
      if ('nodeId' in key && key.nodeId === 'local') {
        events.push(key.family);
      }
    }, localClient);
    const conn = {};
    const principal: Principal = {
      id: ownerId,
      subject: { type: 'person', displayName: 'Refresh Facet Owner' },
      roles: [{ role: 'admin' as const, scope: { kind: 'global' as const } }],
    };
    gatewayObs.attachClient(conn, () => principal);
    await gatewayObs.startLocal(ownerId);

    const pollUntil = async (predicate: () => boolean, label: string) => {
      const deadline = Date.now() + 2_000;
      while (Date.now() < deadline) {
        if (predicate()) return;
        await new Promise((r) => setTimeout(r, 10));
      }
      throw new Error(`Timed out waiting for ${label}`);
    };
    const sessInterests = nativeReadInterests(
      Methods.NATIVE_SESSION_LIST,
      { executionNodeId: 'local' },
      ownerId,
    );
    assert.ok(sessInterests);
    const profileInterests = nativeReadInterests(
      Methods.NATIVE_PROFILE_LIST,
      { executionNodeId: 'local' },
      ownerId,
    );
    assert.ok(profileInterests);
    // Register a local profiles subscriber so profile-only refresh invalidations are observable.
    await gatewayObs.read(
      conn,
      profileInterests,
      async () => ({ profiles: [] }),
      () => null,
    );

    // Control 1: Profile-only account refresh leaves held local native.session.list valid.
    let enteredProfileOnly!: () => void;
    const enteredProfileOnlyP = new Promise<void>((resolve) => {
      enteredProfileOnly = resolve;
    });
    let releaseProfileOnly!: () => void;
    const profileOnlyGate = new Promise<void>((resolve) => {
      releaseProfileOnly = resolve;
    });
    const heldProfileOnly = gatewayObs.read(
      conn,
      sessInterests,
      async () => {
        enteredProfileOnly();
        await profileOnlyGate;
        return { sessions: [], unavailableExecutionNodes: [] };
      },
      () => null,
    );
    await enteredProfileOnlyP;
    const eventsBeforeProfileOnly = events.length;
    writeLocalPool('/opt/agy-v2');
    gatewayObs.catalogChanged({ scope: 'all', reason: 'pool' });
    await pollUntil(
      () => events.slice(eventsBeforeProfileOnly).includes('profiles'),
      'profile-only account refresh invalidation',
    );
    releaseProfileOnly();
    const profileOnlyResult = await heldProfileOnly;
    assert.deepEqual(profileOnlyResult.payload, { sessions: [], unavailableExecutionNodes: [] });

    // Regression: Session metadata changes BEFORE account refresh scans it (and refresh updates
    // the shared snapshot ahead of fs.watch). Held local native.session.list MUST reject with
    // RESOURCE_OBSERVATION_CHANGED instead of returning stale history.
    let enteredSessionChange!: () => void;
    const enteredSessionChangeP = new Promise<void>((resolve) => {
      enteredSessionChange = resolve;
    });
    let releaseSessionChange!: () => void;
    const sessionChangeGate = new Promise<void>((resolve) => {
      releaseSessionChange = resolve;
    });
    const heldSessionChange = gatewayObs.read(
      conn,
      sessInterests,
      async () => {
        enteredSessionChange();
        await sessionChangeGate;
        return { sessions: [{ id: 'stale-session' }], unavailableExecutionNodes: [] };
      },
      () => null,
    );
    await enteredSessionChangeP;
    const eventsBeforeSessionChange = events.length;
    writeFileSync(metadataFile, JSON.stringify({ revision: 'rev-2' }), { mode: 0o600 });
    writeLocalPool('/opt/agy-v3');
    gatewayObs.catalogChanged({ scope: 'all', reason: 'pool' });
    await pollUntil(
      () => events.slice(eventsBeforeSessionChange).includes('profiles'),
      'account refresh after session metadata change',
    );
    releaseSessionChange();
    await assert.rejects(heldSessionChange, (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'RESOURCE_OBSERVATION_CHANGED');
      return true;
    });
    assert.ok(
      events.slice(eventsBeforeSessionChange).includes('native-session'),
      'account refresh consuming a session metadata change must preserve the native-session facet',
    );
  } finally {
    gatewayObs?.dispose();
    watchMock.mock.restore();
    syncBuiltinESMExports();
    if (prevPoolDir === undefined) delete process.env.FARMSLOT_POOL_DIR;
    else process.env.FARMSLOT_POOL_DIR = prevPoolDir;
    if (prevFarmHome === undefined) delete process.env.FARMSLOT_HOME;
    else process.env.FARMSLOT_HOME = prevFarmHome;
    if (prevOwner === undefined) delete process.env.FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID;
    else process.env.FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID = prevOwner;
    rmSync(root, { recursive: true, force: true });
    rmSync(silentWatchDir, { recursive: true, force: true });
  }
});

test('automatic local rearm after transient startup failure settles executable epoch and serves first profiles callback without pool edit', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agy-local-auto-rearm-'));
  const farmHome = join(root, 'farm-home');
  const fixturePoolPath = join(root, 'pool');
  const healthyStateRoot = join(root, 'healthy-state');
  const autoRearmStateRoot = join(root, 'auto-rearm-state');
  mkdirSync(farmHome, { recursive: true });
  mkdirSync(fixturePoolPath, { recursive: true });
  mkdirSync(healthyStateRoot, { recursive: true, mode: 0o700 });
  chmodSync(healthyStateRoot, 0o700);
  mkdirSync(autoRearmStateRoot, { recursive: true, mode: 0o700 });
  chmodSync(autoRearmStateRoot, 0o700);

  const prevPoolDir = process.env.FARMSLOT_POOL_DIR;
  const prevFarmHome = process.env.FARMSLOT_HOME;
  const prevOwner = process.env.FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID;
  let healthyObs: GatewayNativeObservations | undefined;
  let autoRearmObs: GatewayNativeObservations | undefined;
  try {
    process.env.FARMSLOT_HOME = farmHome;
    process.env.FARMSLOT_POOL_DIR = fixturePoolPath;
    const auth = createGatewayAuthRuntime({ FARMSLOT_HOME: farmHome });
    const ownerRecord = auth.writer.createPrincipal(
      { type: 'person', displayName: 'Auto Rearm Owner' },
      [{ role: 'admin' as const, scope: { kind: 'global' as const } }],
      'auto-rearm-owner',
    );
    const ownerId = ownerRecord.id;
    process.env.FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID = ownerId;

    const fakeAgy = join(root, 'bin', 'agy');
    mkdirSync(dirname(fakeAgy), { recursive: true });
    writeFileSync(
      fakeAgy,
      `#!/bin/sh
for arg in "$@"; do
  if [ "$arg" = "--version" ]; then
    printf '1.5.26\\n'
    exit 0
  fi
done
while IFS= read -r line; do
  id=$(printf '%s\\n' "$line" | sed -n 's/.*"id":"\\([^"]*\\)".*/\\1/p')
  case "$line" in
    *'"initialize"'*)
      printf '{"jsonrpc":"2.0","id":"%s","result":{"protocolVersion":1,"agentInfo":{"name":"Antigravity ACP Server","version":"1.5.26"}}}\\n' "$id"
      ;;
    *'"session/list"'*)
      printf '{"jsonrpc":"2.0","id":"%s","result":{"sessions":[]}}\\n' "$id"
      exit 0
      ;;
  esac
done
`,
    );
    chmodSync(fakeAgy, 0o700);
    writeFileSync(
      join(fixturePoolPath, 'auto-local.json'),
      JSON.stringify({
        machine: 'auto-local',
        project: 'auto-rearm',
        host: 'localhost',
        ssh_user: process.env.USER || 'operator',
        os: process.platform,
        platform: 'cli',
        antigravity_path: fakeAgy,
        slots: [{ id: 'slot-auto', enabled: true, mode: 'dispatch', repo: root, session: 's1' }],
      }),
    );
    const profileDir = join(root, 'profile-auto');
    mkdirSync(profileDir, { recursive: true });
    const healthyClient = new NativeSessionClient(healthyStateRoot, 'local');
    await routeNativeProfile(healthyClient, ownerId, Methods.NATIVE_PROFILE_ADD, {
      profileId: 'auto-work',
      runner: 'antigravity',
      directory: profileDir,
    });

    const principal: Principal = {
      id: ownerId,
      subject: { type: 'person', displayName: 'Auto Rearm Owner' },
      roles: [{ role: 'admin' as const, scope: { kind: 'global' as const } }],
    };
    const readLocalProfile = async (
      obs: GatewayNativeObservations,
      conn: object,
    ): Promise<NativeProfileStatusResult> => {
      const interests = nativeReadInterests(
        Methods.NATIVE_PROFILE_STATUS,
        { executionNodeId: 'local', profileId: 'auto-work' },
        ownerId,
      );
      assert.ok(interests);
      const { payload } = await obs.read(
        conn,
        interests,
        async () =>
          (await obs.localProfileStatus(ownerId, 'auto-work')) as NativeProfileStatusResult,
        () => null,
      );
      return payload;
    };

    // Control 1: Original healthy startup settles epoch before its first profiles callback.
    const healthyConn = {};
    let healthyFirstProfileRead: Promise<NativeProfileStatusResult> | undefined;
    healthyObs = new GatewayNativeObservations((key) => {
      if ('nodeId' in key && key.nodeId === 'local' && key.family === 'profiles') {
        if (!healthyFirstProfileRead) {
          healthyFirstProfileRead = readLocalProfile(healthyObs!, healthyConn);
        }
      }
    }, healthyClient);
    healthyObs.attachClient(healthyConn, () => principal);
    const localProfileListInterests = nativeReadInterests(
      Methods.NATIVE_PROFILE_LIST,
      { executionNodeId: 'local' },
      ownerId,
    );
    assert.ok(localProfileListInterests);
    const localSessionListInterests = nativeReadInterests(
      Methods.NATIVE_SESSION_LIST,
      { executionNodeId: 'local' },
      ownerId,
    );
    assert.ok(localSessionListInterests);
    // Register the profiles subscriber before startLocal so the initial startup publication notifies it.
    await assert.rejects(
      healthyObs.read(
        healthyConn,
        localProfileListInterests,
        async () => ({ profiles: [] }),
        () => null,
      ),
      { code: 'NATIVE_SOURCE_UNAVAILABLE' },
    );
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        // macOS FSEvents can deliver the provider-accounts.json write during arming; retry only that retryable race.
        await healthyObs.startLocal(ownerId);
        break;
      } catch (error) {
        const reason = (error as { reason?: string } | undefined)?.reason;
        if (reason !== 'arming-source-changed' || attempt === 2) throw error;
      }
    }
    assert.ok(healthyFirstProfileRead, 'healthy startup must deliver a profiles notification');
    assert.equal((await healthyFirstProfileRead).account.version, '1.5.26');

    // Regression: Transient startup failure (dead supervisor host.json) followed by
    // automatic fs.watch recovery WITHOUT any pool edit or manual reread.
    const autoSessionsDir = join(autoRearmStateRoot, 'sessions');
    mkdirSync(autoSessionsDir, { recursive: true, mode: 0o700 });
    chmodSync(autoSessionsDir, 0o700);
    const autoMetadataFile = join(autoSessionsDir, 'metadata.json');
    writeFileSync(autoMetadataFile, JSON.stringify({ revision: 'auto-rev-0' }), { mode: 0o600 });
    const deadPid = spawnSync(process.execPath, ['-e', '']).pid;
    assert.ok(deadPid);
    const brokenHostFile = join(autoRearmStateRoot, 'host.json');
    writeFileSync(
      brokenHostFile,
      JSON.stringify({ pid: deadPid, socket: join(autoRearmStateRoot, 'gone.sock') }),
      { mode: 0o600 },
    );
    const autoConn = {};
    let captureAutoRecovery = false;
    let autoFirstProfileRead: Promise<NativeProfileStatusResult> | undefined;
    let autoFirstProfileFired!: () => void;
    let autoProfileDelivered = false;
    const autoFirstProfileFiredP = new Promise<void>((resolve) => {
      autoFirstProfileFired = resolve;
    });
    const autoEvents: string[] = [];
    const autoClient = new NativeSessionClient(autoRearmStateRoot, 'local');
    autoRearmObs = new GatewayNativeObservations((key) => {
      if ('nodeId' in key && key.nodeId === 'local') {
        autoEvents.push(key.family);
        if (captureAutoRecovery && key.family === 'profiles' && !autoFirstProfileRead) {
          autoProfileDelivered = true;
          autoFirstProfileRead = readLocalProfile(autoRearmObs!, autoConn);
          autoFirstProfileFired();
        }
      }
    }, autoClient);
    autoRearmObs.attachClient(autoConn, () => principal);
    await assert.rejects(autoRearmObs.startLocal(ownerId), {
      code: 'NATIVE_SOURCE_UNAVAILABLE',
      reason: 'host-identity-invalid',
    });
    // Register existing local profile-list and session-list subscribers while unavailable.
    // Neither call triggers a manual profile executable sync or pool edit.
    await assert.rejects(
      autoRearmObs.read(
        autoConn,
        localProfileListInterests,
        async () => ({ profiles: [] }),
        () => null,
      ),
      { code: 'NATIVE_SOURCE_UNAVAILABLE' },
    );
    await assert.rejects(
      autoRearmObs.read(
        autoConn,
        localSessionListInterests,
        async () => ({ sessions: [], unavailableExecutionNodes: [] }),
        () => null,
      ),
      { code: 'NATIVE_SOURCE_UNAVAILABLE' },
    );

    autoEvents.length = 0;
    captureAutoRecovery = true;
    // Clear the transient host failure without touching pool files or invoking catalogChanged.
    unlinkSync(brokenHostFile);
    // On macOS, FSEvents can re-deliver the unlink event to the freshly opened watcher during
    // arming (`arming-source-changed`); an ordinary session metadata event (never a pool edit
    // or manual reread) lets the source finish automatic recovery cleanly.
    let nudgeCount = 0;
    const nudgeTimer = setInterval(() => {
      if (autoProfileDelivered) return;
      writeFileSync(autoMetadataFile, JSON.stringify({ revision: `auto-rev-${++nudgeCount}` }), {
        mode: 0o600,
      });
    }, 750);
    try {
      await Promise.race([
        autoFirstProfileFiredP,
        new Promise<never>((_resolve, reject) =>
          setTimeout(
            () =>
              reject(
                new Error(
                  `Timed out waiting for automatic local rearm profiles notification (events=${JSON.stringify(autoEvents)})`,
                ),
              ),
            3_500,
          ),
        ),
      ]);
    } finally {
      clearInterval(nudgeTimer);
    }
    assert.ok(autoFirstProfileRead);
    const autoRecovered = await autoFirstProfileRead;
    assert.equal(autoRecovered.account.version, '1.5.26');
    assert.ok(autoEvents.includes('native-session'));
    assert.ok(autoEvents.includes('profiles'));
  } finally {
    healthyObs?.dispose();
    autoRearmObs?.dispose();
    if (prevPoolDir === undefined) delete process.env.FARMSLOT_POOL_DIR;
    else process.env.FARMSLOT_POOL_DIR = prevPoolDir;
    if (prevFarmHome === undefined) delete process.env.FARMSLOT_HOME;
    else process.env.FARMSLOT_HOME = prevFarmHome;
    if (prevOwner === undefined) delete process.env.FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID;
    else process.env.FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID = prevOwner;
    rmSync(root, { recursive: true, force: true });
  }
});

test('automatic local rearm recovers profiles after an early profile-status read failed during downtime', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'agy-local-early-read-rearm-'));
  const farmHome = join(root, 'farm-home');
  const fixturePoolPath = join(root, 'pool');
  const stateRoot = join(root, 'auto-rearm-state');
  const sessionsDir = join(stateRoot, 'sessions');
  mkdirSync(farmHome, { recursive: true });
  mkdirSync(fixturePoolPath, { recursive: true });
  mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
  chmodSync(stateRoot, 0o700);
  mkdirSync(sessionsDir, { recursive: true, mode: 0o700 });
  chmodSync(sessionsDir, 0o700);
  const metadataFile = join(sessionsDir, 'metadata.json');
  writeFileSync(metadataFile, JSON.stringify({ revision: 'early-rev-0' }), { mode: 0o600 });

  const prevPoolDir = process.env.FARMSLOT_POOL_DIR;
  const prevFarmHome = process.env.FARMSLOT_HOME;
  const prevOwner = process.env.FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID;
  let gatewayObs: GatewayNativeObservations | undefined;
  try {
    process.env.FARMSLOT_HOME = farmHome;
    process.env.FARMSLOT_POOL_DIR = fixturePoolPath;
    const auth = createGatewayAuthRuntime({ FARMSLOT_HOME: farmHome });
    const ownerRecord = auth.writer.createPrincipal(
      { type: 'person', displayName: 'Early Read Rearm Owner' },
      [{ role: 'admin' as const, scope: { kind: 'global' as const } }],
      'early-read-rearm-owner',
    );
    const ownerId = ownerRecord.id;
    process.env.FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID = ownerId;

    const fakeAgy = join(root, 'bin', 'agy');
    mkdirSync(dirname(fakeAgy), { recursive: true });
    writeFileSync(
      fakeAgy,
      `#!/bin/sh
for arg in "$@"; do
  if [ "$arg" = "--version" ]; then
    printf '1.5.27\\n'
    exit 0
  fi
done
while IFS= read -r line; do
  id=$(printf '%s\\n' "$line" | sed -n 's/.*"id":"\\([^"]*\\)".*/\\1/p')
  case "$line" in
    *'"initialize"'*)
      printf '{"jsonrpc":"2.0","id":"%s","result":{"protocolVersion":1,"agentInfo":{"name":"Antigravity ACP Server","version":"1.5.27"}}}\\n' "$id"
      ;;
    *'"session/list"'*)
      printf '{"jsonrpc":"2.0","id":"%s","result":{"sessions":[]}}\\n' "$id"
      exit 0
      ;;
  esac
done
`,
    );
    chmodSync(fakeAgy, 0o700);
    writeFileSync(
      join(fixturePoolPath, 'early-rearm-local.json'),
      JSON.stringify({
        machine: 'early-rearm-local',
        project: 'early-rearm',
        host: 'localhost',
        ssh_user: process.env.USER || 'operator',
        os: process.platform,
        platform: 'cli',
        antigravity_path: fakeAgy,
        slots: [
          { id: 'slot-early-rearm', enabled: true, mode: 'dispatch', repo: root, session: 's1' },
        ],
      }),
    );

    const profileDir = join(root, 'profile-early-rearm');
    mkdirSync(profileDir, { recursive: true });
    const localClient = new NativeSessionClient(stateRoot, 'local');
    await routeNativeProfile(localClient, ownerId, Methods.NATIVE_PROFILE_ADD, {
      profileId: 'early-work',
      runner: 'antigravity',
      directory: profileDir,
    });

    const deadPid = spawnSync(process.execPath, ['-e', '']).pid;
    assert.ok(deadPid);
    const brokenHostFile = join(stateRoot, 'host.json');
    writeFileSync(
      brokenHostFile,
      JSON.stringify({ pid: deadPid, socket: join(stateRoot, 'gone.sock') }),
      { mode: 0o600 },
    );

    const conn = {};
    const principal: Principal = {
      id: ownerId,
      subject: { type: 'person', displayName: 'Early Read Rearm Owner' },
      roles: [{ role: 'admin' as const, scope: { kind: 'global' as const } }],
    };
    const readLocalProfile = async (): Promise<NativeProfileStatusResult> => {
      const interests = nativeReadInterests(
        Methods.NATIVE_PROFILE_STATUS,
        { executionNodeId: 'local', profileId: 'early-work' },
        ownerId,
      );
      assert.ok(interests);
      const { payload } = await gatewayObs!.read(
        conn,
        interests,
        async () =>
          (await gatewayObs!.localProfileStatus(
            ownerId,
            'early-work',
          )) as NativeProfileStatusResult,
        () => null,
      );
      return payload;
    };

    let captureRecovery = false;
    let firstProfileRead: Promise<NativeProfileStatusResult> | undefined;
    let firstProfileDelivered = false;
    let firstProfileFired!: () => void;
    const firstProfileFiredP = new Promise<void>((resolve) => {
      firstProfileFired = resolve;
    });
    const events: string[] = [];
    gatewayObs = new GatewayNativeObservations((key) => {
      if ('nodeId' in key && key.nodeId === 'local') {
        events.push(key.family);
        if (captureRecovery && key.family === 'profiles' && !firstProfileRead) {
          firstProfileDelivered = true;
          firstProfileRead = readLocalProfile();
          firstProfileFired();
        }
      }
    }, localClient);
    gatewayObs.attachClient(conn, () => principal);

    await assert.rejects(gatewayObs.startLocal(ownerId), {
      code: 'NATIVE_SOURCE_UNAVAILABLE',
      reason: 'host-identity-invalid',
    });

    // Passively observe the background sync's failure warning (emitted strictly after
    // `syncLocalExecutables` clears `configuring` and stores `localConfig.error`), without
    // issuing any second profile-status read that would clear `localConfig.error` or start a
    // second retry racing `unlinkSync(brokenHostFile)`.
    let syncFailureSettled!: () => void;
    const syncFailureSettledP = new Promise<void>((resolve) => {
      syncFailureSettled = resolve;
    });
    let syncFailureCount = 0;
    const origWarn = console.warn;
    const warnMock = t.mock.method(console, 'warn', (...args: unknown[]) => {
      const text = args.map((part) => String(part)).join(' ');
      if (text.includes('[native-observation] background local executable sync failed:')) {
        syncFailureCount++;
        syncFailureSettled();
      }
      return origWarn.apply(console, args);
    });
    try {
      // Single early profile-status read during downtime starts ONE background executable sync
      // whose retry fails on the dead host and stores a transient non-pool `localConfig.error`.
      await assert.rejects(readLocalProfile(), { code: 'NATIVE_PROFILES_UNAVAILABLE' });
      await Promise.race([
        syncFailureSettledP,
        new Promise<never>((_resolve, reject) =>
          setTimeout(
            () =>
              reject(new Error('Timed out waiting for background local sync failure to settle')),
            2_000,
          ),
        ),
      ]);
      assert.equal(
        syncFailureCount,
        1,
        'expected exactly one read-triggered background retry to fail and store its error',
      );
    } finally {
      warnMock.mock.restore();
    }

    events.length = 0;
    captureRecovery = true;
    // Clear the transient host failure WITHOUT any pool edit or manual reread.
    unlinkSync(brokenHostFile);
    let nudgeCount = 0;
    const nudgeTimer = setInterval(() => {
      if (firstProfileDelivered) return;
      writeFileSync(metadataFile, JSON.stringify({ revision: `early-rev-${++nudgeCount}` }), {
        mode: 0o600,
      });
    }, 750);
    try {
      await Promise.race([
        firstProfileFiredP,
        new Promise<never>((_resolve, reject) =>
          setTimeout(
            () =>
              reject(
                new Error(
                  `Timed out waiting for automatic local rearm after early profile-status failure (events=${JSON.stringify(events)})`,
                ),
              ),
            3_500,
          ),
        ),
      ]);
    } finally {
      clearInterval(nudgeTimer);
    }
    assert.ok(firstProfileRead);
    const recovered = await firstProfileRead;
    assert.equal(recovered.account.version, '1.5.27');
    assert.ok(recovered.loginCommand.includes(fakeAgy));
    assert.ok(events.includes('profiles'));
  } finally {
    gatewayObs?.dispose();
    if (prevPoolDir === undefined) delete process.env.FARMSLOT_POOL_DIR;
    else process.env.FARMSLOT_POOL_DIR = prevPoolDir;
    if (prevFarmHome === undefined) delete process.env.FARMSLOT_HOME;
    else process.env.FARMSLOT_HOME = prevFarmHome;
    if (prevOwner === undefined) delete process.env.FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID;
    else process.env.FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID = prevOwner;
    rmSync(root, { recursive: true, force: true });
  }
});

interface RemoteEpochHarness {
  root: string;
  tempPoolRoot: string;
  ownerId: string;
  machineA: string;
  machineB: string;
  incA: string;
  incB: string;
  nextRevA: () => number;
  currentRevA: () => number;
  setConfigureHandlerA: (
    handler: (executables: Record<string, string>) => Promise<NativeSourceReceipt>,
  ) => void;
  transportA: Awaited<ReturnType<typeof createTypedNodeTransport>>;
  gatewayObs: GatewayNativeObservations;
  remoteInvalidations: Array<{ family: string; nodeId?: string }>;
  writePool: (fileName: string, machine: string, agyPath: string) => void;
  waitMicrotasks: () => Promise<void>;
  pollUntil: (predicate: () => boolean, label: string) => Promise<void>;
  readRemoteProfile: (
    nodeId: string,
    onEnter?: () => Promise<void>,
  ) => Promise<NativeProfileStatusResult>;
  dispose: () => Promise<void>;
}

async function setupRemoteEpochHarness(prefix: string): Promise<RemoteEpochHarness> {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const farmHome = join(root, 'farm-home');
  const tempPoolRoot = join(root, 'pool');
  const localStateRoot = join(root, 'local-state');
  const prevPoolDir = process.env.FARMSLOT_POOL_DIR;
  const prevFarmHome = process.env.FARMSLOT_HOME;
  const prevOwner = process.env.FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID;
  const machineA = `${prefix}node-a`;
  const machineB = `${prefix}node-b`;

  let gatewayObs: GatewayNativeObservations | undefined;
  let transportA: Awaited<ReturnType<typeof createTypedNodeTransport>> | undefined;
  let transportB: Awaited<ReturnType<typeof createTypedNodeTransport>> | undefined;
  let registeredA = false;
  let registeredB = false;
  let disposed = false;

  const dispose = async () => {
    if (disposed) return;
    disposed = true;
    gatewayObs?.dispose();
    if (registeredA && transportA) {
      unregisterByWs(transportA.ws);
      registeredA = false;
    }
    if (transportA) {
      await transportA.close();
      transportA = undefined;
    }
    if (registeredB && transportB) {
      unregisterByWs(transportB.ws);
      registeredB = false;
    }
    if (transportB) {
      await transportB.close();
      transportB = undefined;
    }
    if (prevPoolDir === undefined) delete process.env.FARMSLOT_POOL_DIR;
    else process.env.FARMSLOT_POOL_DIR = prevPoolDir;
    if (prevFarmHome === undefined) delete process.env.FARMSLOT_HOME;
    else process.env.FARMSLOT_HOME = prevFarmHome;
    if (prevOwner === undefined) delete process.env.FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID;
    else process.env.FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID = prevOwner;
    rmSync(root, { recursive: true, force: true });
  };

  try {
    mkdirSync(farmHome, { recursive: true });
    mkdirSync(tempPoolRoot, { recursive: true });
    mkdirSync(localStateRoot, { recursive: true, mode: 0o700 });
    chmodSync(localStateRoot, 0o700);

    process.env.FARMSLOT_POOL_DIR = tempPoolRoot;
    process.env.FARMSLOT_HOME = farmHome;
    const auth = createGatewayAuthRuntime({ FARMSLOT_HOME: farmHome });
    const ownerRecord = auth.writer.createPrincipal(
      { type: 'person', displayName: 'Remote Epoch Owner' },
      [{ role: 'admin' as const, scope: { kind: 'global' as const } }],
      `${prefix}owner`,
    );
    const ownerId = ownerRecord.id;
    process.env.FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID = ownerId;
    auth.writer.createPrincipal(
      {
        type: 'node',
        machine: machineA,
        displayName: 'Remote Epoch Node A',
        nativeOwnerPrincipalId: ownerId,
      },
      [],
      `${prefix}node-a-cred`,
    );
    auth.writer.createPrincipal(
      {
        type: 'node',
        machine: machineB,
        displayName: 'Remote Unaffected Node B',
        nativeOwnerPrincipalId: ownerId,
      },
      [],
      `${prefix}node-b-cred`,
    );
    const client = new NativeSessionClient(localStateRoot, 'local');
    const makeStatus = (version: string): NativeProfileStatusResult => ({
      profile: {
        id: 'work',
        runner: 'antigravity',
        directory: join(root, 'profile-work'),
        accountContextId: '22222222-2222-4222-8222-222222222222',
        state: 'active',
      },
      account: {
        runner: 'antigravity',
        installed: true,
        executable: `/opt/agy-${version}`,
        version,
        login: 'authenticated',
        mode: 'subscription',
        identityQuality: 'unavailable',
        observedAt: '2026-11-28T00:00:00.000Z',
      },
      loginCommand: `/opt/agy-${version}`,
    });

    const writePool = (fileName: string, machine: string, agyPath: string) => {
      writeFileSync(
        join(tempPoolRoot, fileName),
        JSON.stringify({
          machine,
          project: fileName,
          host: `${machine}.remote.example`,
          ssh_user: 'operator',
          os: process.platform,
          platform: 'cli',
          antigravity_path: agyPath,
          slots: [
            { id: `${machine}-1`, enabled: true, mode: 'dispatch', repo: root, session: 's1' },
          ],
        }),
      );
    };
    writePool(`${machineA}-aux-1.json`, machineA, '/opt/agy-aux-1');
    writePool(`${machineA}-aux-2.json`, machineA, '/opt/agy-aux-2');
    writePool(`${machineA}.json`, machineA, '/opt/agy-v1');
    writePool(`${machineB}.json`, machineB, '/opt/agy-b');

    let revA = 0;
    const incA = `inc-${prefix}a`;
    let configureHandlerA: (
      executables: Record<string, string>,
    ) => Promise<NativeSourceReceipt> = async () => ({
      version: 1,
      nodeId: machineA,
      ownerId,
      incarnation: incA,
      revision: ++revA,
      ready: true,
      changed: ['profiles'],
    });

    transportA = await createTypedNodeTransport(async (frame) => {
      assert.equal(frame.method, 'native.observation.configure');
      const params = (frame.params ?? {}) as { executables?: Record<string, string> };
      return configureHandlerA(params.executables ?? {});
    });
    let revB = 0;
    const incB = `inc-${prefix}b`;
    transportB = await createTypedNodeTransport(async (frame) => {
      assert.equal(frame.method, 'native.observation.configure');
      return {
        version: 1,
        nodeId: machineB,
        ownerId,
        incarnation: incB,
        revision: ++revB,
        ready: true,
        changed: ['profiles'],
      };
    });

    registerNode(
      machineA,
      1,
      transportA.ws,
      undefined,
      undefined,
      {
        ownerPrincipalId: ownerId,
        supportsStandaloneDelegation: true,
        supportsProfiles: true,
        supportsObservations: true,
        supportsObservationConfiguration: true,
      },
      { principalId: `${prefix}node-a`, valid: () => true },
    );
    registeredA = true;
    registerNode(
      machineB,
      1,
      transportB.ws,
      undefined,
      undefined,
      {
        ownerPrincipalId: ownerId,
        supportsStandaloneDelegation: true,
        supportsProfiles: true,
        supportsObservations: true,
        supportsObservationConfiguration: true,
      },
      { principalId: `${prefix}node-b`, valid: () => true },
    );
    registeredB = true;

    const remoteInvalidations: Array<{ family: string; nodeId?: string }> = [];
    gatewayObs = new GatewayNativeObservations((key) => {
      remoteInvalidations.push({
        family: key.family,
        ...('nodeId' in key ? { nodeId: key.nodeId } : {}),
      });
    }, client);

    const clientConn = {};
    const principal: Principal = {
      id: ownerId,
      subject: { type: 'person', displayName: 'Epoch Owner' },
      roles: [{ role: 'admin' as const, scope: { kind: 'global' as const } }],
    };
    gatewayObs.attachClient(clientConn, () => principal);
    gatewayObs.acceptRemote(
      transportA.ws,
      {
        version: 1,
        nodeId: machineA,
        ownerId,
        incarnation: incA,
        revision: 0,
        ready: true,
        changed: ['native-session', 'profiles'],
      },
      () => true,
    );
    gatewayObs.acceptRemote(
      transportB.ws,
      {
        version: 1,
        nodeId: machineB,
        ownerId,
        incarnation: incB,
        revision: 0,
        ready: true,
        changed: ['native-session', 'profiles'],
      },
      () => true,
    );

    const waitMicrotasks = async () => {
      for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r));
    };
    const pollUntil = async (predicate: () => boolean, label: string) => {
      const deadline = Date.now() + 2_000;
      while (Date.now() < deadline) {
        if (predicate()) return;
        await new Promise((r) => setTimeout(r, 10));
      }
      throw new Error(`Timed out waiting for ${label}`);
    };
    const obsRef = gatewayObs;
    const readRemoteProfile = async (
      nodeId: string,
      onEnter?: () => Promise<void>,
    ): Promise<NativeProfileStatusResult> => {
      const params = { executionNodeId: nodeId, profileId: 'work' };
      const interests = nativeReadInterests(Methods.NATIVE_PROFILE_STATUS, params, ownerId);
      assert.ok(interests);
      const { payload } = await obsRef.read(
        clientConn,
        interests,
        async () => {
          if (onEnter) await onEnter();
          return makeStatus('1.5.19');
        },
        () => null,
      );
      return payload;
    };

    await pollUntil(() => revA >= 1 && revB >= 1, 'initial remote configure');
    await waitMicrotasks();
    assert.equal((await readRemoteProfile(machineA)).account.version, '1.5.19');
    assert.equal((await readRemoteProfile(machineB)).account.version, '1.5.19');

    return {
      root,
      tempPoolRoot,
      ownerId,
      machineA,
      machineB,
      incA,
      incB,
      nextRevA: () => ++revA,
      currentRevA: () => revA,
      setConfigureHandlerA: (handler) => {
        configureHandlerA = handler;
      },
      transportA,
      gatewayObs: obsRef,
      remoteInvalidations,
      writePool,
      waitMicrotasks,
      pollUntil,
      readRemoteProfile,
      dispose,
    };
  } catch (error) {
    await dispose();
    throw error;
  }
}

test('remote observation configuration epoch fences stale resolved and rejected configure replies while preserving unaffected nodes', async () => {
  const h = await setupRemoteEpochHarness('agy-epoch-stale-');
  try {
    // 2a) Straddling remote reads across ambiguity on machineA: machineA rejects, machineB succeeds.
    let enteredA!: () => void;
    let enteredB!: () => void;
    const enteredAP = new Promise<void>((r) => {
      enteredA = r;
    });
    const enteredBP = new Promise<void>((r) => {
      enteredB = r;
    });
    let releaseReads!: () => void;
    const readsGate = new Promise<void>((r) => {
      releaseReads = r;
    });
    const readAP = h.readRemoteProfile(h.machineA, async () => {
      enteredA();
      await readsGate;
    });
    const readBP = h.readRemoteProfile(h.machineB, async () => {
      enteredB();
      await readsGate;
    });
    await Promise.all([enteredAP, enteredBP]);
    unlinkSync(join(h.tempPoolRoot, `${h.machineA}.json`));
    h.gatewayObs.catalogChanged({ scope: 'all', reason: 'pool' });
    releaseReads();
    await assert.rejects(readAP, (error: unknown) => {
      const err = error as { code?: string; message?: string };
      assert.equal(err.code, 'NATIVE_PROFILES_UNAVAILABLE');
      assert.match(err.message ?? '', /ambiguous pool settings/);
      return true;
    });
    assert.equal((await readBP).account.version, '1.5.19');

    // 2b) Remote held RESOLVED configure RPC -> pool becomes ambiguous -> resolve stale configure.
    let resolveStaleConfig!: (receipt: NativeSourceReceipt) => void;
    let staleConfigStarted!: () => void;
    const staleConfigStartedP = new Promise<void>((r) => {
      staleConfigStarted = r;
    });
    h.setConfigureHandlerA(
      () =>
        new Promise<NativeSourceReceipt>((resolve) => {
          resolveStaleConfig = resolve;
          staleConfigStarted();
        }),
    );
    h.writePool(`${h.machineA}.json`, h.machineA, '/opt/agy-v2');
    h.gatewayObs.catalogChanged({ scope: 'all', reason: 'pool' });
    await staleConfigStartedP;

    unlinkSync(join(h.tempPoolRoot, `${h.machineA}.json`));
    h.gatewayObs.catalogChanged({ scope: 'all', reason: 'pool' });
    const invAfterRemoteAmbig = h.remoteInvalidations.length;
    const stalePushRev = h.nextRevA();
    h.gatewayObs.acceptRemote(
      h.transportA.ws,
      {
        version: 1,
        nodeId: h.machineA,
        ownerId: h.ownerId,
        incarnation: h.incA,
        revision: stalePushRev,
        ready: true,
        changed: ['profiles'],
      },
      () => true,
    );
    assert.equal(
      h.remoteInvalidations
        .slice(invAfterRemoteAmbig)
        .filter((k) => k.family === 'profiles' && k.nodeId === h.machineA).length,
      0,
      'stale remote profile push arriving before reply after ambiguity must be suppressed',
    );
    resolveStaleConfig({
      version: 1,
      nodeId: h.machineA,
      ownerId: h.ownerId,
      incarnation: h.incA,
      revision: stalePushRev,
      ready: true,
      changed: ['profiles'],
    });
    await h.waitMicrotasks();
    assert.equal(
      h.remoteInvalidations
        .slice(invAfterRemoteAmbig)
        .filter((k) => k.family === 'profiles' && k.nodeId === h.machineA).length,
      0,
      'stale resolved remote configure reply after ambiguity must not emit a profiles invalidation',
    );
    await assert.rejects(h.readRemoteProfile(h.machineA), (error: unknown) => {
      const err = error as { code?: string; message?: string };
      assert.equal(err.code, 'NATIVE_PROFILES_UNAVAILABLE');
      assert.match(err.message ?? '', /ambiguous pool settings/);
      return true;
    });

    // 2c) Remote held REJECTED configure RPC -> newer valid edit succeeds -> stale rejection ignored.
    let rejectStaleConfig!: (err: Error) => void;
    let rejectConfigStarted!: () => void;
    const rejectConfigStartedP = new Promise<void>((r) => {
      rejectConfigStarted = r;
    });
    let configureCalls = 0;
    h.setConfigureHandlerA(async () => {
      configureCalls++;
      if (configureCalls === 1) {
        return new Promise<NativeSourceReceipt>((_resolve, reject) => {
          rejectStaleConfig = reject;
          rejectConfigStarted();
        });
      }
      return {
        version: 1,
        nodeId: h.machineA,
        ownerId: h.ownerId,
        incarnation: h.incA,
        revision: h.nextRevA(),
        ready: true,
        changed: ['profiles'],
      };
    });
    h.writePool(`${h.machineA}.json`, h.machineA, '/opt/agy-v3-stale');
    h.gatewayObs.catalogChanged({ scope: 'all', reason: 'pool' });
    await rejectConfigStartedP;

    const invBeforeV4 = h.remoteInvalidations.length;
    h.writePool(`${h.machineA}.json`, h.machineA, '/opt/agy-v4-good');
    h.gatewayObs.catalogChanged({ scope: 'all', reason: 'pool' });
    await h.pollUntil(
      () =>
        h.remoteInvalidations
          .slice(invBeforeV4)
          .some((k) => k.family === 'profiles' && k.nodeId === h.machineA),
      'remote v4 recovery publication',
    );
    assert.equal((await h.readRemoteProfile(h.machineA)).account.version, '1.5.19');

    rejectStaleConfig(new Error('stale remote configure timeout'));
    await h.waitMicrotasks();
    assert.equal(
      (await h.readRemoteProfile(h.machineA)).account.version,
      '1.5.19',
      'stale rejected remote configure must not clobber newer valid remote state',
    );
  } finally {
    await h.dispose();
  }
});

test('remote observation rejects read crossing B -> ambiguous -> B with unchanged receipt revision while unaffected node succeeds', async () => {
  const h = await setupRemoteEpochHarness('agy-epoch-samedig-');
  try {
    let sameRevEnteredA!: () => void;
    let sameRevEnteredB!: () => void;
    const sameRevEnteredAP = new Promise<void>((r) => {
      sameRevEnteredA = r;
    });
    const sameRevEnteredBP = new Promise<void>((r) => {
      sameRevEnteredB = r;
    });
    let releaseSameRevReads!: () => void;
    const sameRevReadsGate = new Promise<void>((r) => {
      releaseSameRevReads = r;
    });
    const sameRevReadAP = h.readRemoteProfile(h.machineA, async () => {
      sameRevEnteredA();
      await sameRevReadsGate;
    });
    const sameRevReadBP = h.readRemoteProfile(h.machineB, async () => {
      sameRevEnteredB();
      await sameRevReadsGate;
    });
    await Promise.all([sameRevEnteredAP, sameRevEnteredBP]);

    // Step through ambiguity and back to the exact same executable `/opt/agy-v1` while returning
    // the UNCHANGED receipt revision `currentRevA()`.
    unlinkSync(join(h.tempPoolRoot, `${h.machineA}.json`));
    h.gatewayObs.catalogChanged({ scope: 'all', reason: 'pool' });
    const unchangedRev = h.currentRevA();
    h.setConfigureHandlerA(async () => ({
      version: 1,
      nodeId: h.machineA,
      ownerId: h.ownerId,
      incarnation: h.incA,
      revision: unchangedRev,
      ready: true,
      changed: ['profiles'],
    }));
    const invBeforeSameDigestRecover = h.remoteInvalidations.length;
    h.writePool(`${h.machineA}.json`, h.machineA, '/opt/agy-v1');
    h.gatewayObs.catalogChanged({ scope: 'all', reason: 'pool' });
    await h.pollUntil(
      () =>
        h.remoteInvalidations
          .slice(invBeforeSameDigestRecover)
          .some((k) => k.family === 'profiles' && k.nodeId === h.machineA),
      'same-digest recovery with unchanged receipt revision',
    );
    releaseSameRevReads();
    await assert.rejects(sameRevReadAP, (error: unknown) => {
      const err = error as { code?: string; reason?: string };
      assert.equal(err.code, 'NATIVE_SOURCE_UNAVAILABLE');
      assert.equal(err.reason, 'executable-config-changed');
      return true;
    });
    assert.equal(
      (await sameRevReadBP).account.version,
      '1.5.19',
      'unaffected remote node read must succeed across machineA B -> ambiguous -> B',
    );
  } finally {
    await h.dispose();
  }
});

test('same-epoch remote configure failure after held push publishes once, avoids retry loop, and retries on ready re-arm', async () => {
  const h = await setupRemoteEpochHarness('agy-epoch-heldfail-');
  try {
    let rejectSameEpoch!: (err: Error) => void;
    let sameEpochStarted!: () => void;
    const sameEpochStartedP = new Promise<void>((r) => {
      sameEpochStarted = r;
    });
    let sameEpochAttempts = 0;
    h.setConfigureHandlerA(async () => {
      sameEpochAttempts++;
      if (sameEpochAttempts === 1) {
        return new Promise<NativeSourceReceipt>((_resolve, reject) => {
          rejectSameEpoch = reject;
          sameEpochStarted();
        });
      }
      return {
        version: 1,
        nodeId: h.machineA,
        ownerId: h.ownerId,
        incarnation: h.incA,
        revision: h.nextRevA(),
        ready: true,
        changed: ['profiles'],
      };
    });
    h.writePool(`${h.machineA}.json`, h.machineA, '/opt/agy-v5-fail');
    h.gatewayObs.catalogChanged({ scope: 'all', reason: 'pool' });
    await sameEpochStartedP;

    const invBeforeHeldPush = h.remoteInvalidations.length;
    h.gatewayObs.acceptRemote(
      h.transportA.ws,
      {
        version: 1,
        nodeId: h.machineA,
        ownerId: h.ownerId,
        incarnation: h.incA,
        revision: h.nextRevA(),
        ready: true,
        changed: ['profiles'],
      },
      () => true,
    );
    assert.equal(
      h.remoteInvalidations
        .slice(invBeforeHeldPush)
        .filter((k) => k.family === 'profiles' && k.nodeId === h.machineA).length,
      0,
      'node profile push during active configure must be held until configure settles',
    );

    rejectSameEpoch(new Error('same-epoch configure timeout'));
    await h.waitMicrotasks();
    assert.equal(
      h.remoteInvalidations
        .slice(invBeforeHeldPush)
        .filter((k) => k.family === 'profiles' && k.nodeId === h.machineA).length,
      1,
      'same-epoch configure failure after held push must publish profiles invalidation once',
    );
    // An ordinary same-incarnation session push must NOT loop configure retries on a persistent error.
    h.gatewayObs.acceptRemote(
      h.transportA.ws,
      {
        version: 1,
        nodeId: h.machineA,
        ownerId: h.ownerId,
        incarnation: h.incA,
        revision: h.nextRevA(),
        ready: true,
        changed: ['native-session'],
      },
      () => true,
    );
    await h.waitMicrotasks();
    assert.equal(
      sameEpochAttempts,
      1,
      'ordinary same-incarnation session push must not trigger a retry loop after failure',
    );
    // A legitimate re-arm (`ready: false -> ready: true`) retries and recovers automatically.
    const invBeforeRearmRetry = h.remoteInvalidations.length;
    h.gatewayObs.acceptRemote(
      h.transportA.ws,
      {
        version: 1,
        nodeId: h.machineA,
        ownerId: h.ownerId,
        incarnation: h.incA,
        revision: h.nextRevA(),
        ready: false,
        error: 'SOURCE_UNAVAILABLE',
        changed: ['native-session', 'profiles'],
      },
      () => true,
    );
    h.gatewayObs.acceptRemote(
      h.transportA.ws,
      {
        version: 1,
        nodeId: h.machineA,
        ownerId: h.ownerId,
        incarnation: h.incA,
        revision: h.nextRevA(),
        ready: true,
        changed: ['native-session', 'profiles'],
      },
      () => true,
    );
    await h.pollUntil(
      () =>
        sameEpochAttempts === 2 &&
        h.remoteInvalidations
          .slice(invBeforeRearmRetry)
          .some((k) => k.family === 'profiles' && k.nodeId === h.machineA),
      'automatic retry on ready recovery',
    );
    assert.equal((await h.readRemoteProfile(h.machineA)).account.version, '1.5.19');
  } finally {
    await h.dispose();
  }
});

test('pool watcher coalesces Chokidar 4.0.3 unlink spacing (raw rename at 0 ms, all unlink at 100 ms), preserves raw-only fallback, and handles a later edit', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const directory = '/tmp/pool-watcher-spacing-test';
  const file = join(directory, 'local.json');
  let otherWatcherDeliveries = 0;
  let nativePoolNotices = 0;

  assert.ok(
    NATIVE_POOL_CHANGE_COALESCE_MS >= 200,
    `expected NATIVE_POOL_CHANGE_COALESCE_MS >= 200 to cover Chokidar 100 ms unlink window, got ${NATIVE_POOL_CHANGE_COALESCE_MS}`,
  );

  const handlers = createPoolWatcherHandlers({
    directory,
    onPoolFileChanged: () => {
      otherWatcherDeliveries++;
    },
    onNativePoolChanged: () => {
      nativePoolNotices++;
    },
  });
  try {
    // 1) Real Chokidar 4.0.3 unlink spacing: raw rename at 0 ms, all unlink at 100 ms.
    handlers.onRaw('rename', 'local.json', { watchedPath: directory });
    assert.equal(otherWatcherDeliveries, 1);
    assert.equal(nativePoolNotices, 0);

    t.mock.timers.tick(100);
    assert.equal(nativePoolNotices, 0, 'must not flush before Chokidar 100 ms unlink arrives');

    handlers.onAll('unlink', file);
    assert.equal(otherWatcherDeliveries, 2, 'other watchers still receive both deliveries');
    assert.equal(nativePoolNotices, 0);

    t.mock.timers.tick(NATIVE_POOL_CHANGE_COALESCE_MS - 1);
    assert.equal(nativePoolNotices, 0);

    t.mock.timers.tick(1);
    assert.equal(
      nativePoolNotices,
      1,
      '0 ms raw rename + 100 ms all unlink must produce exactly ONE native snapshot notice',
    );

    // 2) macOS raw-only fallback (no matching `all` event).
    handlers.onRaw('change', 'local.json', { watchedPath: directory });
    assert.equal(otherWatcherDeliveries, 3);
    t.mock.timers.tick(NATIVE_POOL_CHANGE_COALESCE_MS);
    assert.equal(nativePoolNotices, 2, 'raw-only delivery must still trigger one native notice');

    // 3) A later distinct edit after the coalesce window flushes triggers one more native notice.
    handlers.onRaw('change', 'local.json', { watchedPath: directory });
    t.mock.timers.tick(100);
    handlers.onAll('change', file);
    assert.equal(otherWatcherDeliveries, 5);
    t.mock.timers.tick(NATIVE_POOL_CHANGE_COALESCE_MS);
    assert.equal(
      nativePoolNotices,
      3,
      'distinct edit after flush must trigger exactly one additional native notice',
    );
  } finally {
    handlers.dispose();
  }
});

test('named-profile ambient catalog skip is limited to strictAccountCatalog runners so other runners keep placement admission', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agy-profile-gate-'));
  const prevPoolDir = process.env.FARMSLOT_POOL_DIR;
  const machineA = 'agy-profile-gate-a';
  const machineB = 'agy-profile-gate-b';
  const owner = 'profile-gate-owner';
  const profileAccountContextId = '11111111-2222-4333-8444-555555555555';
  const expectedSession = {
    id: 'forwarded-session',
    executionNodeId: machineA,
    ownerPrincipalId: owner,
    profileId: 'work',
    accountContextId: profileAccountContextId,
  };
  let forwardedRequests = 0;
  const transport = await createTypedNodeTransport(async (frame) => {
    forwardedRequests++;
    assert.equal(frame.method, 'native.session');
    const envelope = (frame.params ?? {}) as {
      method?: string;
      params?: Record<string, unknown>;
    };
    assert.equal(envelope.method, Methods.NATIVE_SESSION_CREATE);
    assert.equal(envelope.params?.runner, 'antigravity');
    assert.equal(envelope.params?.model, 'gemini-work-profile-only');
    assert.equal(envelope.params?.profileId, 'work');
    assert.equal(envelope.params?.accountContextId, profileAccountContextId);
    return { session: expectedSession };
  });
  registerNode(
    machineA,
    1,
    transport.ws,
    undefined,
    undefined,
    { ownerPrincipalId: owner, supportsProfiles: true },
    { principalId: 'node-gate', valid: () => true },
  );
  try {
    const tempPoolRoot = join(root, 'pool');
    mkdirSync(tempPoolRoot, { recursive: true });
    writeFileSync(
      join(tempPoolRoot, `${machineA}.json`),
      JSON.stringify({
        machine: machineA,
        project: 'demo',
        host: 'remote-gate-a.example',
        ssh_user: 'operator',
        os: process.platform,
        platform: 'cli',
        slots: [
          { id: `${machineA}-1`, enabled: true, mode: 'dispatch', repo: root, session: 's1' },
        ],
      }),
    );
    process.env.FARMSLOT_POOL_DIR = tempPoolRoot;

    // pi is not a strictAccountCatalog runner; when machineA lacks a model available on machineB,
    // routeNativeExecution must still reject it at placement time even with profileId set.
    nodeModelCatalogs.accept('pi', machineA, {
      ids: ['openai/gpt-5'],
      nativeIds: ['openai/gpt-5'],
      configuredProviders: ['openai'],
      flatCatalog: false,
      strictAccountCatalog: false,
    });
    nodeModelCatalogs.accept('pi', machineB, {
      ids: ['openai/gpt-5', 'anthropic/claude-only-on-b'],
      nativeIds: ['openai/gpt-5', 'anthropic/claude-only-on-b'],
      configuredProviders: ['openai', 'anthropic'],
      flatCatalog: false,
      strictAccountCatalog: false,
    });
    await assert.rejects(
      routeNativeExecution(owner, Methods.NATIVE_SESSION_CREATE, {
        executionNodeId: machineA,
        runner: 'pi',
        model: 'anthropic/claude-only-on-b',
        cwd: '/tmp',
        profileId: 'work',
        accountContextId: profileAccountContextId,
      }),
      /not listed on agy-profile-gate-a/,
    );
    assert.equal(forwardedRequests, 0);

    // Antigravity is a strictAccountCatalog runner: with profileId set, the ambient machine catalog
    // does not pre-block a profile-specific model; the request forwards to the owned launch boundary.
    nodeModelCatalogs.accept(
      'antigravity',
      machineA,
      parseAntigravityModelCatalog('gemini-4-neon-high\tGemini 4 Neon (High)\n'),
    );
    const result = await routeNativeExecution(owner, Methods.NATIVE_SESSION_CREATE, {
      executionNodeId: machineA,
      runner: 'antigravity',
      model: 'gemini-work-profile-only',
      cwd: '/tmp',
      profileId: 'work',
      accountContextId: profileAccountContextId,
    });
    assert.deepEqual(result, { session: expectedSession });
    assert.equal(forwardedRequests, 1);
  } finally {
    unregisterByWs(transport.ws);
    await transport.close();
    nodeModelCatalogs.unavailable('pi', machineA);
    nodeModelCatalogs.unavailable('pi', machineB);
    nodeModelCatalogs.unavailable('antigravity', machineA);
    if (prevPoolDir === undefined) delete process.env.FARMSLOT_POOL_DIR;
    else process.env.FARMSLOT_POOL_DIR = prevPoolDir;
    rmSync(root, { recursive: true, force: true });
  }
});
