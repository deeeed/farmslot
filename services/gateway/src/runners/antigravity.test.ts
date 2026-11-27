import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { normalizeRunner } from '@farmslot/protocol';

import { computeCandidateStrategyFingerprint } from '../evals/package-store.js';
import { resolvePreviewExecution, resolvePreviewModel } from '../methods/dispatch/preview.js';
import { axesForTrialTransport } from '../methods/eval/candidate-setup.js';
import { resolveRunDispatchRunnerModel } from '../run-engine/dispatch-policy.js';

import { resolveTrustedNativeExecutable } from './native/node.js';
import {
  ModelCatalogFormatError,
  NodeModelCatalogs,
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

test('resolveTrustedNativeExecutable reads configured pool antigravity_path outside PATH', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agy-pool-exec-'));
  const prevPoolDir = process.env.FARMSLOT_POOL_DIR;
  try {
    const poolDir = join(root, 'pool');
    mkdirSync(poolDir, { recursive: true });
    const configuredBin = join(root, 'custom-bin', 'agy');
    writeFileSync(
      join(poolDir, 'macwork.json'),
      JSON.stringify({
        machine: 'macwork',
        project: 'demo',
        host: 'localhost',
        ssh_user: process.env.USER || 'operator',
        os: process.platform,
        platform: 'cli',
        antigravity_path: configuredBin,
        slots: [{ id: 'macwork-1', enabled: true, mode: 'dispatch', repo: root, session: 's1' }],
      }),
    );
    process.env.FARMSLOT_POOL_DIR = poolDir;
    assert.equal(await resolveTrustedNativeExecutable('antigravity', 'local'), configuredBin);
    assert.equal(await resolveTrustedNativeExecutable('agy', 'macwork'), configuredBin);
  } finally {
    if (prevPoolDir === undefined) delete process.env.FARMSLOT_POOL_DIR;
    else process.env.FARMSLOT_POOL_DIR = prevPoolDir;
    rmSync(root, { recursive: true, force: true });
  }
});

test('remote Antigravity probe failures are isolated so other runner account status remains available', async () => {
  // Remote host pointing at an unreachable local address causes execOnSlot SSH failure.
  const remoteVars = makeVars({
    machine: 'unreachable-remote-proof',
    host: '127.0.0.1',
    sshUser: 'nobody',
    sshTarget: 'nobody@127.0.0.1',
    antigravityPath: '/nonexistent/agy',
  });
  const subscriptions = await getHostRunnerSubscriptions(remoteVars, {
    runners: ['antigravity', 'unknown-peer'],
  });
  assert.equal(subscriptions.length, 2);
  const agy = subscriptions.find((s) => s.runner === 'antigravity');
  const peer = subscriptions.find((s) => s.runner === 'unknown-peer');
  assert.equal(agy?.source, 'error');
  assert.ok(agy?.error, 'Failed remote Antigravity probe must surface an error string');
  assert.equal(peer?.source, 'unsupported');
});
