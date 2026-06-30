import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
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
