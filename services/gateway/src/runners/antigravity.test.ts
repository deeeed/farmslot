import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { WebSocket } from 'ws';

import { DEFAULT_CLAUDE_MODEL, Methods, normalizeRunner } from '@farmslot/protocol';

import { withSlotCommandExecutor } from '../core/exec-scope.js';
import { computeCandidateStrategyFingerprint } from '../evals/package-store.js';
import { registerNode, unregisterByWs } from '../fleet/machine-registry.js';
import { handleNodeResponse } from '../fleet/node-rpc.js';
import { resolvePreviewExecution, resolvePreviewModel } from '../methods/dispatch/preview.js';
import { axesForTrialTransport } from '../methods/eval/candidate-setup.js';
import { resolveRunDispatchRunnerModel } from '../run-engine/dispatch-policy.js';

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

test('remote Antigravity status uses structured ACP probe and preserves last observed login on generic failures', async () => {
  // Use a real non-local host so isLocal(host, machine) is false and the remote execOnSlot branch runs.
  const remoteVars = makeVars({
    machine: 'remote-agy-host',
    host: 'remote-agy.example',
    sshUser: 'operator',
    sshTarget: 'operator@remote-agy.example',
    antigravityPath: '/opt/agy/bin/agy',
  });

  const authenticated = await withSlotCommandExecutor(
    async (_vars, command) => {
      assert.ok(command.includes('/opt/agy/bin/agy'));
      return {
        stdout: '{"status":"authenticated","version":"1.5.12"}\n',
        stderr: '',
        exitCode: 0,
      };
    },
    () => getHostRunnerSubscriptions(remoteVars, { runners: ['antigravity', 'unknown-peer'] }),
  );
  const agyAuth = authenticated.find((s) => s.runner === 'antigravity');
  assert.equal(agyAuth?.source, 'antigravity-auth');
  assert.equal(agyAuth?.loginMethod, 'agy 1.5.12');
  assert.deepEqual(agyAuth?.outcome, { identity: 'observed', quota: 'absent' });
  assert.equal(authenticated.find((s) => s.runner === 'unknown-peer')?.source, 'unsupported');

  const signedOut = await withSlotCommandExecutor(
    async () => ({
      stdout: '{"status":"signed-out","version":"1.5.12"}\n',
      stderr: '',
      exitCode: 0,
    }),
    () => getHostRunnerSubscriptions(remoteVars, { runners: ['antigravity'] }),
  );
  assert.equal(signedOut[0]?.source, 'error');
  assert.equal(signedOut[0]?.error, 'not-logged-in');
  assert.deepEqual(signedOut[0]?.outcome, { identity: 'absent', quota: 'absent' });

  // Generic exit-1 or transient probe failure must never be misclassified as not-logged-in.
  const exitOne = await withSlotCommandExecutor(
    async () => ({
      stdout: '',
      stderr: 'temporary network error',
      exitCode: 1,
    }),
    () => getHostRunnerSubscriptions(remoteVars, { runners: ['antigravity'] }),
  );
  assert.equal(exitOne[0]?.source, 'error');
  assert.notEqual(exitOne[0]?.error, 'not-logged-in');
  assert.deepEqual(exitOne[0]?.outcome, { identity: 'failed', quota: 'absent' });

  // Thrown SSH/transport error is isolated and yields identity: 'failed' while peer runners remain available.
  const transportFailed = await withSlotCommandExecutor(
    async () => {
      throw new Error('ssh connect timed out');
    },
    () => getHostRunnerSubscriptions(remoteVars, { runners: ['antigravity', 'unknown-peer'] }),
  );
  const agyFailed = transportFailed.find((s) => s.runner === 'antigravity');
  assert.equal(agyFailed?.source, 'error');
  assert.match(agyFailed?.error ?? '', /ssh connect timed out/);
  assert.deepEqual(agyFailed?.outcome, { identity: 'failed', quota: 'absent' });
  assert.equal(transportFailed.find((s) => s.runner === 'unknown-peer')?.source, 'unsupported');

  const notInstalled = await withSlotCommandExecutor(
    async () => ({
      stdout: '{"status":"not-installed"}\n',
      stderr: '',
      exitCode: 0,
    }),
    () => getHostRunnerSubscriptions(remoteVars, { runners: ['antigravity'] }),
  );
  assert.equal(notInstalled[0]?.source, 'error');
  assert.equal(notInstalled[0]?.error, 'agy not found');
  assert.deepEqual(notInstalled[0]?.outcome, { identity: 'absent', quota: 'absent' });
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
  const ws = {
    readyState: WebSocket.OPEN,
    send(raw: string) {
      forwardedRequests++;
      const frame = JSON.parse(raw) as { id: string };
      handleNodeResponse(frame.id, true, { session: expectedSession }, undefined, undefined, ws);
    },
  } as unknown as WebSocket;
  registerNode(
    machineA,
    1,
    ws,
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
        accountContextId: '11111111-2222-4333-8444-555555555555',
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
      accountContextId: '11111111-2222-4333-8444-555555555555',
    });
    assert.deepEqual(result, { session: expectedSession });
    assert.equal(forwardedRequests, 1);
  } finally {
    unregisterByWs(ws);
    nodeModelCatalogs.unavailable('pi', machineA);
    nodeModelCatalogs.unavailable('pi', machineB);
    nodeModelCatalogs.unavailable('antigravity', machineA);
    if (prevPoolDir === undefined) delete process.env.FARMSLOT_POOL_DIR;
    else process.env.FARMSLOT_POOL_DIR = prevPoolDir;
    rmSync(root, { recursive: true, force: true });
  }
});
