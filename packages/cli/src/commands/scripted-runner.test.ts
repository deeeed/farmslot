import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { runScriptedRunner } from './scripted-runner.js';

function makeTaskDir(): string {
  return mkdtempSync(path.join(tmpdir(), 'farmslot-scripted-runner-'));
}

function makeFarmslotRoot(projectName: string, command: string): string {
  const root = mkdtempSync(path.join(tmpdir(), 'farmslot-scripted-root-'));
  mkdirSync(path.join(root, 'packages/cli'), { recursive: true });
  writeFileSync(path.join(root, 'packages/cli/package.json'), '{"version":"0.0.0-test"}\n');
  mkdirSync(path.join(root, 'projects', projectName), { recursive: true });
  writeFileSync(
    path.join(root, 'projects', projectName, 'project.json'),
    `${JSON.stringify(
      {
        name: projectName,
        scripted: {
          commands: {
            'fail-smoke': { command },
          },
        },
      },
      null,
      2,
    )}\n`,
  );
  return root;
}

test('scripted scenario success writes report, provenance, and terminal success signal', async (t) => {
  const taskDir = makeTaskDir();
  const previousFlag = process.env.FARMSLOT_ENABLE_SCRIPTED_SCENARIOS;
  process.env.FARMSLOT_ENABLE_SCRIPTED_SCENARIOS = '1';
  t.after(() => {
    if (previousFlag === undefined) delete process.env.FARMSLOT_ENABLE_SCRIPTED_SCENARIOS;
    else process.env.FARMSLOT_ENABLE_SCRIPTED_SCENARIOS = previousFlag;
    rmSync(taskDir, { recursive: true, force: true });
  });

  const exitCode = await runScriptedRunner({
    taskDir,
    mode: 'scenario',
    scenario: 'success',
    stepDelayMs: 0,
  });

  assert.equal(exitCode, 0);
  const signal = JSON.parse(await readFile(path.join(taskDir, 'SIGNAL.json'), 'utf-8'));
  assert.equal(signal.status, 'complete');
  assert.equal(signal.outcome, 'success');
  assert.equal(existsSync(path.join(taskDir, 'artifacts/report.md')), true);
  assert.equal(existsSync(path.join(taskDir, 'artifacts/scripted-runner-provenance.json')), true);
});

test('scripted scenario rejects without dev feature flag', async (t) => {
  const taskDir = makeTaskDir();
  const previousFlag = process.env.FARMSLOT_ENABLE_SCRIPTED_SCENARIOS;
  delete process.env.FARMSLOT_ENABLE_SCRIPTED_SCENARIOS;
  t.after(() => {
    if (previousFlag === undefined) delete process.env.FARMSLOT_ENABLE_SCRIPTED_SCENARIOS;
    else process.env.FARMSLOT_ENABLE_SCRIPTED_SCENARIOS = previousFlag;
    rmSync(taskDir, { recursive: true, force: true });
  });

  await assert.rejects(
    () => runScriptedRunner({ taskDir, mode: 'scenario', scenario: 'success', stepDelayMs: 0 }),
    /FARMSLOT_ENABLE_SCRIPTED_SCENARIOS=1/,
  );
});

test('scripted command failure resolves project-owned commandRef evidence', async (t) => {
  const taskDir = makeTaskDir();
  const projectName = 'scripted-test-project';
  const farmslotRoot = makeFarmslotRoot(projectName, 'printf command-output && exit 7');
  const previousRoot = process.env.FARMSLOT_ROOT;
  process.env.FARMSLOT_ROOT = farmslotRoot;
  t.after(() => {
    if (previousRoot === undefined) delete process.env.FARMSLOT_ROOT;
    else process.env.FARMSLOT_ROOT = previousRoot;
    rmSync(taskDir, { recursive: true, force: true });
    rmSync(farmslotRoot, { recursive: true, force: true });
  });

  const exitCode = await runScriptedRunner({
    taskDir,
    mode: 'command',
    project: projectName,
    commandRef: 'fail-smoke',
  });

  assert.equal(exitCode, 7);
  const signal = JSON.parse(await readFile(path.join(taskDir, 'SIGNAL.json'), 'utf-8'));
  assert.equal(signal.status, 'failed');
  assert.equal(signal.outcome, 'failure');
  const stdout = await readFile(
    path.join(taskDir, 'artifacts/scripted-command.stdout.txt'),
    'utf-8',
  );
  assert.equal(stdout, 'command-output');
  const result = JSON.parse(
    await readFile(path.join(taskDir, 'artifacts/scripted-command-result.json'), 'utf-8'),
  );
  assert.equal(result.project, projectName);
  assert.equal(result.commandRef, 'fail-smoke');
  assert.equal(result.exitCode, 7);
});

test('scripted command uses support-only config and the executing CLI provenance', async (t) => {
  const taskDir = makeTaskDir();
  const support = mkdtempSync(path.join(tmpdir(), 'scripted-support-only-'));
  const project = 'scripted-product';
  mkdirSync(path.join(support, 'projects', project), { recursive: true });
  writeFileSync(
    path.join(support, 'projects', project, 'project.json'),
    JSON.stringify({
      scripted: {
        commands: {
          check: {
            command:
              'printf %s "$FARMSLOT_TASK_DIR" > "$FARMSLOT_TASK_DIR/artifacts/observed-task.txt"; printf supported-command',
          },
        },
      },
    }),
  );
  const previous = process.env.FARMSLOT_ROOT;
  const previousTask = process.env.FARMSLOT_TASK_DIR;
  process.env.FARMSLOT_TASK_DIR = '/foreign-task';
  process.env.FARMSLOT_ROOT = support;
  t.after(() => {
    if (previousTask === undefined) delete process.env.FARMSLOT_TASK_DIR;
    else process.env.FARMSLOT_TASK_DIR = previousTask;
    if (previous === undefined) delete process.env.FARMSLOT_ROOT;
    else process.env.FARMSLOT_ROOT = previous;
    rmSync(taskDir, { recursive: true, force: true });
    rmSync(support, { recursive: true, force: true });
  });
  assert.equal(
    await runScriptedRunner({ taskDir, mode: 'command', project, commandRef: 'check' }),
    0,
  );
  assert.equal(
    await readFile(path.join(taskDir, 'artifacts/observed-task.txt'), 'utf8'),
    path.resolve(taskDir),
  );
  assert.equal(process.env.FARMSLOT_TASK_DIR, '/foreign-task');
  const provenance = JSON.parse(
    await readFile(path.join(taskDir, 'artifacts/scripted-runner-provenance.json'), 'utf8'),
  );
  assert.equal(provenance.farmslotRoot, support);
  assert.notEqual(provenance.cliRoot, support);
  assert.equal(typeof provenance.packageVersion, 'string');
  assert.equal(
    await readFile(path.join(taskDir, 'artifacts/scripted-command.stdout.txt'), 'utf8'),
    'supported-command',
  );
  assert.equal(
    JSON.parse(await readFile(path.join(taskDir, 'SIGNAL.json'), 'utf8')).outcome,
    'success',
  );
});

for (const scenario of ['silent', 'commit-out-of-band', 'edit-forbidden-file'] as const) {
  test(`scripted ${scenario} writes its promised evidence`, async (t) => {
    const dir = makeTaskDir();
    const previous = process.env.FARMSLOT_ENABLE_SCRIPTED_SCENARIOS;
    const cwd = process.cwd();
    process.env.FARMSLOT_ENABLE_SCRIPTED_SCENARIOS = '1';
    process.chdir(dir);
    t.after(() => {
      process.chdir(cwd);
      if (previous === undefined) delete process.env.FARMSLOT_ENABLE_SCRIPTED_SCENARIOS;
      else process.env.FARMSLOT_ENABLE_SCRIPTED_SCENARIOS = previous;
      rmSync(dir, { recursive: true, force: true });
    });
    const git = (...args: string[]) =>
      execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
    git('init', '-q', '-b', 'main');
    git(
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      'commit',
      '--allow-empty',
      '-qm',
      'seed',
    );
    const before = git('rev-parse', 'HEAD');
    const commits = scenario === 'commit-out-of-band' || scenario === 'edit-forbidden-file';
    if (commits) {
      writeFileSync(path.join(dir, 'unrelated.txt'), 'already staged\n');
      git('add', 'unrelated.txt');
    }
    const states: string[] = [];
    assert.equal(
      await runScriptedRunner(
        { taskDir: dir, mode: 'scenario', scenario, stepDelayMs: 1 },
        {
          writeTextFile: async (file, content) => {
            if (file === path.join(dir, 'SIGNAL.json')) states.push(JSON.parse(content).status);
            await mkdir(path.dirname(file), { recursive: true });
            await writeFile(file, content);
          },
        },
      ),
      0,
    );
    if (scenario === 'silent') assert.equal(existsSync(path.join(dir, 'SIGNAL.json')), false);
    else
      assert.equal(
        JSON.parse(await readFile(path.join(dir, 'SIGNAL.json'), 'utf8')).status,
        'complete',
      );
    if (commits) {
      assert.notEqual(git('rev-parse', 'HEAD'), before);
      assert.equal(
        git('show', '--format=', '--name-only', 'HEAD'),
        scenario === 'commit-out-of-band'
          ? 'scripted-change.txt'
          : '.github/workflows/scripted.yml',
      );
      assert.equal(git('diff', '--cached', '--name-only'), 'unrelated.txt');
    }
  });
}

test('late-ack consumes a delivered prompt and delays its acknowledgement', async (t) => {
  const dir = makeTaskDir();
  const task = path.join(dir, 'task');
  mkdirSync(task);
  writeFileSync(path.join(task, 'REVIEW-FIX.md'), '# Fix\n\n- [ ] Apply the fixture fix.\n');
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Fixture');
  git('config', 'user.email', 'fixture@example.invalid');
  git('-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-qm', 'seed');
  writeFileSync(
    path.join(task, 'mark'),
    '#!/bin/sh\ncase "$*" in *complete*) printf complete > "' + task + '/ack" ;; esac\n',
    { mode: 0o755 },
  );
  const previousCwd = process.cwd();
  const previousEnv = {
    FARMSLOT_ROOT: process.env.FARMSLOT_ROOT,
    FARMSLOT_ENABLE_SCRIPTED_SCENARIOS: process.env.FARMSLOT_ENABLE_SCRIPTED_SCENARIOS,
    TMUX_PANE: process.env.TMUX_PANE,
  };
  process.env.FARMSLOT_ROOT = new URL('../../../../', import.meta.url).pathname;
  process.env.FARMSLOT_ENABLE_SCRIPTED_SCENARIOS = '1';
  process.env.TMUX_PANE = '%88';
  process.chdir(dir);
  // Stays true until the session starts, so teardown only drives a live runner.
  let exited = true;
  // One hook: stop the session before restoring cwd/env, or a failed test could leave it
  // writing into the caller's checkout on real timers once the mocks are reset.
  t.after(async () => {
    const hangAt = performance.now() + 30_000;
    while (!exited && performance.now() < hangAt) {
      process.emit('SIGTERM');
      t.mock.timers.runAll();
      await new Promise((resolve) => setImmediate(resolve));
    }
    process.chdir(previousCwd);
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  });
  // Fake clock: each scripted delay advances only when the test ticks it.
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000 });
  const scheduled = t.mock.method(globalThis, 'setTimeout');
  const delays = () => scheduled.mock.calls.filter((call) => call.arguments[1] === 100).length;
  // fs.watch and git child processes are real I/O; yield the event loop until they settle.
  // Mocked timers also stop node:test's own timeout, so bound a hang on the unmocked
  // monotonic clock. This guard only catches regressions; it gates no scripted delay.
  const settle = async (predicate: () => boolean) => {
    const hangAt = performance.now() + 30_000;
    while (!predicate()) {
      // Surface the session's own failure instead of waiting for the hang guard.
      if (exited) await runner;
      assert.ok(performance.now() < hangAt, 'late-ack session stopped making progress');
      await new Promise((resolve) => setImmediate(resolve));
    }
  };
  const runner = runScriptedRunner({
    taskDir: task,
    mode: 'scenario',
    scenario: 'late-ack',
    stepDelayMs: 100,
  });
  exited = false;
  const markExited = () => {
    exited = true;
  };
  void runner.then(markExited, markExited);
  const sessionDir = path.join(dir, '.agent', 'scripted-88');
  const receipt = path.join(sessionDir, 'session.json');
  const readReceipt = () => JSON.parse(readFileSync(receipt, 'utf8'));
  const deliverPrompt = (prompt: string) => {
    // Match the gateway sender: publish complete JSON to the watched inbox atomically.
    const pending = path.join(sessionDir, 'prompt.pending');
    writeFileSync(pending, JSON.stringify({ prompt, taskDir: task }));
    renameSync(pending, path.join(sessionDir, 'prompt.json'));
  };

  await settle(() => delays() === 1);
  t.mock.timers.tick(100);
  await settle(() => existsSync(receipt));
  assert.equal(JSON.parse(readFileSync(path.join(task, 'SIGNAL.json'), 'utf8')).status, 'complete');
  deliverPrompt('Read REVIEW-FIX.md');
  await settle(() => delays() === 2);
  const active = readReceipt();
  assert.equal(active.active, true);
  t.mock.timers.tick(99);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(existsSync(path.join(task, 'ack')), false);
  t.mock.timers.tick(1);
  await settle(() => readReceipt().acknowledged);
  const accepted = readReceipt();
  assert.equal(accepted.observedAt - active.observedAt, 100);
  assert.equal(readFileSync(path.join(task, 'ack'), 'utf8'), 'complete');
  assert.equal(git('show', '--format=', '--name-only', 'HEAD'), 'scripted-change.txt');
  // A stop during a turn must settle that turn before the session exits.
  deliverPrompt('Read REVIEW-FIX.md again');
  await settle(() => delays() === 3);
  assert.equal(readReceipt().acknowledged, false);
  process.emit('SIGTERM');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(exited, false);
  t.mock.timers.tick(100);
  assert.equal(await runner, 0);
  assert.equal(readReceipt().acknowledged, true);
});
