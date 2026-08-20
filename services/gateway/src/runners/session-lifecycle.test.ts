import assert from 'node:assert/strict';
import test from 'node:test';

import type { MachinePauseRecoveryHandle } from '@farmslot/protocol';

import { RUNNER_LAUNCH_READY_TIMEOUT_MS } from './launch-command.js';
import {
  inspectRunnerRecovery,
  reloadRunnerForPark,
  RUNNER_PARK_GRACEFUL_EXIT_TIMEOUT_MS,
  RUNNER_PARK_RELOAD_ACCEPTANCE_TIMEOUT_MS,
  runnerRunningForPark,
  stopRunnerForPark,
} from './session-lifecycle.js';
import { makeVars } from './test-fixtures.js';

const vars = makeVars({
  remoteRepo: '/tmp/repo',
  slotId: 'slot-1',
  machine: 'machine-1',
  projectName: 'project-1',
  claudePath: '/opt/bin/claude',
});

const handle: MachinePauseRecoveryHandle = {
  version: 1,
  runnerId: 'claude',
  contextId: 'primary',
  sessionId: 'session-123',
  sessionPath: '/sessions/session-123.jsonl',
  target: { session: 'slot-1', window: 'worker', target: 'slot-1:worker' },
  model: 'sonnet',
  safetyTier: 'dangerous',
  runtimeDir: 'runtime',
  taskDir: 'tasks/run-1',
  capturedAt: '2026-08-21T00:00:00.000Z',
};

test('park lifecycle timeout policy keeps exit bounded and reload on launch-ready budget', () => {
  assert.equal(RUNNER_PARK_GRACEFUL_EXIT_TIMEOUT_MS, 10_000);
  assert.equal(RUNNER_PARK_RELOAD_ACCEPTANCE_TIMEOUT_MS, RUNNER_LAUNCH_READY_TIMEOUT_MS);
  assert.ok(RUNNER_PARK_RELOAD_ACCEPTANCE_TIMEOUT_MS > RUNNER_PARK_GRACEFUL_EXIT_TIMEOUT_MS);
});

test('inspectRunnerRecovery requires aligned static capabilities and an available exact handle', async () => {
  const available = {
    exec: async (_vars: unknown, command: string) =>
      command.includes('list-panes')
        ? { exitCode: 0, stdout: '%1\t101\n', stderr: '' }
        : { exitCode: 0, stdout: '', stderr: '' },
    findRunnerPid: async () => '202',
  };
  for (const runnerId of ['claude', 'codex', 'grok']) {
    assert.equal(
      (
        await inspectRunnerRecovery(
          { vars, runnerId, recoveryHandle: { ...handle, runnerId } },
          available,
        )
      ).supported,
      true,
      `${runnerId} should expose aligned graceful-exit and session-reload capabilities`,
    );
  }
  const unsupported = await inspectRunnerRecovery(
    { vars, runnerId: 'cursor', recoveryHandle: { ...handle, runnerId: 'cursor' } },
    available,
  );
  assert.equal(unsupported.supported, false);
  assert.match(unsupported.reason ?? '', /no (graceful exit|persisted session reload) capability/);

  const mismatched = await inspectRunnerRecovery(
    { vars, runnerId: 'codex', recoveryHandle: handle },
    available,
  );
  assert.equal(mismatched.supported, false);
  assert.match(mismatched.reason ?? '', /does not match/);

  const unauditable = await inspectRunnerRecovery(
    {
      vars,
      runnerId: 'claude',
      recoveryHandle: { ...handle, capturedAt: 'not-a-timestamp' },
    },
    available,
  );
  assert.equal(unauditable.supported, false);
  assert.match(unauditable.reason ?? '', /capture time is invalid/);

  const missingRunner = await inspectRunnerRecovery(
    { vars, runnerId: '', recoveryHandle: handle },
    available,
  );
  assert.equal(missingRunner.supported, false);
  assert.match(missingRunner.reason ?? '', /runner id is missing/);
});

test('inspectRunnerRecovery fails closed for zero, ambiguous, and uninspectable live targets', async () => {
  type InspectDeps = NonNullable<Parameters<typeof inspectRunnerRecovery>[1]>;
  const inspect = (deps: InspectDeps) =>
    inspectRunnerRecovery({ vars, runnerId: 'claude', recoveryHandle: handle }, deps);

  const noLive = await inspect({
    exec: async (_vars, command) =>
      command.includes('list-panes')
        ? { exitCode: 0, stdout: '%1\t101\n', stderr: '' }
        : { exitCode: 0, stdout: '', stderr: '' },
    findRunnerPid: async () => '',
  });
  assert.equal(noLive.supported, false);
  assert.match(noLive.reason ?? '', /has no live 'claude' process/);

  const ambiguous = await inspect({
    exec: async (_vars, command) =>
      command.includes('list-panes')
        ? { exitCode: 0, stdout: '%1\t101\n%2\t102\n', stderr: '' }
        : { exitCode: 0, stdout: '', stderr: '' },
    findRunnerPid: async (_vars, panePid) => `runner-${panePid}`,
  });
  assert.equal(ambiguous.supported, false);
  assert.match(ambiguous.reason ?? '', /ambiguous: found 2/);

  const uninspectable = await inspect({
    exec: async (_vars, command) =>
      command.includes('list-panes')
        ? { exitCode: 1, stdout: '', stderr: 'missing tmux target' }
        : { exitCode: 0, stdout: '', stderr: '' },
    findRunnerPid: async () => '',
  });
  assert.equal(uninspectable.supported, false);
  assert.match(uninspectable.reason ?? '', /uninspectable: missing tmux target/);
});

test('runnerRunningForPark reports structured residual liveness', async () => {
  const deps = {
    exec: async () => ({ exitCode: 0, stdout: '%1\t101\n', stderr: '' }),
    findRunnerPid: async () => '202',
    respawn: async () => {},
    sleep: async () => {},
  };
  assert.equal(
    await runnerRunningForPark({ vars, runnerId: 'claude', target: handle.target.target }, deps),
    'running',
  );
  assert.equal(
    await runnerRunningForPark({ vars, runnerId: '', target: handle.target.target }, deps),
    'unknown',
  );
});

test('stopRunnerForPark sends only the registry graceful-exit command and confirms exit', async () => {
  const commands: string[] = [];
  let probes = 0;
  const result = await stopRunnerForPark(
    { vars, runnerId: 'claude', target: handle.target.target, timeoutMs: 100 },
    {
      exec: async (_vars, command) => {
        commands.push(command);
        if (command.includes('list-panes')) {
          return { exitCode: 0, stdout: '%1\t101\n', stderr: '' };
        }
        return { exitCode: 0, stdout: '', stderr: '' };
      },
      findRunnerPid: async () => (++probes === 1 ? '202' : ''),
      respawn: async () => {},
      sleep: async () => {},
    },
  );
  assert.deepEqual(result, {
    ok: true,
    status: 'stopped',
    runnerId: 'claude',
    target: '%1',
    residualRunner: 'stopped',
  });
  assert.equal(
    commands.some((command) => command.includes("'/exit'")),
    true,
  );
  assert.equal(
    commands.some((command) => /kill -(TERM|KILL)/.test(command)),
    false,
  );
});

test('stopRunnerForPark applies the runner-owned Codex submit delay', async () => {
  const commands: string[] = [];
  let probes = 0;
  const result = await stopRunnerForPark(
    { vars, runnerId: 'codex', target: handle.target.target, timeoutMs: 100 },
    {
      exec: async (_vars, command) => {
        commands.push(command);
        return command.includes('list-panes')
          ? { exitCode: 0, stdout: '%1\t101\n', stderr: '' }
          : { exitCode: 0, stdout: '', stderr: '' };
      },
      findRunnerPid: async () => (++probes === 1 ? '202' : ''),
      respawn: async () => {},
      sleep: async () => {},
    },
  );
  assert.equal(result.ok, true);
  const exitCommand = commands.find((command) => command.includes("-l '/exit'"));
  assert.ok(exitCommand);
  assert.match(exitCommand, /-l '\/exit'[\s\S]*sleep 0[.]05[\s\S]*send-keys[^\n]*Enter/);
});

test('stopRunnerForPark fails closed when a window contains multiple matching runners', async () => {
  const commands: string[] = [];
  const result = await stopRunnerForPark(
    { vars, runnerId: 'claude', target: handle.target.target, timeoutMs: 100 },
    {
      exec: async (_vars, command) => {
        commands.push(command);
        return { exitCode: 0, stdout: '%1\t101\n%2\t102\n', stderr: '' };
      },
      findRunnerPid: async (_vars, panePid) => `runner-${panePid}`,
      respawn: async () => {},
      sleep: async () => {},
    },
  );
  assert.equal(result.ok, false);
  assert.equal(result.status, 'failed');
  assert.match(result.error, /Refusing ambiguous graceful exit/);
  assert.equal(
    commands.some((command) => command.includes("'/exit'")),
    false,
  );
});

test('reloadRunnerForPark probes and reloads the exact persisted session', async () => {
  let respawned = '';
  const result = await reloadRunnerForPark(
    { vars, recoveryHandle: handle, initialPrompt: 'Continue the parked run', timeoutMs: 100 },
    {
      exec: async (_vars, command) => {
        if (command.includes('test -e')) return { exitCode: 0, stdout: '', stderr: '' };
        if (command.includes('list-panes')) {
          return { exitCode: 0, stdout: '%1\t101\n', stderr: '' };
        }
        return { exitCode: 0, stdout: '', stderr: '' };
      },
      findRunnerPid: async () => '202',
      respawn: async (_vars, target, command) => {
        assert.equal(target, 'slot-1:worker');
        respawned = command;
      },
      writePromptSentinel: async () => ({ digest: 'digest', sentAt: 100 }),
      capturePromptBaseline: async () => 100,
      probePromptHandoff: async () => ({
        accepted: true,
        source: 'hook-digest',
        reason: 'exact prompt accepted',
        turnToken: 'session-123:turn-2',
      }),
      sleep: async () => {},
    },
  );
  assert.deepEqual(result, {
    ok: true,
    status: 'reloaded',
    runnerId: 'claude',
    target: 'slot-1:worker',
    sessionId: 'session-123',
    live: true,
    acknowledgement: {
      kind: 'structured',
      source: 'hook-digest',
      reason: 'exact prompt accepted',
      turnToken: 'session-123:turn-2',
    },
  });
  assert.match(respawned, /--resume 'session-123' 'Continue the parked run'/);
});

test('reloadRunnerForPark fails closed when the persisted session path is gone', async () => {
  let respawned = false;
  const result = await reloadRunnerForPark(
    { vars, recoveryHandle: handle, initialPrompt: 'Continue the parked run' },
    {
      exec: async () => ({ exitCode: 1, stdout: '', stderr: '' }),
      findRunnerPid: async () => '',
      respawn: async () => {
        respawned = true;
      },
      sleep: async () => {},
    },
  );
  assert.equal(result.ok, false);
  assert.equal(result.status, 'session-unavailable');
  assert.equal(respawned, false);
});

test('reloadRunnerForPark rejects an empty continuation prompt before respawn', async () => {
  let respawned = false;
  const result = await reloadRunnerForPark(
    { vars, recoveryHandle: handle, initialPrompt: '   ' },
    {
      exec: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      findRunnerPid: async () => '',
      respawn: async () => {
        respawned = true;
      },
      sleep: async () => {},
    },
  );
  assert.equal(result.ok, false);
  assert.equal(result.status, 'invalid-prompt');
  assert.equal(respawned, false);
});

test('reloadRunnerForPark times out without treating process liveness as prompt acceptance', async () => {
  const result = await reloadRunnerForPark(
    { vars, recoveryHandle: handle, initialPrompt: 'Continue exactly', timeoutMs: 1 },
    {
      exec: async (_vars, command) =>
        command.includes('list-panes')
          ? { exitCode: 0, stdout: '%1\t101\n', stderr: '' }
          : { exitCode: 0, stdout: '', stderr: '' },
      findRunnerPid: async () => '202',
      respawn: async () => {},
      writePromptSentinel: async () => ({ digest: 'digest', sentAt: 100 }),
      capturePromptBaseline: async () => 100,
      probePromptHandoff: async () => ({
        accepted: false,
        reason: 'runner prompt acceptance not observed',
      }),
      sleep: async () => {},
    },
  );
  assert.equal(result.ok, false);
  assert.equal(result.status, 'acceptance-failed');
  assert.match(result.error, /not accepted\/live/);
});
