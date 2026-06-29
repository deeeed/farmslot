import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { runScriptedRunner } from './scripted-runner.js';

function makeTaskDir(): string {
  return mkdtempSync(path.join(tmpdir(), 'farmslot-scripted-runner-'));
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

test('scripted command failure writes exit evidence and terminal failure signal', async (t) => {
  const taskDir = makeTaskDir();
  t.after(() => rmSync(taskDir, { recursive: true, force: true }));

  const exitCode = await runScriptedRunner({
    taskDir,
    mode: 'command',
    commandRef: 'fail-smoke',
    command: 'printf command-output && exit 7',
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
});
