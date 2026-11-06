import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  test(`scripted ${scenario} writes its promised evidence`, { timeout: 3000 }, async (t) => {
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

test(
  'late-ack consumes a delivered prompt and delays its acknowledgement',
  { timeout: 3000 },
  async (t) => {
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
    const root = new URL('../../../../', import.meta.url).pathname;
    const child = spawn(
      process.execPath,
      [
        path.join(root, 'packages/cli/bin/farmslot.mjs'),
        'scripted-runner',
        '--mode',
        'scenario',
        '--scenario',
        'late-ack',
        '--step-delay-ms',
        '100',
        '--task-dir',
        task,
      ],
      {
        cwd: dir,
        env: {
          ...process.env,
          FARMSLOT_ROOT: root,
          FARMSLOT_ENABLE_SCRIPTED_SCENARIOS: '1',
          TMUX_PANE: '%88',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let output = '';
    child.stderr.on('data', (data) => {
      output += data;
    });
    t.after(async () => {
      if (child.exitCode === null && child.signalCode === null) {
        const closed = new Promise<void>((resolve) => child.once('exit', () => resolve()));
        child.kill('SIGTERM');
        await closed;
      }
      rmSync(dir, { recursive: true, force: true });
    });
    const sessionDir = path.join(dir, '.agent', 'scripted-88');
    const receipt = path.join(sessionDir, 'session.json');
    const wait = async (predicate: () => boolean) => {
      const deadline = Date.now() + 2000;
      while (!predicate()) {
        assert.ok(child.exitCode === null, output);
        assert.ok(Date.now() < deadline, output || 'scripted session deadline');
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    };
    await wait(() => existsSync(receipt));
    assert.equal(
      JSON.parse(readFileSync(path.join(task, 'SIGNAL.json'), 'utf8')).status,
      'complete',
    );
    writeFileSync(
      path.join(sessionDir, 'prompt.json'),
      JSON.stringify({ prompt: 'Read REVIEW-FIX.md', taskDir: task }),
    );
    await wait(() => JSON.parse(readFileSync(receipt, 'utf8')).active);
    const activeAt = JSON.parse(readFileSync(receipt, 'utf8')).observedAt;
    assert.equal(existsSync(path.join(task, 'ack')), false);
    await wait(() => JSON.parse(readFileSync(receipt, 'utf8')).acknowledged);
    const accepted = JSON.parse(readFileSync(receipt, 'utf8'));
    assert.ok(accepted.observedAt - activeAt >= 100);
    assert.equal(readFileSync(path.join(task, 'ack'), 'utf8'), 'complete');
    assert.equal(git('show', '--format=', '--name-only', 'HEAD'), 'scripted-change.txt');
    // A stop during a turn must settle that turn before the session exits.
    writeFileSync(
      path.join(sessionDir, 'prompt.json'),
      JSON.stringify({ prompt: 'Read REVIEW-FIX.md again', taskDir: task }),
    );
    await wait(() => JSON.parse(readFileSync(receipt, 'utf8')).active);
    const closed = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    child.kill('SIGTERM');
    await closed;
    assert.equal(JSON.parse(readFileSync(receipt, 'utf8')).acknowledged, true);
  },
);
