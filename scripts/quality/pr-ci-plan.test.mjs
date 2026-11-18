import assert from 'node:assert/strict';
import test from 'node:test';

import {
  balance,
  balanceTestShards,
  estimateTestMs,
  inlinePlanOutput,
  packPrTasks,
  withoutBuilds,
} from './pr-ci-plan.mjs';
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
test('PR estimates include mock/serial time before sorted parallel workers', () => {
  const durations = { a: 10000, b: 20000, c: 10000, d: 20000, s: 30000 };
  const lanes = new Map([['s', 'module-mock']]);
  assert.equal(estimateTestMs(['s', 'd', 'c', 'b', 'a'], 2, durations, lanes), 70000);
  assert.equal(estimateTestMs([], 4, durations, lanes), 0);
});
test('PR sharding bounds the critical path without repeating tests or losing available workers', () => {
  const files = Array.from({ length: 40 }, (_, index) => `file-${String(index).padStart(2, '0')}`);
  const durations = Object.fromEntries(files.map((file, i) => [file, i < 20 ? 12000 : 2000]));
  const lanes = new Map(files.slice(0, 20).map((file) => [file, 'module-mock']));
  const bins = balanceTestShards(files, 4, 2, durations, lanes);
  assert.deepEqual(bins.flatMap((bin) => bin.files).sort(), files);
  assert.ok(Math.max(...bins.map((bin) => bin.ms)) <= 72000);
  assert.ok(bins.reduce((ms, bin) => ms + bin.ms, 0) <= 280000);
  assert.deepEqual(balanceTestShards(files, 4, 2, durations, lanes), bins);
  assert.deepEqual(balanceTestShards([], 12, 4, durations, lanes), []);
});
test('custom suite commands retain assertions and omit already-built prerequisites', () => {
  assert.equal(
    withoutBuilds(
      'yarn workspace @farmslot/protocol build && node --test test/*.cjs && yarn build && node test.mjs',
    ),
    'node --test test/*.cjs && node test.mjs',
  );
});
test('PR task packing fills spare test capacity, isolates long checks and bounds runner count', () => {
  const jobs = [{ id: 'gateway-1', tasks: [{ id: 'gateway-test', seconds: 90 }] }];
  const tasks = [
    { id: 'long-check', seconds: 150 },
    { id: 'script-batch', seconds: 83 },
    { id: 'types', seconds: 25 },
    { id: 'small-guard', seconds: 5 },
  ];
  const result = packPrTasks(jobs, tasks);
  assert.ok(
    result.find(({ id }) => id === 'gateway-1').tasks.some(({ id }) => id === 'small-guard'),
    'cheap work uses an existing test job instead of another setup',
  );
  assert.equal(
    result.find(({ tasks }) => tasks.some(({ id }) => id === 'long-check')).tasks.length,
    1,
  );
  assert.deepEqual(
    result.flatMap(({ tasks }) => tasks.map(({ id }) => id)).sort(),
    ['gateway-test', ...tasks.map(({ id }) => id)].sort(),
  );
  assert.equal(jobs[0].tasks.length, 1, 'the input plan stays intact');
  const bounded = packPrTasks(
    [],
    Array.from({ length: 30 }, (_, i) => ({ id: `${i}`, seconds: 150 })),
  );
  assert.equal(bounded.length, 12);
  assert.equal(bounded.flatMap(({ tasks }) => tasks).length, 30);
});
test('at the matrix cap the smallest job takes the next task', () => {
  const tasks = [180, 110, 75, 60, 45].map((seconds, i) => ({ id: `task-${i}`, seconds }));
  const jobs = packPrTasks([], tasks, 120, 2);
  assert.deepEqual(
    jobs.map(({ tasks }) => tasks.map(({ seconds }) => seconds)),
    [
      [180, 60],
      [110, 75, 45],
    ],
  );
});
test('full gateway PRs split large work without changing test ownership', async (t) => {
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const path = await import('node:path');
  const { createPrPlan } = await import('./pr-ci-plan.mjs');
  const root = mkdtempSync(path.join(tmpdir(), 'pr-gateway-shards-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = 'services/gateway';
  mkdirSync(path.join(root, dir, 'src'), { recursive: true });
  writeFileSync(
    path.join(root, dir, 'package.json'),
    JSON.stringify({ scripts: { typecheck: 'tsc --noEmit' } }),
  );
  const testScript = 'node ../../scripts/quality/run-tsx-tests.mjs --cwd . src';
  const workspaces = [{ dir, name: '@farmslot/gateway', dependencies: [], test: testScript }];
  const selected = Array.from({ length: 40 }, (_, i) => `${dir}/src/file-${i}.test.ts`);
  for (const file of selected) writeFileSync(path.join(root, file), '');
  const input = {
    root,
    workspaces,
    selected,
    changed: [`${dir}/src/runtime.ts`],
    durations: Object.fromEntries(selected.map((file) => [file, 42_000])),
    taskDurations: { 'types-@farmslot/gateway': { ms: 32_000 } },
  };
  const gatewayJobs = (plan) => plan.jobs.filter(({ id }) => id.startsWith('gateway-'));
  const plan = createPrPlan(input);
  const shards = gatewayJobs(plan);
  assert.ok(shards.length > 11);
  assert.ok(plan.jobs.length > 12 && plan.jobs.length <= 26);
  assert.deepEqual(shards.flatMap(({ tasks }) => tasks[0].tests).sort(), [...selected].sort());
  for (const file of selected) assert.match(plan.testOwners[file], /^gateway-\d+$/);
  assert.equal(
    plan.jobs.flatMap(({ tasks }) => tasks).filter(({ id }) => id === 'types-@farmslot/gateway')
      .length,
    1,
  );
});

test('native script batches retain the longest-file lower bound', async () => {
  const { createPrPlan } = await import('./pr-ci-plan.mjs');
  const file = 'scripts/deploy-node.test.mjs';
  const plan = createPrPlan({
    root: process.cwd(),
    changed: ['services/gateway/src/core/config.ts'],
    selected: [file],
    workspaces: [],
    durations: { [file]: 83_000 },
  });
  const task = plan.jobs
    .flatMap(({ tasks }) => tasks)
    .find(({ id }) => id.startsWith('other-selected-tests-'));
  assert.ok(task.seconds >= 83, 'one slow file cannot be divided across Node workers');
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
  assert.equal(plan.jobs.length, 26);
  assert.ok(plan.jobs.filter(({ id }) => id.startsWith('gateway-')).length > 7);
  assert.equal(plan.jobs.filter(({ id }) => id.startsWith('command-center-ui-')).length, 4);
  const assigned = tasks.flatMap((task) => task.tests ?? []);
  assert.deepEqual(Object.keys(plan.testOwners).sort(), [...plan.selected].sort());
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
  const calibrated = createPrPlan({
    ...base,
    changed: ['.github/workflows/farmslot-quality.yml', 'scripts/quality/run-tsx-tests.mjs'],
    taskDurations: { 'guard-lint': { ms: 1000 } },
  });
  assert.equal(
    calibrated.jobs.flatMap((job) => job.tasks).find((task) => task.id === 'guard-lint').seconds,
    1,
  );
  assert.deepEqual(
    calibrated.jobs
      .flatMap((job) => job.tasks)
      .map(({ id }) => id)
      .sort(),
    controlTasks.map(({ id }) => id).sort(),
  );
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

test('subset cost calibration retains the fixed work of a declared workspace suite', async () => {
  const { createPrPlan } = await import('./pr-ci-plan.mjs');
  const { workspaceSuiteFiles, workspaceTestCatalog } =
    await import('./workspace-test-targets.mjs');
  const root = process.cwd();
  const workspace = workspaceTestCatalog(root).find((entry) => entry.name === '@farmslot/cli');
  const files = [...workspaceSuiteFiles([workspace], root)]
    .filter((file) => file.endsWith('.test.ts'))
    .slice(0, 2);
  const input = {
    root,
    workspaces: [workspace],
    durations: { [files[0]]: 1000, [files[1]]: 3000 },
    taskDurations: {
      'tests-@farmslot/cli': { ms: 10000, fixedMs: 2000, workers: 2, referenceFiles: files },
    },
  };
  const suite = (plan) =>
    plan.jobs.flatMap((job) => job.tasks).find((task) => task.id === 'tests-@farmslot/cli');
  assert.equal(
    suite(createPrPlan({ ...input, changed: [files[0]], selected: [files[0]] })).seconds,
    4,
  );
  assert.equal(
    suite(createPrPlan({ ...input, changed: ['packages/cli/package.json'], selected: [] })).seconds,
    2,
  );
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

test('large encoded plans fall back to artifact transport', async () => {
  const { randomBytes } = await import('node:crypto');
  assert.equal(
    inlinePlanOutput(JSON.stringify({ fixture: randomBytes(100_000).toString('base64') })),
    '',
  );
});

test('inline plan works without an artifact and keeps selection scoped to suite commands', async (t) => {
  const { spawnSync } = await import('node:child_process');
  const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, renameSync, rmSync } =
    await import('node:fs');
  const { tmpdir } = await import('node:os');
  const path = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const root = mkdtempSync(path.join(tmpdir(), 'ci-worker-env-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const tasks = [
    {
      id: 'contract',
      cwd: '.',
      args: [
        process.execPath,
        '-e',
        "require('node:assert/strict').equal(process.env.FARMSLOT_CI_TEST_SELECTION, undefined); require('node:assert/strict').equal(process.env.FARMSLOT_QUALITY_TIMINGS_DIR, undefined); require('node:assert/strict').equal(process.env.CI_INLINE_PR_PLAN, undefined); require('node:fs').writeFileSync(process.argv[1], JSON.stringify({ status: 'failed', files: [] }))",
        path.join(root, '.cache/pr-ci/timings/contract/tsx-tests-fixture.json'),
      ],
    },
    {
      id: 'suite',
      cwd: '.',
      tests: [],
      args: [
        process.execPath,
        '-e',
        "require('node:assert/strict').ok(process.env.FARMSLOT_CI_TEST_SELECTION); require('node:assert/strict').ok(process.env.FARMSLOT_QUALITY_TIMINGS_DIR)",
      ],
    },
  ];
  const json = JSON.stringify({ selected: [], jobs: [{ id: 'environment', tasks }] });
  const worker = fileURLToPath(new URL('./pr-ci-run.mjs', import.meta.url));
  const env = { ...process.env, CI_INLINE_PR_PLAN: inlinePlanOutput(json) };
  const result = spawnSync(process.execPath, [worker, 'environment'], {
    cwd: root,
    encoding: 'utf8',
    env: { ...env, FARMSLOT_CI_TEST_SELECTION: 'inherited-filter.json' },
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(
    JSON.parse(readFileSync(path.join(root, '.cache/pr-ci/receipts/environment.json'), 'utf8'))
      .status,
    'ok',
  );
  const results = path.join(root, '.cache/pr-ci/results/pr-ci-environment-attempt-1');
  mkdirSync(results, { recursive: true });
  renameSync(path.join(root, '.cache/pr-ci/receipts'), path.join(results, 'receipts'));
  for (const inline of [env.CI_INLINE_PR_PLAN, '']) {
    if (!inline) writeFileSync(path.join(root, '.cache/pr-ci/plan.json'), json);
    const verified = spawnSync(process.execPath, [worker, 'verify'], {
      cwd: root,
      encoding: 'utf8',
      env: { ...env, CI_INLINE_PR_PLAN: inline, CI_MATRIX_RESULT: 'success' },
    });
    assert.equal(verified.status, 0, verified.stdout + verified.stderr);
    assert.match(verified.stdout, /Verified 1 jobs/);
  }
});

test('script batches keep native Node tests separate from typed tests', async () => {
  const { createPrPlan } = await import('./pr-ci-plan.mjs');
  const path = await import('node:path');
  const selected = ['scripts/native.test.mjs', 'scripts/native.test.cjs', 'scripts/typed.test.mts'];
  const plan = createPrPlan({ root: process.cwd(), changed: selected, workspaces: [], selected });
  const tasks = plan.jobs
    .flatMap(({ tasks }) => tasks)
    .filter(({ id }) => id.startsWith('other-selected-tests-'));
  const assigned = tasks.flatMap(({ args }) => args.filter((arg) => selected.includes(arg)));
  assert.deepEqual(assigned.sort(), [...selected].sort());
  assert.deepEqual(Object.keys(plan.testOwners).sort(), [...selected].sort());
  for (const task of tasks) {
    if (task.args.some((arg) => /\.[cm]?js$/.test(arg))) {
      assert.deepEqual(task.args.slice(0, 3), [
        'node',
        '--experimental-test-module-mocks',
        '--test',
      ]);
      assert.ok(!task.args.includes('tsx'));
      assert.ok(!task.args.some((arg) => arg.startsWith('TSX_TSCONFIG_PATH=')));
    } else {
      const config = task.args.find((arg) => arg.startsWith('TSX_TSCONFIG_PATH='));
      assert.equal(config, `TSX_TSCONFIG_PATH=${path.resolve('services/gateway/tsconfig.json')}`);
    }
  }
});

test('native fixture children and typed tests work after changing cwd', async (t) => {
  const { spawnSync } = await import('node:child_process');
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const path = await import('node:path');
  const { createPrPlan } = await import('./pr-ci-plan.mjs');
  const root = process.cwd();
  const fixture = mkdtempSync(path.join(tmpdir(), 'script-test-cwd-'));
  t.after(() => rmSync(fixture, { recursive: true, force: true }));
  const native = path.join(fixture, 'native.test.mjs');
  const typed = path.join(fixture, 'typed.test.mts');
  const child = path.join(fixture, 'child.mts');
  writeFileSync(path.join(fixture, 'child.cjs'), "process.stdout.write('native-child-ok');\n");
  writeFileSync(child, "const value: string = 'typed-child-ok'; process.stdout.write(value);\n");
  writeFileSync(
    native,
    `import assert from 'node:assert/strict'; import { test, mock } from 'node:test'; import { execFileSync } from 'node:child_process';
    mock.module('node:os', { namedExports: { hostname: () => 'native-fixture' } });
    const { hostname } = await import('node:os');
    test('native child has no tsx loader', () => {
      assert.ok(!process.execArgv.includes('tsx'));
      assert.equal(hostname(), 'native-fixture');
      assert.equal(execFileSync(process.execPath, ['child.cjs'], { cwd: ${JSON.stringify(fixture)}, encoding: 'utf8' }), 'native-child-ok');
    });\n`,
  );
  writeFileSync(
    typed,
    `import assert from 'node:assert/strict'; import { test } from 'node:test'; import { execFileSync } from 'node:child_process'; import path from 'node:path';
    test('typed child uses absolute config from another cwd', () => {
      assert.ok(path.isAbsolute(process.env.TSX_TSCONFIG_PATH));
      assert.equal(execFileSync(process.execPath, ['--import', ${JSON.stringify(import.meta.resolve('tsx'))}, ${JSON.stringify(child)}], { cwd: ${JSON.stringify(fixture)}, encoding: 'utf8' }), 'typed-child-ok');
    });\n`,
  );
  const selected = [native, typed];
  const plan = createPrPlan({ root, changed: selected, workspaces: [], selected });
  const tasks = plan.jobs
    .flatMap(({ tasks }) => tasks)
    .filter(({ id }) => id.startsWith('other-selected-tests-'));
  for (const task of tasks) {
    const result = spawnSync(task.args[0], task.args.slice(1), {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, TSX_TSCONFIG_PATH: 'services/gateway/tsconfig.json' },
    });
    assert.equal(result.status, 0, result.stdout + result.stderr);
  }
});
