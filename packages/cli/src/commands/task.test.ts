import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { Command } from 'commander';

import { retainTaskExecution } from '../../../agent-runtime/src/task-init/execution-provenance.js';

import { commandTree } from './completion.js';
import { registerRecipeQualityCommand } from './recipe-quality.js';
import { registerReviewCommand } from './review.js';
import { registerTaskCommand, runTaskCommand, taskHelperArgv } from './task.js';

function cli(): Command {
  const program = new Command().exitOverride().option('--json');
  program.configureOutput({ writeOut() {}, writeErr() {} });
  registerTaskCommand(program);
  registerReviewCommand(program);
  registerRecipeQualityCommand(program.command('recipe'));
  return program;
}

test('canonical helper names appear in grammar and generated completions', () => {
  const tree = commandTree(cli());
  assert.deepEqual(
    tree.find((entry) => entry.name === 'task')?.subs.map((entry) => entry.name),
    ['init', 'verify', 'repin', 'mark', 'closeout'],
  );
  assert.deepEqual(
    tree.find((entry) => entry.name === 'review')?.subs.map((entry) => entry.name),
    ['checklist', 'domain'],
  );
  assert.deepEqual(
    tree
      .find((entry) => entry.name === 'recipe')
      ?.subs.find((entry) => entry.name === 'quality')
      ?.subs.map((entry) => entry.name),
    ['build', 'plan', 'advise', 'advisor-status'],
  );
  assert.equal(
    tree.some((entry) => ['checklist', 'recipe-quality'].includes(entry.name)),
    false,
  );
});

test('invalid marker and unknown flags refuse before reading a task or provider', async () => {
  await assert.rejects(
    cli().parseAsync(['task', 'mark', '/missing/task', 'invalid'], { from: 'user' }),
    { code: 'commander.invalidArgument' },
  );
  await assert.rejects(
    cli().parseAsync(['task', 'mark', '/missing/task', '1', '--unsupported'], { from: 'user' }),
    { code: 'commander.unknownOption' },
  );
  await assert.rejects(
    cli().parseAsync(['task', 'init', '/missing/task', '--title', 'Task'], { from: 'user' }),
    { code: 'commander.missingMandatoryOptionValue' },
  );
});

test('mark forwarding preserves explicit negation and consumes binding controls', async () => {
  for (const negate of [false, true]) {
    const program = cli();
    const mark = program.commands
      .find((entry) => entry.name() === 'task')!
      .commands.find((entry) => entry.name() === 'mark')!;
    let forwarded: string[] = [];
    mark.action(() => {
      forwarded = taskHelperArgv(mark);
    });
    await program.parseAsync(
      [
        '--json',
        'task',
        'mark',
        'task-dir',
        'complete',
        '--adapter',
        'headless',
        '--mark-last',
        ...(negate ? ['--no-review'] : []),
      ],
      { from: 'user' },
    );
    assert.deepEqual(forwarded, [
      'task-dir',
      'complete',
      '--mark-last',
      ...(negate ? ['--no-review'] : []),
      '--json',
    ]);
  }
});

test('a missing explicit project refuses before creating an unbound task', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'task-project-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const registry = path.join(root, 'projects');
  fs.mkdirSync(registry);
  const task = path.join(root, 'task');
  const program = cli();
  const init = program.commands
    .find((entry) => entry.name() === 'task')!
    .commands.find((entry) => entry.name() === 'init')!;
  init.action(() => {});
  await program.parseAsync(
    [
      'task',
      'init',
      task,
      '--project',
      'not-registered',
      '--projects-dir',
      registry,
      '--target',
      root,
      '--flow',
      'dev',
      '--template',
      'dev/worker',
      '--title',
      'Selected project',
    ],
    { from: 'user' },
  );
  await assert.rejects(runTaskCommand('init', init), { code: 'PROJECT_NOT_FOUND', exitCode: 2 });
  assert.equal(fs.existsSync(task), false);
  assert.deepEqual(fs.readdirSync(root), ['projects']);
});

for (const selection of ['runtime binding', 'pool slot']) {
  test(`a missing project from ${selection} cannot create an unbound task`, async (t) => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'task-project-')));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const registry = path.join(root, 'projects');
    const pool = path.join(root, 'pool');
    fs.mkdirSync(registry);
    fs.mkdirSync(pool);
    const previousPool = process.env.FARMSLOT_POOL_DIR;
    const previousContext = process.env.RECIPE_RUNTIME_CONTEXT;
    process.env.FARMSLOT_POOL_DIR = pool;
    delete process.env.RECIPE_RUNTIME_CONTEXT;
    t.after(() => {
      if (previousPool === undefined) delete process.env.FARMSLOT_POOL_DIR;
      else process.env.FARMSLOT_POOL_DIR = previousPool;
      if (previousContext === undefined) delete process.env.RECIPE_RUNTIME_CONTEXT;
      else process.env.RECIPE_RUNTIME_CONTEXT = previousContext;
    });
    if (selection === 'runtime binding') {
      const runtime = path.join(root, 'temp/recipe/runtime');
      fs.mkdirSync(runtime, { recursive: true });
      fs.writeFileSync(
        path.join(runtime, 'agentic-runtime.json'),
        JSON.stringify({ repoRoot: root, project: 'not-registered' }),
      );
    } else {
      fs.writeFileSync(
        path.join(pool, 'local.json'),
        JSON.stringify({
          host: 'localhost',
          slots: [{ id: 'one', repo: root, project: 'not-registered' }],
        }),
      );
    }
    const task = path.join(root, 'task');
    const program = cli();
    const init = program.commands
      .find((entry) => entry.name() === 'task')!
      .commands.find((entry) => entry.name() === 'init')!;
    init.action(() => {});
    await program.parseAsync(
      [
        'task',
        'init',
        task,
        '--projects-dir',
        registry,
        '--target',
        root,
        '--flow',
        'dev',
        '--template',
        'dev/worker',
        '--title',
        'Inherited project',
      ],
      { from: 'user' },
    );
    await assert.rejects(runTaskCommand('init', init), {
      code: 'PROJECT_NOT_FOUND',
      exitCode: 2,
      selectedProject: 'not-registered',
    });
    assert.equal(fs.existsSync(task), false);
  });
}

test('initializing a retained task again preserves its receipt and authored files', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'task-resume-'));
  const previousFarmHome = process.env.FARMSLOT_HOME;
  process.env.FARMSLOT_HOME = path.join(root, 'pins');
  t.after(() => {
    if (previousFarmHome === undefined) delete process.env.FARMSLOT_HOME;
    else process.env.FARMSLOT_HOME = previousFarmHome;
  });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const installed = path.join(root, 'installed');
  const task = path.join(root, 'task');
  fs.mkdirSync(installed);
  fs.writeFileSync(
    path.join(installed, 'package.json'),
    '{"name":"@farmslot/cli","version":"1.0.0"}',
  );
  fs.writeFileSync(path.join(installed, 'farmslot'), '#!/usr/bin/env node\n');
  retainTaskExecution(task, {
    executable: path.join(installed, 'farmslot'),
    packageRoot: installed,
    distributionRoot: installed,
    bindingIdentity: null,
    inputs: [],
    selectedConfiguration: '{"identity":null}',
  });
  const report = path.join(task, 'TASK.md');
  fs.writeFileSync(report, 'Retained authored task');
  const receipt = fs.readFileSync(path.join(task, 'artifacts/harness-provenance.json'), 'utf8');
  const program = cli();
  const init = program.commands
    .find((entry) => entry.name() === 'task')!
    .commands.find((entry) => entry.name() === 'init')!;
  init.action(() => {});
  await program.parseAsync(
    ['task', 'init', task, '--flow', 'dev', '--template', 'dev/worker', '--title', 'Changed title'],
    { from: 'user' },
  );
  await assert.rejects(runTaskCommand('init', init), { exitCode: 2 });
  assert.equal(fs.readFileSync(report, 'utf8'), 'Retained authored task');
  assert.equal(
    fs.readFileSync(path.join(task, 'artifacts/harness-provenance.json'), 'utf8'),
    receipt,
  );
});

test('current SDK operator, child and completion grammar forwards without aliases', async () => {
  for (const args of [
    ['wait', '--who', 'operator', '--reason', 'review setup'],
    ['resume'],
    [
      'sub',
      'start',
      'child',
      '--step',
      '1',
      '--from',
      'inline:Child',
      '--var',
      'ONE=1',
      '--var',
      'TWO=2',
    ],
    ['sub', 'child', 'complete', '--report', 'artifacts/child.md'],
    ['complete', '--no-review'],
  ]) {
    const program = cli();
    const mark = program.commands
      .find((entry) => entry.name() === 'task')!
      .commands.find((entry) => entry.name() === 'mark')!;
    let forwarded: string[] = [];
    mark.action(() => {
      forwarded = taskHelperArgv(mark);
    });
    await program.parseAsync(['task', 'mark', 'task-dir', ...args], { from: 'user' });
    assert.equal(forwarded[0], 'task-dir');
    assert.equal(forwarded[1], args[0]);
    for (const flag of ['--who', '--report', '--no-review'])
      assert.equal(forwarded.includes(flag), args.includes(flag));
    if (args.includes('--var'))
      assert.deepEqual(
        forwarded.filter((value, index) => forwarded[index - 1] === '--var'),
        ['ONE=1', 'TWO=2'],
      );
  }
});
