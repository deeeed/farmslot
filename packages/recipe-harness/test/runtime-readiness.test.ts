import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
  analyzeBundleLog,
  evaluatePersistentBundleError,
  moduleExistsInNodeModules,
  supersededErrorCapture,
} from '../src/runtime/log-analysis.js';
import { depsCheck, recordDepsBaseline } from '../src/runtime/deps-readiness.js';
import { orchestrateRuntimeUp } from '../src/runtime/orchestrate-up.js';
import type { RuntimeDecisionReport } from '../src/runtime/decision-types.js';

test('depsCheck reports missing install markers', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rh-deps-'));
  try {
    await writeFile(path.join(root, 'package.json'), '{"name":"stub"}\n');
    const check = depsCheck(root);
    assert.equal(check.status, 'missing');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('depsCheck records and compares baseline fingerprint', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rh-deps-'));
  try {
    await writeFile(path.join(root, 'package.json'), '{"name":"stub"}\n');
    await writeFile(path.join(root, 'yarn.lock'), '# lock\n');
    await mkdir(path.join(root, 'node_modules/.yarn'), { recursive: true });
    await writeFile(path.join(root, 'node_modules/.yarn-state.yml'), 'install\n');
    recordDepsBaseline(root);
    assert.equal(depsCheck(root).status, 'current');
    await writeFile(path.join(root, 'yarn.lock'), '# lock\n# bump\n');
    assert.equal(depsCheck(root).status, 'stale');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('moduleExistsInNodeModules requires package.json', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rh-mod-'));
  try {
    await mkdir(path.join(root, 'node_modules/hollow'), { recursive: true });
    assert.equal(moduleExistsInNodeModules(root, 'hollow'), false);
    await writeFile(path.join(root, 'node_modules/hollow/package.json'), '{}\n');
    assert.equal(moduleExistsInNodeModules(root, 'hollow'), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('analyzeBundleLog scopes unresolved cites after last bundle ok', () => {
  const log = [
    'error: Bundling failed',
    'Error: Unable to resolve "still-missing" from "app/old.ts"',
    'iOS Bundled 99ms index.js (1 module)',
    'error: Bundling failed',
    'SyntaxError: Unexpected token',
  ].join('\n');
  const analysis = analyzeBundleLog({
    target: '/tmp/stub',
    logText: log,
    errorPattern: /Bundling failed|Unable to resolve /u,
    okPattern: /Bundled \d+ms|iOS Bundled/u,
  });
  assert.equal(analysis.status, 'errors');
  assert.equal(analysis.reason, 'bundle-error');
});

test('supersededErrorCapture ignores stale native errors after bundle ok', () => {
  const log = [
    ' ERROR  [runtime not ready]: HybridObject "NitroFetch" - It has not yet been registered',
    'iOS Bundled 99ms index.js (1 module)',
  ].join('\n');
  const stale = supersededErrorCapture(log, {
    errorPattern: /HybridObject "([^"]+)" - It has not yet been registered/u,
    okPattern: /Bundled \d+ms|iOS Bundled/u,
  });
  assert.equal(stale, null);
});

test('orchestrateRuntimeUp installs once then relaunches', async () => {
  let decideCalls = 0;
  const reports: RuntimeDecisionReport[] = [
    { decision: 'install', reasonCode: 'deps-missing', detail: 'missing markers' },
    { decision: 'launch', reasonCode: 'metro-down', detail: 'metro not listening' },
  ];
  const installed: string[] = [];
  const launched: string[] = [];
  const result = await orchestrateRuntimeUp({
    decide: async () => {
      const report = reports[decideCalls++] ?? reports[reports.length - 1]!;
      return report;
    },
    onInstall: async () => {
      installed.push('install');
    },
    onLaunch: async (report) => {
      launched.push(report.decision);
    },
    onReady: async () => {
      throw new Error('unexpected ready');
    },
  });
  assert.deepEqual(installed, ['install']);
  assert.deepEqual(launched, ['launch']);
  assert.equal(result.exitDecision, 'launch');
});

test('orchestrateRuntimeUp fails when install does not resolve', async () => {
  await assert.rejects(
    () =>
      orchestrateRuntimeUp({
        decide: async () => ({ decision: 'install', reasonCode: 'deps-missing', detail: 'still missing' }),
        onInstall: async () => {},
        onLaunch: async () => {},
        onReady: async () => {},
        installAttempted: { value: true },
      }),
    /install did not resolve runtime/,
  );
});

test('evaluatePersistentBundleError blocks on repeated excerpt', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rh-bundle-'));
  try {
    const first = evaluatePersistentBundleError(root, 'SyntaxError: broken');
    assert.equal(first.blocked, false);
    const second = evaluatePersistentBundleError(root, 'SyntaxError: broken');
    assert.equal(second.blocked, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});