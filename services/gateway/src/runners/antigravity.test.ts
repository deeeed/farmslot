import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

import { WebSocket, WebSocketServer } from 'ws';

import { NativeSessionClient } from '@farmslot/agent-runtime/native';
import { observeAntigravityAccount } from '@farmslot/agent-runtime/native/antigravity';
import {
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
    if (transportMode === 'rpc-error') throw new Error('node connection reset');
    const extraEnv =
      p.env && typeof p.env === 'object' && !Array.isArray(p.env)
        ? (p.env as Record<string, string>)
        : {};
    return observeAntigravityAccount({
      cwd: typeof p.cwd === 'string' ? p.cwd : root,
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
      remoteRepo: root,
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

test('gateway observation owner syncs remote executables before fence so first and concurrent profile reads succeed with one current sample', async () => {
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
  const writePool = (agyPath: string) => {
    writeFileSync(
      join(tempPoolRoot, `${machine}.json`),
      JSON.stringify({
        machine,
        project: 'demo',
        host: 'remote-fenced-agy.example',
        ssh_user: 'operator',
        os: process.platform,
        platform: 'cli',
        antigravity_path: agyPath,
        slots: [{ id: `${machine}-1`, enabled: true, mode: 'dispatch', repo: root, session: 's1' }],
      }),
    );
  };
  writePool(fakeAgyV1);

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
  const principal: Principal = {
    id: ownerRecord.id,
    subject: { type: 'person', displayName: 'Fenced Owner' },
    roles,
  };

  const nodeClient = new NativeSessionClient(nodeStateRoot, machine);
  await routeNativeProfile(nodeClient, ownerRecord.id, Methods.NATIVE_PROFILE_ADD, {
    profileId: 'work',
    runner: 'antigravity',
    directory: profileDir,
  });

  const observations = new GatewayNativeObservations(() => {});
  let nodeExecutables: Record<string, string> = {};
  let configureCalls = 0;
  let lastReceipt: NativeSourceReceipt | undefined;
  const nodeObs = new NativeHostObservation(
    nodeClient,
    ownerRecord.id,
    (receipt) => {
      lastReceipt = receipt;
      if (registeredWs) observations.acceptRemote(registeredWs, receipt, () => true);
    },
    undefined,
    undefined,
    (runner) => nodeExecutables[runner],
  );

  let registeredWs: WebSocket | undefined;
  const transport = await createTypedNodeTransport(async (frame) => {
    const p = (frame.params ?? {}) as Record<string, unknown>;
    if (frame.method === 'native.observation.configure') {
      configureCalls++;
      const incoming =
        p.executables && typeof p.executables === 'object' && !Array.isArray(p.executables)
          ? (p.executables as Record<string, string>)
          : {};
      nodeExecutables = { ...incoming };
      const digest = JSON.stringify(
        Object.keys(nodeExecutables)
          .sort()
          .map((k) => [k, nodeExecutables[k]]),
      );
      return nodeObs.setExecutableConfig(digest);
    }
    if (frame.method === 'native.session') {
      assert.equal(p.observe, true);
      assert.equal(p.method, Methods.NATIVE_PROFILE_STATUS);
      const profileId = (p.params as { profileId: string }).profileId;
      return nodeObs.read(() => nodeObs.profileStatus(profileId));
    }
    throw new Error(`Unexpected node method: ${frame.method}`);
  });
  registeredWs = transport.ws;

  const clientConn = {};
  registerNode(
    machine,
    1,
    transport.ws,
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
  observations.attachClient(clientConn, () => principal);
  try {
    await nodeObs.start();
    assert.ok(lastReceipt?.ready);

    const readThroughGateway = async (): Promise<NativeProfileStatusResult> => {
      const params = { executionNodeId: machine, profileId: 'work' };
      const interests = nativeReadInterests(Methods.NATIVE_PROFILE_STATUS, params, ownerRecord.id);
      assert.ok(interests);
      const { payload } = await observations.read(
        clientConn,
        interests,
        async () => {
          const registeredNode = getNode(machine);
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
            transport.ws,
            machine,
            envelope,
          );
        },
        () => null,
      );
      return payload;
    };

    // First marked read succeeds through the gateway before/after fence with the configured binary.
    const first = await readThroughGateway();
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

    // Second read with unchanged pool config does zero extra configures and zero extra probes.
    const second = await readThroughGateway();
    assert.equal(second.account.version, '1.5.12');
    assert.equal(configureCalls, 1);
    assert.equal(
      readFileSync(probeLog, 'utf8').trim().split('\n').filter(Boolean).length,
      probesAfterFirst,
    );

    // Update pool config to v2 and fire concurrent reads through the gateway fence:
    // both coalesce on one refresh, both pass the fence, and both see the new v2 sample.
    writePool(fakeAgyV2);
    observations.catalogChanged({ scope: 'all', reason: 'catalog' });
    const [concurrentA, concurrentB] = await Promise.all([
      readThroughGateway(),
      readThroughGateway(),
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
  } finally {
    nodeObs.stop();
    observations.detachClient(clientConn);
    observations.dispose();
    unregisterByWs(transport.ws);
    await transport.close();
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
