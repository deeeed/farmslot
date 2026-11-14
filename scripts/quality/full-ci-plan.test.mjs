import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { commandCatalog, shellCommands } from './full-ci-commands.mjs';
import { assertCoverage, createFullPlan } from './full-ci-plan.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const plan = createFullPlan(root);

test('complete matrix retains every monolithic test/configuration and guard', () => {
  assert.equal(plan.jobs.filter((job) => job.id.startsWith('gateway-')).length, 8);
  assert.equal(plan.jobs.filter((job) => job.id.startsWith('workspaces-')).length, 4);
  assert(plan.coverage.baseline.files.length > 2000);
  assert(plan.coverage.baseline.guards.length > 100);
  assert(
    plan.coverage.baseline.testFiles.includes('apps/companion/scripts/agentic/identity.test.sh'),
  );
  assert.deepEqual(plan.coverage.diff, {
    missingFiles: [],
    addedFiles: [],
    missingGuards: [],
    addedGuards: [],
  });
  assert(plan.jobs.some((job) => job.node24 && job.tasks.some((task) => task.node === 24)));
  assert(plan.desktop.tasks.every((task) => task.platform === 'darwin'));
});

test('generated docs cannot pass a clean-tree guard in a different or earlier checkout stage', () => {
  const moved = structuredClone(plan);
  const owner = moved.jobs.find((job) =>
    job.tasks.some((task) => task.command.includes('apps/docs/docs')),
  );
  const index = owner.tasks.findIndex((task) => task.command.includes('apps/docs/docs'));
  const [clean] = owner.tasks.splice(index, 1);
  moved.jobs.find((job) => job.id.startsWith('guards-') && job !== owner).tasks.push(clean);
  assert.throws(() => assertCoverage(moved, root), /share a checkout/);
  const reordered = structuredClone(plan);
  const pipeline = reordered.jobs.find((job) =>
    job.tasks.some((task) => task.command.includes('apps/docs/docs')),
  );
  const position = pipeline.tasks.findIndex((task) => task.command.includes('apps/docs/docs'));
  pipeline.tasks.unshift(...pipeline.tasks.splice(position, 1));
  assert.throws(() => assertCoverage(reordered, root), /follow the generators/);
});

for (const [label, mutate] of [
  ['gateway shard', (copy) => copy.jobs.shift()],
  ['guard', (copy) => copy.jobs.find((entry) => entry.id.startsWith('guards-')).tasks.shift()],
  [
    'Node24 gate',
    (copy) => {
      for (const job of copy.jobs) job.tasks = job.tasks.filter((task) => task.node !== 24);
    },
  ],
  [
    'compiler owner',
    (copy) => {
      copy.prerequisites = false;
    },
  ],
]) {
  test(`coverage proof rejects a missing ${label}`, () => {
    const copy = structuredClone(plan);
    mutate(copy);
    assert.throws(() => assertCoverage(copy, root), /coverage differs/);
  });
}

test('coverage is derived from executable commands, not stored assignment claims', () => {
  const copy = structuredClone(plan);
  copy.jobs[0].tasks[0].command = 'true';
  assert.throws(() => assertCoverage(copy, root), /coverage differs/);
  const changedConfig = structuredClone(plan);
  changedConfig.jobs[0].tasks[0].command = changedConfig.jobs[0].tasks[0].command.replace(
    "'tsconfig.json'",
    "'other.json'",
  );
  assert.throws(() => assertCoverage(changedConfig, root), /coverage differs/);
});

test('an extra copy of a shard cannot hide behind set-based coverage parity', () => {
  const copy = structuredClone(plan);
  copy.jobs[1].tasks.push(structuredClone(copy.jobs[0].tasks[0]));
  assert.throws(() => assertCoverage(copy, root), /Duplicate full CI task/);
});

test('shell inventory never splits quoted JavaScript or globs into tasks', () => {
  const source = `node -e "console.log('a && b')" && eslint 'src/**/*.ts' && node -e "console.log('\\s')"`;
  const commands = shellCommands(source);
  assert.equal(commands.length, 3);
  assert.equal(commands[0].words[2], "console.log('a && b')");
  assert.equal(commands[1].words[1], 'src/**/*.ts');
  assert.equal(commands[2].words[2], "console.log('\\s')");
});

test('directory-changing scripts execute in the same location after decomposition', (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), 'ci-command-cwd-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  mkdirSync(path.join(directory, 'child'));
  writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ workspaces: [] }));
  const source = 'cd child && pwd -P';
  const original = spawnSync('bash', ['-ec', source], { cwd: directory, encoding: 'utf8' });
  const [task] = commandCatalog(directory).expand(source);
  const decomposed = spawnSync('bash', ['-ec', task.command], {
    cwd: path.join(directory, task.cwd),
    encoding: 'utf8',
  });
  assert.equal(original.status, 0, original.stderr);
  assert.equal(decomposed.status, 0, decomposed.stderr);
  assert.equal(decomposed.stdout, original.stdout);
});

test('main matrix and nightly audit are separate; nightly failures have a visible alert', () => {
  const main = readFileSync(path.join(root, '.github/workflows/farmslot-full-quality.yml'), 'utf8');
  const nightly = readFileSync(
    path.join(root, '.github/workflows/farmslot-nightly-parity.yml'),
    'utf8',
  );
  assert.match(main, /max-parallel: 8/);
  assert.doesNotMatch(main, /continue-on-error: true|schedule:/);
  assert.match(nightly, /schedule:/);
  for (const command of [
    'yarn ci:local',
    'yarn quality',
    'node scripts/quality/ci-full-supplement.mjs',
    'yarn cc:build:pages',
  ])
    assert(nightly.includes(command));
  assert.match(nightly, /needs: \[full, desktop\]/);
  assert.match(
    nightly,
    /needs\.full\.result == 'failure' \|\| needs\.desktop\.result == 'failure'/,
  );
  assert.match(nightly, /issues: write/);
  assert.match(nightly, /await notifyNightlyFailure\(github, context\)/);
  assert.doesNotMatch(nightly, /continue-on-error: true/);
});
