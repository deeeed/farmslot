import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { invalidateProjectVarsCache, poolDir, projectsDir } from '../core/config.js';
import { createRun } from '../runs/store.js';

import { executePrepareStep } from './dispatch-lifecycle-steps.js';
import {
  materializeHarnessCommand,
  mergeHarnessLifecycle,
  parseResolvedHarnessSha,
} from './eval-harness-lifecycle.js';
import {
  deleteTestRunIfPresent,
  makeEvalResultPackage,
  RECIPE_HARNESS_PROJECT_CONFIG,
} from './test-fixtures.js';

test('eval harness install attempts invalidate stale downstream lifecycle state', () => {
  const current = makeEvalResultPackage({
    axes: { harness: { name: 'recipe-harness', version: 'mobile' } },
    harnessLifecycle: {
      source: 'recipe-harness',
      adapter: 'mobile',
      installStatus: 'passed',
      verifyStatus: 'passed',
      cleanupStatus: 'passed',
      installLogPath: 'artifacts/recipe-harness/install.log',
      verifyLogPath: 'artifacts/recipe-harness/verify.log',
      cleanupLogPath: 'artifacts/recipe-harness/cleanup.log',
    },
  });

  const next = mergeHarnessLifecycle(current, 'install', {
    installStatus: 'pending',
    installLogPath: 'artifacts/recipe-harness/install.log',
  });

  assert.equal(next.harnessLifecycle?.installStatus, 'pending');
  assert.equal(next.harnessLifecycle?.verifyStatus, 'pending');
  assert.equal(next.harnessLifecycle?.cleanupStatus, 'pending');
  assert.equal(next.harnessLifecycle?.verifyLogPath, undefined);
  assert.equal(next.harnessLifecycle?.cleanupLogPath, undefined);
  assert.equal(next.missingData.includes('harness-install-pending'), true);
  assert.equal(next.missingData.includes('harness-verify-pending'), true);
  assert.equal(next.missingData.includes('harness-cleanup-pending'), true);
});
test('eval harness materialization preserves explicit local paths', () => {
  const materialized = materializeHarnessCommand(
    { path: '/tmp/recipe-harness' },
    '/tmp/harness-source',
  );

  assert.equal(materialized.harnessDir, '/tmp/recipe-harness');
  assert.equal(materialized.resolvedShaCommand, undefined);
  assert.match(materialized.command, /test -n/);
  assert.doesNotMatch(materialized.command, /git clone|Example App\/skills/);
});
test('eval harness materialization records resolved git checkout command', () => {
  const materialized = materializeHarnessCommand(
    {
      name: 'recipe-harness',
      ref: 'main',
    },
    '/tmp/harness-source',
    RECIPE_HARNESS_PROJECT_CONFIG,
  );

  assert.equal(
    materialized.harnessDir,
    '/tmp/harness-source/checkout/domains/coding/skills/recipe-harness',
  );
  assert.match(materialized.command, /git .*fetch --depth 1 origin 'main'/);
  assert.match(materialized.resolvedShaCommand ?? '', /git .*rev-parse HEAD/);
});
test('eval harness materialization rejects abbreviated commit refs', () => {
  assert.throws(
    () =>
      materializeHarnessCommand(
        {
          name: 'recipe-harness',
          ref: 'cb82213',
        },
        '/tmp/harness-source',
      ),
    /abbreviated commit SHA/,
  );
});
test('eval harness lifecycle treats full sha refs as resolved provenance', () => {
  const sha = '0123456789abcdef0123456789abcdef01234567';
  const current = makeEvalResultPackage({
    axes: { harness: { name: 'recipe-harness', ref: sha, version: 'mobile' } },
  });

  const next = mergeHarnessLifecycle(current, 'install', {
    installStatus: 'pending',
    installLogPath: 'artifacts/recipe-harness/install.log',
  });

  assert.equal(next.harnessLifecycle?.requestedRef, sha);
  assert.equal(next.harnessLifecycle?.resolvedSha, sha);
});
test('eval harness resolved sha parsing only accepts standalone sha lines', () => {
  const sha = '0123456789abcdef0123456789abcdef01234567';

  assert.equal(parseResolvedHarnessSha(`warning: noisy\n${sha}\n`), sha);
  assert.equal(parseResolvedHarnessSha(`prefix ${sha}`), undefined);
  assert.equal(parseResolvedHarnessSha(`${sha}\nnot-a-sha`), sha);
});
test('executePrepareStep rejects warm-slot skip for eval replay', async (t) => {
  const run = createRun({
    flowType: 'fix-bug',
    mode: 'autonomous',
    project: 'example-mobile-farm',
    ticketOrPr: 'EVAL-SKIP-PREPARE',
    runner: 'codex',
    slotId: 'runner-mobile-1',
    completionPolicy: 'artifact-only',
    engineState: {
      evalExperiment: {
        experimentId: 'experiment-skip-prepare',
        experimentKey: 'experiment-key-skip-prepare',
        experimentManifestPath: '/tmp/experiment-manifest.json',
        packagePath: '/tmp/candidate.result-package.json',
        candidateStrategyFingerprint: 'fingerprint-skip-prepare',
        trialId: 'trial-skip-prepare',
      },
    },
  });
  t.after(async () => {
    await deleteTestRunIfPresent(run.id);
  });

  await assert.rejects(
    () =>
      executePrepareStep(run.id, {
        activeMonitors: new Map(),
        broadcastFn: () => undefined,
        getRunFlags: () => ({ skipPrepare: true }),
        normalizeEvalReplayForTaskWrite: async (_runId, current) => current,
        stepPartialIO: new Map(),
      }),
    /Eval replay cannot skip prepare/,
  );
});

test('executePrepareStep accepts warm-slot skip when parsed project health is ready', async (t) => {
  const suffix = `warm-health-${process.pid}-${Date.now()}`;
  const projectName = `example-${suffix}`;
  const slotId = `slot-${suffix}`;
  const repo = await mkdtemp(path.join(os.tmpdir(), `${suffix}-repo-`));
  const projectDir = path.join(projectsDir, projectName);
  const poolFile = path.join(poolDir, `${slotId}.json`);
  await mkdir(projectDir, { recursive: true });
  await mkdir(poolDir, { recursive: true });
  await writeFile(
    path.join(projectDir, 'project.json'),
    JSON.stringify(
      {
        skip_prepare_requires_health: true,
        health: {
          ready_indicator: 'WalletView',
          parse_health:
            'python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get(\\"route\\", \\"\\"))"',
        },
        hooks: {
          health_check: `printf '%s\\n' '{"ready":true,"route":"WalletView"}'`,
        },
      },
      null,
      2,
    ),
  );
  await writeFile(
    poolFile,
    JSON.stringify(
      {
        machine: 'local-test',
        project: projectName,
        platform: 'ios',
        os: 'darwin',
        host: 'localhost',
        ssh_user: 'test',
        slots: [
          {
            id: slotId,
            project: projectName,
            repo,
            session: slotId,
            enabled: true,
            mode: 'dispatch',
            resources: { 'dev-server': { port: 6553 } },
          },
        ],
      },
      null,
      2,
    ),
  );
  invalidateProjectVarsCache(projectName);
  t.after(async () => {
    invalidateProjectVarsCache(projectName);
    await rm(poolFile, { force: true });
    await rm(projectDir, { recursive: true, force: true });
    await rm(repo, { recursive: true, force: true });
  });

  const run = createRun({
    flowType: 'fix-bug',
    mode: 'autonomous',
    project: projectName,
    ticketOrPr: 'WARM-HEALTH',
    runner: 'codex',
    slotId,
    branch: 'warm-health',
  });
  t.after(async () => {
    await deleteTestRunIfPresent(run.id);
  });

  const result = await executePrepareStep(run.id, {
    activeMonitors: new Map(),
    broadcastFn: () => undefined,
    getRunFlags: () => ({ skipPrepare: true }),
    normalizeEvalReplayForTaskWrite: async (_runId, current) => current,
    stepPartialIO: new Map(),
  });

  assert.deepEqual(result.outputs, { skipped: true, reason: 'warm-slot' });
  assert.equal(result.inputs?.warmSlotHealth, 'WalletView');
});
