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
  const { workspaceSuiteFiles, workspaceTestCatalog } =
    await import('./workspace-test-targets.mjs');
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
    assigned.filter((file) => file.endsWith('.test.ts')).sort(),
    [...workspaceSuiteFiles(workspaces, root)].filter((file) => file.endsWith('.test.ts')).sort(),
  );
  assert.equal(tasks.filter(({ id }) => id === 'guard-lint').length, 1);
  assert.ok(tasks.some(({ id }) => id === 'tests-@farmslot/run-bundle'));
  assert.ok(!plan.selected.includes('packages/cli/test/live/doctor.test.ts'));
  assert.ok(!plan.selected.includes('packages/protocol/src/contracts/review-workspace.test.ts'));
  const base = { root, workspaces, selected: [] };
  const controls = createPrPlan({
    ...base,
    changed: ['.github/workflows/farmslot-quality.yml', 'scripts/quality/run-tsx-tests.mjs'],
  });
  const controlTasks = controls.jobs.flatMap(({ tasks }) => tasks);
  assert.equal(controls.jobs.filter(({ id }) => id.startsWith('gateway-')).length, 1);
  assert.ok(controls.selected.includes('packages/run-bundle/src/retained-locks.test.ts'));
  assert.ok(controlTasks.some(({ id }) => id.startsWith('command-center-ui-')));
  assert.ok(!controlTasks.some(({ id }) => id.startsWith('tests-')));
  const mixed = createPrPlan({
    ...base,
    changed: ['scripts/quality/run-tsx-tests.mjs', 'apps/command-center/ui/src/utils/url-state.ts'],
  });
  assert.ok(mixed.jobs.some(({ id }) => id.startsWith('run-bundle-smoke-')));
  const offline = mixed.jobs.find(({ tasks }) =>
    tasks.some(({ id }) => id === 'guard-offline-first reads'),
  );
  assert.equal(offline.tasks.length, 1);

  const configPlan = createPrPlan({ ...base, changed: ['apps/command-center/tsconfig.base.json'] });
  for (const name of ['gateway', 'node', 'command-center-ui', 'cli', 'protocol', 'recipe-runner'])
    assert.ok(
      configPlan.jobs
        .flatMap(({ tasks }) => tasks)
        .some(({ id }) => id === `types-@farmslot/${name}`),
    );
  const templatePlan = createPrPlan({
    ...base,
    changed: ['projects/farmslot-farm/templates/worker/review-pr.md'],
  });
  assert.ok(
    templatePlan.selected.includes('services/gateway/src/review/static-review-execution.test.ts'),
  );
  const uiTask = tasks.find(({ id }) => id.startsWith('command-center-ui-'));
  assert.equal(uiTask.args[uiTask.args.indexOf('--cwd') + 1], 'apps/command-center');
  assert.equal(uiTask.args[uiTask.args.indexOf('--tsconfig') + 1], 'ui/tsconfig.json');
  for (const task of tasks.filter(
    (task) => task.id.startsWith('types-') && task.args.includes('bash'),
  ))
    assert.deepEqual(task.args.slice(0, 3), ['yarn', 'exec', 'bash']);
});

test('full validation supplements docs and suites omitted by package quality', async () => {
  const { needsSupplementarySuite } = await import('./ci-full-supplement.mjs');
  assert.equal(
    needsSupplementarySuite({
      dir: 'apps/docs',
      test: 'node --test scripts/*.test.mjs',
      quality: 'yarn test && yarn build',
    }),
    true,
  );
  assert.equal(
    needsSupplementarySuite({
      dir: 'packages/credential-store',
      test: 'runner src',
      quality: 'tsc --noEmit',
    }),
    true,
  );
  assert.equal(
    needsSupplementarySuite({
      dir: 'packages/run-bundle',
      test: 'runner src',
      quality: 'yarn test && tsc --noEmit',
    }),
    false,
  );
});

test('PR scope excludes main advances present in the synthetic merge checkout', async (t) => {
  const { execFileSync } = await import('node:child_process');
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const path = await import('node:path');
  const { GIT_LOCATION_ENV } = await import('./run-tsx-tests.mjs');
  const { prChangedFiles } = await import('./pr-ci-plan.mjs');
  const root = mkdtempSync(path.join(tmpdir(), 'pr-change-range-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env = { ...process.env };
  for (const name of GIT_LOCATION_ENV) delete env[name];
  const git = (...args) =>
    execFileSync('git', args, {
      cwd: root,
      env,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  git('init', '-q', '-b', 'main');
  for (const [key, value] of [
    ['user.name', 'Test'],
    ['user.email', 'test@example.invalid'],
    ['commit.gpgsign', 'false'],
    ['core.hooksPath', '/dev/null'],
  ])
    git('config', key, value);
  git('commit', '-q', '--allow-empty', '-m', 'base');
  const base = git('rev-parse', 'HEAD');
  git('checkout', '-q', '-b', 'pr');
  mkdirSync(path.join(root, 'scripts/quality'), { recursive: true });
  writeFileSync(path.join(root, 'scripts/quality/change.mjs'), 'export {};\n');
  git('add', '.');
  git('commit', '-q', '-m', 'CI change');
  const head = git('rev-parse', 'HEAD');
  git('checkout', '-q', 'main');
  writeFileSync(path.join(root, 'upstream.ts'), 'export {};\n');
  git('add', '.');
  git('commit', '-q', '-m', 'main advance');
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  git('merge', '-q', '--no-edit', 'pr');
  assert.match(git('diff', '--name-only', `${base}...HEAD`), /upstream\.ts/);
  assert.deepEqual(
    prChangedFiles(root, { base: { ref: 'main', sha: base }, head: { sha: head } }),
    ['scripts/quality/change.mjs'],
  );
});
