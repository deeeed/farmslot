import assert from 'node:assert/strict';
import test from 'node:test';

import type { ScriptedRunnerConfig } from '@farmslot/protocol';

import {
  assertScriptedRunnerConfig,
  scriptedCommandForRunner,
  scriptedRelaunchOptions,
} from './scripted-config.js';

const scenario: ScriptedRunnerConfig = { mode: 'scenario', scenario: 'success' };
const command: ScriptedRunnerConfig = { mode: 'command', commandRef: 'work' };
const projectJson = { scripted: { commands: { work: { command: 'run', timeout_ms: 5 } } } };

test('recovery behaviours use the same scenario feature gate', () => {
  for (const scenario of [
    'silent',
    'late-ack',
    'commit-out-of-band',
    'edit-forbidden-file',
  ] as const) {
    const params = {
      runner: 'scripted',
      projectName: 'p',
      scripted: { mode: 'scenario' as const, scenario, stepDelayMs: 1 },
    };
    assert.doesNotThrow(() =>
      assertScriptedRunnerConfig({ ...params, env: { FARMSLOT_ENABLE_SCRIPTED_SCENARIOS: '1' } }),
    );
    assert.throws(
      () => assertScriptedRunnerConfig({ ...params, env: {} }),
      /FARMSLOT_ENABLE_SCRIPTED_SCENARIOS/,
    );
  }
});

test('only a scripted worker in command mode names a project command', () => {
  assert.deepEqual(scriptedCommandForRunner('scripted', command, projectJson, 'p'), {
    command: 'run',
    timeoutMs: 5,
  });
  assert.equal(scriptedCommandForRunner('claude', command, projectJson, 'p'), undefined);
  assert.equal(scriptedCommandForRunner('scripted', scenario, projectJson, 'p'), undefined);
  assert.throws(
    () => scriptedCommandForRunner('scripted', command, {}, 'p'),
    /commandRef 'work' is not declared for project p/,
  );
});

test('a relaunch keeps a scripted worker config and gives other runners none', async () => {
  const run = { project: 'p', scripted: scenario };
  assert.deepEqual(await scriptedRelaunchOptions('scripted', run), { scripted: scenario });
  assert.deepEqual(await scriptedRelaunchOptions('claude', run), {});
  assert.deepEqual(await scriptedRelaunchOptions('scripted', null), {});
});

test('a relaunch that cannot load its project says so, not that the command is undeclared', async () => {
  await assert.rejects(
    scriptedRelaunchOptions('scripted', { project: 'no-such-project', scripted: command }),
    (error: Error) => !/not declared/.test(error.message),
  );
});
