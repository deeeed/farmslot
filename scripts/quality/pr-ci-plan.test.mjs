import assert from 'node:assert/strict';
import test from 'node:test';

import { balance, withoutBuilds } from './pr-ci-plan.mjs';
import { verifyReceipts } from './pr-ci-run.mjs';

test('duration balancing covers every file exactly once', () => {
  const items = [100, 70, 60, 40, 30, 10];
  const bins = balance(items, 3, (weight) => weight);
  assert.deepEqual(
    bins.flat().sort((a, b) => a - b),
    [...items].sort((a, b) => a - b),
  );
  assert.ok(Math.max(...bins.map((bin) => bin.reduce((sum, item) => sum + item, 0))) <= 110);
  assert.deepEqual(balance([], 8), []);
});
test('custom suite commands retain assertions and omit already-built prerequisites', () => {
  assert.equal(
    withoutBuilds(
      'yarn workspace @farmslot/protocol build && node --test test/*.cjs && yarn build && node test.mjs',
    ),
    'node --test test/*.cjs && node test.mjs',
  );
});
test('final verifier rejects missing, duplicate and incomplete jobs', () => {
  const plan = { jobs: [{ id: 'one', tasks: [{ id: 'test' }] }] };
  const receipt = { id: 'one', status: 'ok', tasks: ['test'] };
  verifyReceipts(plan, [receipt]);
  for (const input of [
    [],
    [receipt, receipt],
    [{ ...receipt, tasks: [] }],
    [{ ...receipt, status: 'running' }],
  ])
    assert.throws(() => verifyReceipts(plan, input));
});

test('full workspace inventory has one test owner and splits the critical app suites', async () => {
  const { spawnSync } = await import('node:child_process');
  const { readFileSync } = await import('node:fs');
  const { workspaceTestCatalog } = await import('./workspace-test-targets.mjs');
  const { createPrPlan } = await import('./pr-ci-plan.mjs');
  const root = process.cwd();
  const listed = spawnSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' });
  assert.equal(listed.status, 0);
  const files = listed.stdout.split('\0').filter(Boolean);
  const workspaces = workspaceTestCatalog(root);
  const selected = files.filter(
    (file) => file.endsWith('.test.ts') && workspaces.some(({ dir }) => file.startsWith(`${dir}/`)),
  );
  const plan = createPrPlan({
    root,
    changed: null,
    workspaces,
    selected,
    durations: JSON.parse(readFileSync('scripts/quality/ci-test-durations.json', 'utf8')),
  });
  const tasks = plan.jobs.flatMap(({ tasks }) => tasks);
  assert.equal(plan.jobs.filter(({ id }) => id.startsWith('gateway-')).length, 8);
  assert.equal(plan.jobs.filter(({ id }) => id.startsWith('command-center-ui-')).length, 4);
  const assigned = tasks.flatMap((task) => task.tests ?? []);
  assert.equal(new Set(assigned).size, assigned.length);
  assert.deepEqual(
    [...assigned].sort(),
    selected.filter((file) => !file.startsWith('apps/docs/')).sort(),
  );
  assert.equal(tasks.filter(({ id }) => id === 'guard-lint').length, 1);
  assert.ok(tasks.some(({ id }) => id === 'tests-@farmslot/run-bundle'));
});
