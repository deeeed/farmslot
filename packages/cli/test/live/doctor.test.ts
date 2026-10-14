import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { validateRecipeArtifactDirectory } from '../../src/commands/recipe.js';
import {
  fixture,
  manifest,
  run,
  runProcess,
  uiRecordingFixture,
} from '../helpers/project-doctor.js';

test('public conformance reuses identical parameters and refuses a changed invocation', (t) => {
  const { root, write } = fixture(t);
  const recipe = JSON.parse(
    fs.readFileSync(path.join(root, 'recipes/headless/smoke.recipe.json'), 'utf8'),
  );
  recipe.paramsSchema = {
    type: 'object',
    properties: {
      expected: { type: 'string' },
      items: { type: 'array', items: { type: 'string' } },
    },
    required: ['expected', 'items'],
    additionalProperties: false,
  };
  write('recipes/headless/smoke.recipe.json', recipe);
  const flags = ['--authorize-provider', path.join(root, 'provider.mjs'), '--recipe', 'smoke'];
  const invoke = (expected: string, extra: string[] = []) =>
    runProcess(
      root,
      [
        ...flags,
        '--param',
        `expected=${JSON.stringify(expected)}`,
        '--param',
        'items=["one","two"]',
        ...extra,
      ],
      {},
      { timeoutMs: 30000, publicBin: true },
    );
  const original = invoke('hello, world');
  assert.equal(original.status, 0, JSON.stringify(original.envelope));
  const { report, reportPath } = original.envelope.data;
  assert.ok(report.identity.invocations[0].paramsDigest);
  const bytes = fs.readFileSync(reportPath, 'utf8');
  const cached = invoke('hello, world', ['--check-report', reportPath]);
  assert.equal(cached.status, 0, JSON.stringify(cached.envelope));
  assert.equal(cached.envelope.data.report.checkedAt, report.checkedAt);
  const changed = invoke('changed', ['--check-report', reportPath]);
  assert.equal(changed.status, 1);
  assert.match(changed.envelope.error.message, /report is stale/u);
  assert.equal(fs.readFileSync(reportPath, 'utf8'), bytes);
});

test('public live doctor retains real smoke and cleanup proof for one disposable headless checkout', async (t) => {
  const { root, write } = fixture(t);
  write('manifests/headless.action-manifest.json', manifest);
  write('recipes/headless/smoke.recipe.json', {
    $schema: 'https://farmslot.io/schemas/recipe-v1.schema.json',
    description: 'Observe a real owned file and verify its cleanup.',
    proofTargets: [
      { id: 'smoke', claim: 'The owned file contains the expected value' },
      { id: 'cleanup', claim: 'The owned file is removed' },
    ],
    workflow: {
      entry: 'create',
      teardown: 'cleanup',
      nodes: {
        create: {
          action: 'command',
          cmd: `node -e 'const fs=require("node:fs");fs.writeFileSync("owned.txt","expected");console.log(fs.readFileSync("owned.txt","utf8"))'`,
          intent: 'Create and read an owned file',
          next: 'check',
        },
        check: {
          action: 'assert_output',
          source: 'create',
          contains: 'expected',
          proves: ['smoke'],
          intent: 'Verify the file value',
          next: 'done',
        },
        done: { action: 'end', status: 'pass' },
        cleanup: {
          action: 'command',
          cmd: `node -e 'const fs=require("node:fs");fs.unlinkSync("owned.txt");console.log(fs.existsSync("owned.txt")?"present":"removed")'`,
          intent: 'Remove the owned file and observe its absence',
          next: 'cleanup-check',
        },
        'cleanup-check': {
          action: 'assert_output',
          source: 'cleanup',
          contains: 'removed',
          proves: ['cleanup'],
          intent: 'Verify cleanup',
          next: 'closed',
        },
        closed: { action: 'end', status: 'pass' },
      },
    },
  });
  const result = runProcess(
    root,
    [
      '--authorize-provider',
      path.join(root, 'provider.mjs'),
      '--live',
      '--disposable',
      '--recipe',
      'smoke',
      '--smoke-target',
      'smoke',
      '--teardown-target',
      'cleanup',
      '--source-kind',
      'operator',
      '--source-trust',
      'trusted',
    ],
    {},
    { timeoutMs: 30000, publicBin: true },
  );
  assert.equal(result.status, 0, JSON.stringify(result.envelope));
  const { report } = result.envelope.data;
  assert.equal(report.mode, 'live');
  assert.equal(fs.existsSync(path.join(root, 'owned.txt')), false);
  assert.equal(
    report.capabilities.find((entry: { name: string }) => entry.name === 'recipe.teardown').status,
    'verified',
  );
  const evidence = report.checks[0].evidence.live;
  assert.equal(evidence.smokeTarget, 'smoke');
  assert.equal(evidence.teardownTarget, 'cleanup');
  assert.ok(
    evidence.artifacts.some(
      (entry: { path: string; digest: string }) =>
        entry.path === 'trace.json' && entry.digest.startsWith('sha256:'),
    ),
  );
  const reportPath = result.envelope.data.reportPath;
  const runDirs = fs.readdirSync(path.dirname(evidence.artifactDir));
  const cachedFlags = [
    '--authorize-provider',
    path.join(root, 'provider.mjs'),
    '--recipe',
    'smoke',
    '--source-kind',
    'operator',
    '--source-trust',
    'trusted',
    '--check-report',
    reportPath,
  ];
  const cached = await run(t, root, cachedFlags);
  assert.equal(cached.status, 0, JSON.stringify(cached.envelope));
  assert.equal(cached.envelope.data.report.checkedAt, report.checkedAt);
  assert.deepEqual(fs.readdirSync(path.dirname(evidence.artifactDir)), runDirs);
  fs.appendFileSync(path.join(evidence.artifactDir, 'trace.json'), '\n');
  const stale = await run(t, root, cachedFlags);
  assert.equal(stale.status, 1);
  assert.match(stale.envelope.error.message, /evidence changed/u);
  assert.deepEqual(JSON.parse(fs.readFileSync(reportPath, 'utf8')), report);
});

test('live doctor forwards recording off to UI proof and retains its still', async (t) => {
  const { root, flags } = uiRecordingFixture(t);
  const result = await run(t, root, [
    ...flags,
    '--recording-reason',
    'Validate before the recorded proof',
  ]);
  assert.equal(result.status, 0, JSON.stringify(result.envelope));
  const report = result.envelope.data.report;
  assert.equal(report.mode, 'live');
  assert.equal(report.status, 'pass');
  const evidence = report.checks[0].evidence.live;
  const ledger = JSON.parse(
    fs.readFileSync(path.join(evidence.artifactDir, 'acceptance-status.json'), 'utf8'),
  );
  assert.equal(ledger.recording.status, 'explicit-off');
  assert.equal(ledger.recording.reason, 'Validate before the recorded proof');
  assert.ok(evidence.artifacts.some((entry: { path: string }) => entry.path === 'proof.png'));
  assert.equal(fs.existsSync(path.join(root, 'artifacts', 'captured')), true);
  const advisory = await validateRecipeArtifactDirectory(evidence.artifactDir, {
    requireRunnerProvenance: true,
    liveProof: {
      smokeTarget: 'smoke',
      teardownTarget: 'cleanup',
      captureRequired: true,
      hudRequired: true,
    },
  });
  assert.equal(advisory.status, 'pass');
  assert.equal(advisory.liveEvidence?.hudRequired, false);
  assert.deepEqual(advisory.liveEvidence?.captures, ['proof.png']);
  assert.ok(advisory.warnings?.some((message) => /HUD/.test(message)));
});
