import { spawnSync } from 'node:child_process';
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { isMainModule } from './lib/step-timing.mjs';

function run(args, options = {}) {
  console.log(`+ ${args.join(' ')}`);
  const result = spawnSync(args[0], args.slice(1), { stdio: 'inherit', ...options });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`Command failed (${result.status ?? result.signal}): ${args.join(' ')}`);
}

function docs() {
  run(['yarn', '--cwd', 'apps/docs', 'test']);
  for (const generator of ['api', 'onboarding', 'template-vars', 'contracts'])
    run(['yarn', '--cwd', 'apps/docs', `generate:${generator}`]);
  run([
    'git',
    'diff',
    '--exit-code',
    '--',
    'apps/docs/docs',
    'docs/reference/template-variables.md',
  ]);
  run(['yarn', 'quality:gateway-api-docs']);
}

function acceptance() {
  run(['node', 'scripts/acceptance-evidence/check.mjs']);
  run(['node', '--test', 'scripts/acceptance-evidence/evaluate.test.mjs']);
  run(
    ['node', '--import', 'tsx', '--test', 'scripts/acceptance-evidence/gateway-parity.test.mts'],
    { env: { ...process.env, TSX_TSCONFIG_PATH: 'services/gateway/tsconfig.json' } },
  );
  // The two acceptance-evidence gateway unit files have one owner: gateway shards.
}

function transport() {
  run(['bash', '-e', '-o', 'pipefail', '-c', 'test "$(tmux -V)" = "tmux 3.4"']);
  for (const suite of ['orchestration', 'model-transport', 'model-startup-gate'])
    run(['yarn', `test:${suite}`]);
}

function farmProof() {
  const home = mkdtempSync(path.join(tmpdir(), 'ci-farm-proof-'));
  try {
    run(
      [
        'node',
        '--import',
        'tsx',
        '--experimental-test-module-mocks',
        '--test',
        'scripts/runner-validation/farm-paths-two-instance.test.mts',
      ],
      {
        env: {
          ...process.env,
          HOME: home,
          TSX_TSCONFIG_PATH: 'services/gateway/tsconfig.json',
          FARMSLOT_TEST_TMP: '1',
        },
      },
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

export function verifyReceipts(plan, receipts) {
  const ids = new Set();
  const expected = new Set(plan.jobs.map((job) => job.id));
  for (const receipt of receipts) {
    if (!expected.has(receipt.id) || ids.has(receipt.id))
      throw new Error(`Unexpected or duplicate job receipt: ${receipt.id}`);
    ids.add(receipt.id);
    const job = plan.jobs.find(({ id }) => id === receipt.id);
    if (
      receipt.status !== 'ok' ||
      JSON.stringify(receipt.tasks) !== JSON.stringify(job.tasks.map(({ id }) => id))
    )
      throw new Error(`Incomplete job: ${receipt.id}`);
  }
  if (ids.size !== expected.size) throw new Error('Missing CI job receipts');
}

function worker(id) {
  const root = process.cwd();
  const plan = JSON.parse(readFileSync('.cache/pr-ci/plan.json', 'utf8'));
  const job = plan.jobs.find((entry) => entry.id === id);
  if (!job) throw new Error(`Unknown CI job: ${id}`);
  const selection = path.join(root, '.cache/pr-ci/selection.json');
  writeFileSync(
    selection,
    JSON.stringify({ root, files: plan.selected.map((file) => path.join(root, file)) }),
  );
  const receipt = { id, status: 'running', tasks: [], timings: [] };
  for (const task of job.tasks) {
    const directory = path.join(
      root,
      '.cache/pr-ci/timings',
      task.id.replaceAll(/[^a-zA-Z0-9-]/g, '_'),
    );
    mkdirSync(directory, { recursive: true });
    const started = Date.now();
    run(task.args, {
      cwd: path.join(root, task.cwd),
      env: {
        ...process.env,
        FARMSLOT_CI_TEST_SELECTION: selection,
        FARMSLOT_QUALITY_TIMINGS_DIR: directory,
        FARMSLOT_TSX_TEST_WORKERS: '2',
      },
    });
    const reports = readdirSync(directory)
      .filter((name) => name.startsWith('tsx-tests-'))
      .map((name) => JSON.parse(readFileSync(path.join(directory, name), 'utf8')));
    const actual = reports.flatMap((report) => {
      if (report.status !== 'ok' || report.files.some((file) => file.status !== 'ok'))
        throw new Error(`Failed test report for ${task.id}`);
      return report.files.map((file) =>
        path.posix.join(
          task.cwd === '.' ? task.args[task.args.indexOf('--cwd') + 1] : task.cwd,
          file.file,
        ),
      );
    });
    const expected = task.tests?.filter((file) => file.endsWith('.test.ts')) ?? [];
    if (new Set(actual).size !== actual.length || expected.some((file) => !actual.includes(file)))
      throw new Error(
        `Missing/duplicate selected tests for ${task.id}: ${expected.filter((file) => !actual.includes(file)).join(', ')}`,
      );
    receipt.tasks.push(task.id);
    receipt.timings.push({ task: task.id, ms: Date.now() - started });
  }
  receipt.status = 'ok';
  mkdirSync('.cache/pr-ci/receipts', { recursive: true });
  writeFileSync(`.cache/pr-ci/receipts/${id}.json`, `${JSON.stringify(receipt, null, 2)}\n`);
}

function verify() {
  const plan = JSON.parse(readFileSync('.cache/pr-ci/plan.json', 'utf8'));
  const latest = new Map();
  for (const artifact of readdirSync('.cache/pr-ci/results')) {
    const match = /^pr-ci-(.+)-attempt-([1-9]\d*)$/.exec(artifact);
    if (!match) throw new Error(`Unexpected artifact: ${artifact}`);
    const [, id, attempt] = match;
    if (!latest.has(id) || Number(attempt) > latest.get(id).attempt) {
      latest.set(id, {
        attempt: Number(attempt),
        directory: `.cache/pr-ci/results/${artifact}/receipts`,
      });
    }
  }
  const receipts = [...latest.values()].flatMap(({ directory }) =>
    readdirSync(directory)
      .filter((name) => name.endsWith('.json'))
      .map((name) => JSON.parse(readFileSync(`${directory}/${name}`, 'utf8'))),
  );
  verifyReceipts(plan, receipts);
  if (process.env.CI_MATRIX_RESULT !== 'success')
    throw new Error(`CI matrix result: ${process.env.CI_MATRIX_RESULT}`);
  const text = `Verified ${plan.jobs.length} jobs, ${plan.selected.length} selected test files.\n`;
  console.log(text);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, text);
}

if (isMainModule(import.meta.url)) {
  const mode = process.argv[2];
  if (mode === 'docs') docs();
  else if (mode === 'acceptance') acceptance();
  else if (mode === 'transport') transport();
  else if (mode === 'farm-proof') farmProof();
  else if (mode === 'verify') verify();
  else worker(mode);
}
