import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

/** Real loopback WebSocket transport so gateway node-RPC tests inspect actual wire frames without casts. */
async function createTypedNodeTransport(
  onRequest: (frame: RequestFrame) => Promise<unknown>,
): Promise<TypedNodeTransport> {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>((resolve) => wss.once('listening', resolve));
  const address = wss.address();
  assert(address && typeof address !== 'string');
  const serverSocketReady = new Promise<WebSocket>((resolve) => {
    wss.once('connection', (socket) => resolve(socket));
  });
  const clientSocket = new WebSocket(`ws://127.0.0.1:${address.port}`);
  await new Promise<void>((resolve, reject) => {
    clientSocket.once('open', () => resolve());
    clientSocket.once('error', reject);
  });
  const serverSocket = await serverSocketReady;
  clientSocket.on('message', (raw) => {
    const frame = JSON.parse(String(raw)) as RequestFrame;
    void onRequest(frame).then(
      (payload) => handleNodeResponse(frame.id, true, payload, undefined, undefined, serverSocket),
      (err: unknown) => {
        const error = err as Error & { code?: string };
        handleNodeResponse(
          frame.id,
          false,
          undefined,
          error instanceof Error ? error.message : String(err),
          error?.code,
          serverSocket,
        );
      },
    );
  });
  return {
    ws: serverSocket,
    async close() {
      clientSocket.close();
      serverSocket.close();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    },
  };
}

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

    await observations.startLocal(ownerRecord.id);
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
