import assert from 'node:assert/strict';
import test from 'node:test';

import type { MachinePauseRecoveryHandle } from '@farmslot/protocol';

import type { TmuxWindowRef } from '../core/tmux.js';

import { RUNNER_LAUNCH_READY_TIMEOUT_MS } from './launch-command.js';
import {
  inspectRunnerParkHost,
  inspectRunnerRecovery,
  rehostRunnerParkTarget,
  reloadRunnerForPark,
  RUNNER_PARK_GRACEFUL_EXIT_MIN_PROBES,
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
  target: {
    session: 'slot-1',
    window: 'worker',
    pane: '1',
    paneId: '%1',
    target: 'slot-1:worker',
  },
  model: 'sonnet',
  safetyTier: 'dangerous',
  runtimeDir: 'runtime',
  taskDir: 'tasks/run-1',
  capturedAt: '2026-08-21T00:00:00.000Z',
};
const EXACT_PANE_ROW = 'slot-1\tworker\t%1\t101\n';
/** Pane-scoped liveness for the graceful-exit poll: present until `liveProbes` are spent. */
const paneLiveness = (liveProbes: number) => {
  let seen = 0;
  return async () =>
    (seen++ < liveProbes ? { state: 'present', pid: '202' } : { state: 'absent' }) as
      | { state: 'present'; pid: string }
      | { state: 'absent' };
};
const paneStopped = async () => ({ state: 'absent' }) as const;
const verifyPersistedLiveBinding = async () =>
  ({
    ok: true,
    binding: {
      runnerSessionId: handle.sessionId,
      runnerSessionPath: handle.sessionPath,
      canonicalSessionPath: handle.sessionPath,
      source: 'native',
    },
  }) as const;

test('park lifecycle timeout policy keeps exit bounded and reload on launch-ready budget', () => {
  assert.equal(RUNNER_PARK_GRACEFUL_EXIT_TIMEOUT_MS, 10_000);
  assert.equal(RUNNER_PARK_RELOAD_ACCEPTANCE_TIMEOUT_MS, RUNNER_LAUNCH_READY_TIMEOUT_MS);
  assert.ok(RUNNER_PARK_RELOAD_ACCEPTANCE_TIMEOUT_MS > RUNNER_PARK_GRACEFUL_EXIT_TIMEOUT_MS);
});

test('inspectRunnerRecovery requires aligned static capabilities and an available exact handle', async () => {
  const available = {
    exec: async (_vars: unknown, command: string) =>
      command.includes('display-message')
        ? { exitCode: 0, stdout: EXACT_PANE_ROW, stderr: '' }
        : { exitCode: 0, stdout: '', stderr: '' },
    findRunnerPid: async () => '202',
    verifyLiveBinding: verifyPersistedLiveBinding,
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
      command.includes('display-message')
        ? { exitCode: 0, stdout: EXACT_PANE_ROW, stderr: '' }
        : { exitCode: 0, stdout: '', stderr: '' },
    findRunnerPid: async () => '',
  });
  assert.equal(noLive.supported, false);
  assert.match(noLive.reason ?? '', /is stopped; expected live 'claude' process/);

  const ambiguous = await inspect({
    exec: async (_vars, command) =>
      command.includes('display-message')
        ? { exitCode: 0, stdout: `${EXACT_PANE_ROW}${EXACT_PANE_ROW}`, stderr: '' }
        : { exitCode: 0, stdout: '', stderr: '' },
    findRunnerPid: async (_vars, panePid) => `runner-${panePid}`,
  });
  assert.equal(ambiguous.supported, false);
  assert.match(ambiguous.reason ?? '', /Expected one exact tmux pane %1, found 2/);

  const uninspectable = await inspect({
    exec: async (_vars, command) =>
      command.includes('display-message')
        ? { exitCode: 1, stdout: '', stderr: 'missing tmux target' }
        : { exitCode: 0, stdout: '', stderr: '' },
    findRunnerPid: async () => '',
  });
  assert.equal(uninspectable.supported, false);
  assert.match(uninspectable.reason ?? '', /uninspectable: missing tmux target/);

  const stoppedRestore = await inspectRunnerRecovery(
    {
      vars,
      runnerId: 'claude',
      recoveryHandle: handle,
      expectedRunnerState: 'stopped-or-live',
    },
    {
      exec: async (_vars, command) =>
        command.includes('display-message')
          ? { exitCode: 0, stdout: EXACT_PANE_ROW, stderr: '' }
          : { exitCode: 0, stdout: '', stderr: '' },
      findRunnerPid: async () => '',
    },
  );
  assert.equal(stoppedRestore.supported, true);
  assert.equal(stoppedRestore.liveTarget.state, 'stopped');
});

test('inspectRunnerRecovery rejects a new same-runner session in the exact persisted pane', async () => {
  const inspection = await inspectRunnerRecovery(
    { vars, runnerId: 'claude', recoveryHandle: handle, expectedRunnerState: 'stopped-or-live' },
    {
      exec: async (_vars, command) =>
        command.includes('display-message')
          ? { exitCode: 0, stdout: EXACT_PANE_ROW, stderr: '' }
          : { exitCode: 0, stdout: '', stderr: '' },
      findRunnerPid: async () => '202',
      verifyLiveBinding: async () => ({
        ok: false,
        reason: "active runner session id 'new-session' does not match persisted 'session-123'",
      }),
    },
  );
  assert.equal(inspection.supported, false);
  assert.equal(inspection.liveTarget.state, 'live');
  assert.equal(inspection.liveBinding.valid, false);
  assert.match(inspection.reason ?? '', /new-session.*does not match persisted.*session-123/);
});

test('runnerRunningForPark reports structured residual liveness', async () => {
  type RunningDeps = NonNullable<Parameters<typeof runnerRunningForPark>[1]>;
  const deps: RunningDeps = {
    exec: async (_vars, command) =>
      command.includes('display-message')
        ? { exitCode: 0, stdout: EXACT_PANE_ROW, stderr: '' }
        : { exitCode: 0, stdout: '', stderr: '' },
    findRunnerPid: async () => '202',
    probeRunnerPid: paneLiveness(Number.POSITIVE_INFINITY),
    verifyLiveBinding: verifyPersistedLiveBinding,
    respawnPane: async () => {},
    sleep: async () => {},
  };
  assert.equal(await runnerRunningForPark({ vars, recoveryHandle: handle }, deps), 'running');
  assert.equal(
    await runnerRunningForPark({ vars, recoveryHandle: { ...handle, runnerId: '' } }, deps),
    'unknown',
  );
});

test('stopRunnerForPark sends only the registry graceful-exit command and confirms exit', async () => {
  const commands: string[] = [];
  const result = await stopRunnerForPark(
    { vars, recoveryHandle: handle, timeoutMs: 100 },
    {
      exec: async (_vars, command) => {
        commands.push(command);
        if (command.includes('display-message')) {
          return { exitCode: 0, stdout: EXACT_PANE_ROW, stderr: '' };
        }
        return { exitCode: 0, stdout: '', stderr: '' };
      },
      findRunnerPid: async () => '202',
      probeRunnerPid: paneStopped,
      verifyLiveBinding: verifyPersistedLiveBinding,
      respawnPane: async () => {},
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
  const result = await stopRunnerForPark(
    { vars, recoveryHandle: { ...handle, runnerId: 'codex' }, timeoutMs: 100 },
    {
      exec: async (_vars, command) => {
        commands.push(command);
        return command.includes('display-message')
          ? { exitCode: 0, stdout: EXACT_PANE_ROW, stderr: '' }
          : { exitCode: 0, stdout: '', stderr: '' };
      },
      findRunnerPid: async () => '202',
      probeRunnerPid: paneStopped,
      verifyLiveBinding: verifyPersistedLiveBinding,
      respawnPane: async () => {},
      sleep: async () => {},
    },
  );
  assert.equal(result.ok, true);
  const exitCommand = commands.find((command) => command.includes("-l '/exit'"));
  assert.ok(exitCommand);
  assert.match(exitCommand, /-l '\/exit'[\s\S]*sleep 0[.]05[\s\S]*send-keys[^\n]*Enter/);
});

test('stopRunnerForPark keeps probing past an exhausted nominal budget', async () => {
  // The loaded-host case: the wall clock is already spent when the exit command
  // returns, so a wall-clock-only loop would report a runner that exits on the
  // third observation as still running.
  let probes = 0;
  const result = await stopRunnerForPark(
    { vars, recoveryHandle: handle, timeoutMs: 0 },
    {
      exec: async (_vars, command) =>
        command.includes('display-message')
          ? { exitCode: 0, stdout: EXACT_PANE_ROW, stderr: '' }
          : { exitCode: 0, stdout: '', stderr: '' },
      findRunnerPid: async () => '202',
      probeRunnerPid: async () => {
        probes += 1;
        return probes < RUNNER_PARK_GRACEFUL_EXIT_MIN_PROBES
          ? { state: 'present', pid: '202' }
          : { state: 'absent' };
      },
      verifyLiveBinding: verifyPersistedLiveBinding,
      respawnPane: async () => {},
      sleep: async () => {},
    },
  );
  assert.equal(result.ok, true);
  assert.equal(probes, RUNNER_PARK_GRACEFUL_EXIT_MIN_PROBES);
});

test('stopRunnerForPark reports a typed code when liveness cannot be decided', async () => {
  const result = await stopRunnerForPark(
    { vars, recoveryHandle: handle, timeoutMs: 100 },
    {
      exec: async (_vars, command) =>
        command.includes('display-message')
          ? { exitCode: 0, stdout: EXACT_PANE_ROW, stderr: '' }
          : { exitCode: 0, stdout: '', stderr: '' },
      findRunnerPid: async () => '202',
      probeRunnerPid: async () => ({
        state: 'unknown',
        code: 'probe-timeout',
        reason: 'command timed out after 10000ms',
        attempts: 3,
      }),
      verifyLiveBinding: verifyPersistedLiveBinding,
      respawnPane: async () => {},
      sleep: async () => {},
    },
  );
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.code, 'liveness-probe-timeout');
  assert.equal(result.ok === false && result.residualRunner, 'unknown');
});

test('stopRunnerForPark reports still-running with the probes it actually completed', async () => {
  const result = await stopRunnerForPark(
    { vars, recoveryHandle: handle, timeoutMs: 0 },
    {
      exec: async (_vars, command) =>
        command.includes('display-message')
          ? { exitCode: 0, stdout: EXACT_PANE_ROW, stderr: '' }
          : { exitCode: 0, stdout: '', stderr: '' },
      findRunnerPid: async () => '202',
      probeRunnerPid: async () => ({ state: 'present', pid: '202' }),
      verifyLiveBinding: verifyPersistedLiveBinding,
      respawnPane: async () => {},
      sleep: async () => {},
    },
  );
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.code, 'runner-still-running');
  assert.equal(result.ok === false && result.probes, RUNNER_PARK_GRACEFUL_EXIT_MIN_PROBES);
});

test('stopRunnerForPark stops waiting at the hard deadline even below the probe floor', async () => {
  // The probe floor exists so a host whose probes are slower than the nominal
  // budget still gets enough observations. It must not become an unbounded
  // wait: a stop whose probes never finish has to end at the hard deadline.
  let probes = 0;
  const startedAt = Date.now();
  const result = await stopRunnerForPark(
    { vars, recoveryHandle: handle, timeoutMs: 0, maxTimeoutMs: 120 },
    {
      exec: async (_vars, command) =>
        command.includes('display-message')
          ? { exitCode: 0, stdout: EXACT_PANE_ROW, stderr: '' }
          : { exitCode: 0, stdout: '', stderr: '' },
      findRunnerPid: async () => '202',
      probeRunnerPid: async () => {
        probes += 1;
        await new Promise((resolve) => setTimeout(resolve, 60));
        return { state: 'present', pid: '202' };
      },
      verifyLiveBinding: verifyPersistedLiveBinding,
      respawnPane: async () => {},
      sleep: async () => {},
    },
  );
  const elapsed = Date.now() - startedAt;

  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.code, 'runner-still-running');
  assert.ok(
    probes < RUNNER_PARK_GRACEFUL_EXIT_MIN_PROBES,
    `hard deadline must cut the probe floor short, saw ${probes} probes`,
  );
  assert.ok(elapsed < 2_000, `stop must not outlive its hard deadline, took ${elapsed}ms`);
});

test('stopRunnerForPark keeps waiting through a momentarily unreadable pane', async () => {
  // The pane can be unreadable for a tick while the exit lands. That is not a
  // verdict either way, so the loop keeps asking rather than failing the park
  // at the exact moment it is succeeding.
  let paneReads = 0;
  let exitSent = false;
  const result = await stopRunnerForPark(
    { vars, recoveryHandle: handle, timeoutMs: 500 },
    {
      exec: async (_vars, command) => {
        if (command.includes('send-keys')) exitSent = true;
        if (!command.includes('display-message')) return { exitCode: 0, stdout: '', stderr: '' };
        if (!exitSent) return { exitCode: 0, stdout: EXACT_PANE_ROW, stderr: '' };
        paneReads += 1;
        return paneReads === 1
          ? { exitCode: 1, stdout: '', stderr: "can't find pane %1" }
          : { exitCode: 0, stdout: EXACT_PANE_ROW, stderr: '' };
      },
      findRunnerPid: async () => '202',
      probeRunnerPid: paneStopped,
      verifyLiveBinding: verifyPersistedLiveBinding,
      respawnPane: async () => {},
      sleep: async () => {},
    },
  );

  assert.equal(result.ok, true);
  assert.equal(result.ok === true && result.status, 'stopped');
  assert.ok(paneReads >= 2, 'the unreadable read must not end the wait');
});

test('stopRunnerForPark fails closed, and bounded, when the pane stays unreadable', async () => {
  // A pane that never becomes readable completes no probes, so the probe floor
  // must not hold the wait open to the hard deadline.
  const startedAt = Date.now();
  let exitSent = false;
  const result = await stopRunnerForPark(
    { vars, recoveryHandle: handle, timeoutMs: 0, maxTimeoutMs: 3_000 },
    {
      exec: async (_vars, command) => {
        if (command.includes('send-keys')) exitSent = true;
        if (!command.includes('display-message')) return { exitCode: 0, stdout: '', stderr: '' };
        return exitSent
          ? { exitCode: 1, stdout: '', stderr: "can't find pane %1" }
          : { exitCode: 0, stdout: EXACT_PANE_ROW, stderr: '' };
      },
      findRunnerPid: async () => '202',
      probeRunnerPid: async () => {
        throw new Error('liveness must not be probed against an unreadable pane');
      },
      verifyLiveBinding: verifyPersistedLiveBinding,
      respawnPane: async () => {},
      sleep: async () => {},
    },
  );
  const elapsed = Date.now() - startedAt;

  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.code, 'liveness-unknown');
  assert.equal(result.ok === false && result.residualRunner, 'unknown');
  assert.match(result.ok === false ? result.error : '', /uninspectable/);
  assert.ok(elapsed < 2_000, `an unreadable pane must not hold the wait, took ${elapsed}ms`);
});

test('stopRunnerForPark fails closed when the intended pane is gone despite a live sibling', async () => {
  const commands: string[] = [];
  let matcherCalls = 0;
  const result = await stopRunnerForPark(
    { vars, recoveryHandle: handle, timeoutMs: 100 },
    {
      exec: async (_vars, command) => {
        commands.push(command);
        return command.includes('display-message')
          ? { exitCode: 1, stdout: '', stderr: "can't find pane: %1" }
          : { exitCode: 0, stdout: '', stderr: '' };
      },
      findRunnerPid: async () => {
        matcherCalls += 1;
        return 'sibling-runner-must-not-be-used';
      },
      probeRunnerPid: paneStopped,
      respawnPane: async () => {},
      sleep: async () => {},
    },
  );
  assert.equal(result.ok, false);
  assert.equal(result.status, 'failed');
  assert.match(result.error, /Exact runner target is uninspectable: can't find pane: %1/);
  assert.equal(matcherCalls, 0);
  assert.equal(
    commands.some((command) => command.includes("'/exit'")),
    false,
  );
});

test('reloadRunnerForPark respawns only the exact pane when its window may have siblings', async () => {
  let respawned = '';
  let runnerProbes = 0;
  const inspectionCommands: string[] = [];
  const result = await reloadRunnerForPark(
    { vars, recoveryHandle: handle, initialPrompt: 'Continue the parked run', timeoutMs: 100 },
    {
      exec: async (_vars, command) => {
        inspectionCommands.push(command);
        if (command.includes('test -e')) return { exitCode: 0, stdout: '', stderr: '' };
        if (command.includes('display-message')) {
          return { exitCode: 0, stdout: EXACT_PANE_ROW, stderr: '' };
        }
        return { exitCode: 0, stdout: '', stderr: '' };
      },
      findRunnerPid: async () => (runnerProbes++ === 0 ? '' : '202'),
      probeRunnerPid: paneStopped,
      verifyLiveBinding: verifyPersistedLiveBinding,
      respawnPane: async (_vars, target, command) => {
        assert.equal(target, '%1');
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
    target: '%1',
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
  assert.equal(
    inspectionCommands
      .filter((command) => command.includes('display-message'))
      .every((command) => command.includes("-t '%1'")),
    true,
  );
});

test('reloadRunnerForPark fails closed when the persisted session path is gone', async () => {
  let respawned = false;
  const result = await reloadRunnerForPark(
    { vars, recoveryHandle: handle, initialPrompt: 'Continue the parked run' },
    {
      exec: async () => ({ exitCode: 1, stdout: '', stderr: '' }),
      findRunnerPid: async () => '',
      probeRunnerPid: paneStopped,
      respawnPane: async () => {
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
      exec: async (_vars, command) =>
        command.includes('display-message')
          ? { exitCode: 0, stdout: EXACT_PANE_ROW, stderr: '' }
          : { exitCode: 0, stdout: '', stderr: '' },
      findRunnerPid: async () => '',
      probeRunnerPid: paneStopped,
      respawnPane: async () => {
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
        command.includes('display-message')
          ? { exitCode: 0, stdout: EXACT_PANE_ROW, stderr: '' }
          : { exitCode: 0, stdout: '', stderr: '' },
      findRunnerPid: async () => '',
      probeRunnerPid: paneStopped,
      respawnPane: async () => {},
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

test('a graceful exit that lands mid-inspection is a stop, not a failure', async () => {
  // The real shape: one probe still sees the process, the next no longer finds
  // it to read a start time from, so the ownership inspection turns unusable at
  // the exact moment the exit lands. Reading that as a stop failure failed the
  // park for doing what it asked.
  let inspections = 0;
  const deps = {
    exec: async (_vars: unknown, command: string) => {
      if (command.includes('display-message')) {
        return { exitCode: 0, stdout: EXACT_PANE_ROW, stderr: '' };
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    },
    findRunnerPid: async () => {
      inspections += 1;
      // Alive for the pre-exit inspection, alive again on the first poll, and
      // by then the start-time read below can no longer see it.
      return inspections <= 2 ? '202' : '';
    },
    verifyLiveBinding: async () =>
      inspections <= 1
        ? await verifyPersistedLiveBinding()
        : ({ ok: false, reason: 'live runner process start is unavailable for %1' } as const),
    probeRunnerPid: async () => ({ state: 'absent' as const }),
    sleep: async () => {},
  };

  const result = await stopRunnerForPark({ vars, recoveryHandle: handle }, deps as never);

  assert.equal(result.ok, true, result.ok === false ? result.error : '');
  assert.equal(result.ok === true && result.status, 'stopped');
  assert.equal(result.ok === true && result.residualRunner, 'stopped');
});

test('an unusable inspection with the runner still there does not report a stop', async () => {
  let inspections = 0;
  const deps = {
    exec: async (_vars: unknown, command: string) =>
      command.includes('display-message')
        ? { exitCode: 0, stdout: EXACT_PANE_ROW, stderr: '' }
        : { exitCode: 0, stdout: '', stderr: '' },
    findRunnerPid: async () => {
      inspections += 1;
      return '202';
    },
    // The pre-exit inspection succeeds, so the exit is sent and the wait loop
    // runs; every later inspection is unreadable while the runner is still
    // there. Absence is the only thing that may be read as a stop.
    verifyLiveBinding: async () =>
      inspections <= 1
        ? await verifyPersistedLiveBinding()
        : ({ ok: false, reason: 'binding unreadable' } as const),
    probeRunnerPid: async () => ({ state: 'present' as const, pid: '202' }),
    sleep: async () => {},
  };

  const result = await stopRunnerForPark(
    { vars, recoveryHandle: handle, timeoutMs: 400 },
    deps as never,
  );

  assert.equal(result.ok, false, 'a runner still under the pane has not stopped');
  // The wait loop no longer consults the ownership inspection at all, so an
  // unreadable binding cannot be mistaken for a stop OR reported as the stop's
  // cause. What is actually true is reported instead: the runner is still there.
  assert.equal(result.ok === false && result.code, 'runner-still-running');
  assert.equal(result.ok === false && result.residualRunner, 'running');
});

// ─── ADR-054 free-slot: re-hosting a parked session (slice 2) ────────────────

const parkHostDeps = (options: {
  windows?: TmuxWindowRef[];
  created?: TmuxWindowRef[];
  livePid?: string;
  /** Which runner the live process belongs to; defaults to the parked one. */
  liveRunnerId?: string;
  probeUnreadable?: boolean;
  sessionPathExitCode?: number;
  liveBindingOk?: boolean;
  slotSession?: string;
}) => {
  const calls: string[] = [];
  return {
    calls,
    deps: {
      exec: async (_vars: unknown, command: string) => {
        calls.push(command);
        return { exitCode: options.sessionPathExitCode ?? 0, stdout: '', stderr: '' };
      },
      findRunnerPid: async () => '',
      resolveSession: async () => options.slotSession ?? 'slot-1',
      probeRunnerPid: async (_vars: unknown, _panePid: string, runnerId?: string | null) => {
        calls.push(`probe:${runnerId ?? 'unknown'}`);
        if (options.probeUnreadable) return { state: 'unknown' as const, reason: 'ps failed' };
        if (!options.livePid) return { state: 'absent' as const };
        return runnerId === (options.liveRunnerId ?? 'claude')
          ? { state: 'present' as const, pid: options.livePid }
          : { state: 'absent' as const };
      },
      verifyLiveBinding: async () =>
        options.liveBindingOk
          ? await verifyPersistedLiveBinding()
          : ({ ok: false, reason: 'live runner owns a different session' } as const),
      listWindows: async () => options.windows ?? [],
      ensureWindow: async () => {
        calls.push('ensure-window');
        return { disposition: 'created' as const, windows: options.created ?? [] };
      },
      sleep: async () => {},
    },
  };
};

/** Ownership evidence naming exactly the panes this run's records bind. */
const ownedPanes = (...paneIds: string[]) => ({ runId: 'run-parked', ownedPaneIds: paneIds });

const windowRef = (paneId: string, index = 0): TmuxWindowRef => ({
  windowId: `@${index + 1}`,
  windowIndex: index,
  windowName: 'worker',
  activityAt: 0,
  paneId,
  panePid: '101',
});

test('a parked session whose recorded pane survived reloads in place', async () => {
  const { deps } = parkHostDeps({ windows: [windowRef('%1')] });
  const plan = await inspectRunnerParkHost({ vars, recoveryHandle: handle }, deps as never);
  assert.equal(plan.ok, true);
  assert.equal(plan.ok === true && plan.disposition, 'exact');
  assert.equal(
    plan.ok === true && plan.recoveryHandle.target.paneId,
    '%1',
    'nothing is re-bound when the recorded pane is still there',
  );
});

test('a parked session whose pane a successor destroyed is re-hosted on a new pane', async () => {
  // The slot was freed, its tmux session handed to the next occupant, and that
  // occupant's dispatch replaced the window. This is the ordinary case, not an
  // error: the persisted session is the identity, the pane is only its host.
  const { deps, calls } = parkHostDeps({ windows: [], created: [windowRef('%42', 3)] });
  const plan = await rehostRunnerParkTarget({ vars, recoveryHandle: handle }, deps as never);
  assert.equal(plan.ok, true);
  assert.equal(plan.ok === true && plan.disposition, 'rehost');
  assert.ok(calls.includes('ensure-window'));
  const rebound = plan.ok === true ? plan.recoveryHandle : null;
  assert.equal(rebound?.target.paneId, '%42');
  assert.equal(rebound?.target.target, 'slot-1:worker');
  // The pane INDEX belonged to a layout that no longer exists; keeping it would
  // name a different pane than the id does.
  assert.equal(rebound?.target.pane, null);
  // The identity that matters never moves.
  assert.equal(rebound?.sessionId, handle.sessionId);
  assert.equal(rebound?.sessionPath, handle.sessionPath);
});

test('a leftover window with the recorded name is re-hosted into rather than duplicated', async () => {
  // The successor's dispatch left the window standing but the pane the park
  // recorded is gone. Creating a second window of the same name would leave the
  // operator two panes and no way to tell which one holds the session.
  const { deps, calls } = parkHostDeps({ windows: [windowRef('%88', 2)] });
  const plan = await rehostRunnerParkTarget({ vars, recoveryHandle: handle }, deps as never);
  assert.equal(plan.ok, true);
  assert.equal(plan.ok === true && plan.disposition, 'rehost');
  assert.equal(plan.ok === true && plan.recoveryHandle.target.paneId, '%88');
  assert.equal(calls.includes('ensure-window'), false);
});

test('re-hosting refuses a tmux session that is no longer this slot', async () => {
  // The retained path proves this before every stop and reload. Without it the
  // re-host creates a window in a same-named but foreign or stale session and
  // reloads this run's worker there.
  const { deps, calls } = parkHostDeps({ windows: [], slotSession: 'someone-else' });
  const plan = await rehostRunnerParkTarget(
    { vars, recoveryHandle: handle, ownership: ownedPanes('%1') },
    deps as never,
  );
  assert.equal(plan.ok, false);
  assert.match(plan.ok === false ? plan.reason : '', /slot session changed from 'slot-1'/);
  assert.equal(calls.includes('ensure-window'), false, 'nothing is created in a foreign session');
});

test('an inspection never creates the window it reports as re-hostable', async () => {
  const { deps, calls } = parkHostDeps({ windows: [], created: [windowRef('%42')] });
  const plan = await inspectRunnerParkHost({ vars, recoveryHandle: handle }, deps as never);
  assert.equal(plan.ok, true);
  assert.equal(plan.ok === true && plan.disposition, 'rehost');
  assert.equal(calls.includes('ensure-window'), false, 'a preview must not mutate the slot');
});

test('re-hosting refuses a pane a FOREIGN runner is still alive in', async () => {
  // Respawning it would kill a process this restore does not own.
  const { deps } = parkHostDeps({ windows: [windowRef('%9', 1)], livePid: '4242' });
  const plan = await rehostRunnerParkTarget(
    { vars, recoveryHandle: handle, ownership: ownedPanes('%9') },
    deps as never,
  );
  assert.equal(plan.ok, false);
  assert.match(plan.ok === false ? plan.reason : '', /already running 'claude' \(pid 4242\)/);
});

test('a surviving successor of ANOTHER runner is seen and refused', async () => {
  // The freed slot goes to whoever dispatch picked, and that can be any runner.
  // Probing only the parked runner's own process pattern made a live codex
  // worker invisible to a claude restore, which then respawned the pane over it.
  const { deps, calls } = parkHostDeps({
    windows: [windowRef('%1')],
    livePid: '7777',
    liveRunnerId: 'codex',
    liveBindingOk: true,
  });
  const plan = await rehostRunnerParkTarget(
    { vars, recoveryHandle: handle, ownership: ownedPanes('%1') },
    deps as never,
  );
  assert.equal(plan.ok, false);
  assert.match(plan.ok === false ? plan.reason : '', /already running 'codex' \(pid 7777\)/);
  assert.match(plan.ok === false ? plan.reason : '', /not this run's 'claude' session/);
  assert.ok(calls.includes('probe:codex'), 'every runner is probed, not just the parked one');
});

test('an unreadable process tree refuses rather than respawning over it', async () => {
  const { deps } = parkHostDeps({ windows: [windowRef('%1')], probeUnreadable: true });
  const plan = await rehostRunnerParkTarget(
    { vars, recoveryHandle: handle, ownership: ownedPanes('%1') },
    deps as never,
  );
  assert.equal(plan.ok, false);
  assert.match(plan.ok === false ? plan.reason : '', /unreadable process tree/);
});

test('re-hosting accepts the recorded pane when the live runner IS this run', async () => {
  // A restore retried after one that reloaded the worker and then failed later
  // finds its own worker alive. Refusing there makes the retry impossible for
  // exactly the record that needs it.
  const { deps } = parkHostDeps({
    windows: [windowRef('%1')],
    livePid: '4242',
    liveBindingOk: true,
  });
  const plan = await inspectRunnerParkHost(
    { vars, recoveryHandle: handle, ownership: ownedPanes('%1') },
    deps as never,
  );
  assert.equal(plan.ok, true, plan.ok === false ? plan.reason : '');
  assert.equal(plan.ok === true && plan.disposition, 'exact');
});

test('a live worker is refused when the session matches but ownership does not', async () => {
  // A successor dispatched with the same `--resume` inherits the conversation,
  // so a matching session id proves conversation identity and nothing about
  // which Farmslot run owns the process.
  const { deps } = parkHostDeps({
    windows: [windowRef('%1')],
    livePid: '4242',
    liveBindingOk: true,
  });
  const plan = await inspectRunnerParkHost(
    { vars, recoveryHandle: handle, ownership: ownedPanes('%404') },
    deps as never,
  );
  assert.equal(plan.ok, false);
  assert.match(
    plan.ok === false ? plan.reason : '',
    /session records do not bind this pane to run 'run-parked'/,
  );
});

test('a live worker is refused when the caller offers no ownership evidence', async () => {
  const { deps } = parkHostDeps({
    windows: [windowRef('%1')],
    livePid: '4242',
    liveBindingOk: true,
  });
  const plan = await inspectRunnerParkHost({ vars, recoveryHandle: handle }, deps as never);
  assert.equal(plan.ok, false);
  assert.match(plan.ok === false ? plan.reason : '', /no run-ownership evidence/);
});

test('re-hosting refuses when the persisted session file is gone', async () => {
  // Everything else only decides WHERE to reload; without the conversation
  // there is nothing to reload at all.
  const { deps } = parkHostDeps({ windows: [], sessionPathExitCode: 1 });
  const plan = await rehostRunnerParkTarget({ vars, recoveryHandle: handle }, deps as never);
  assert.equal(plan.ok, false);
  assert.match(plan.ok === false ? plan.reason : '', /session path is unavailable/);
});

test('re-hosting refuses a runner that declares no persisted session reload', async () => {
  const { deps } = parkHostDeps({ windows: [] });
  const plan = await rehostRunnerParkTarget(
    { vars, recoveryHandle: { ...handle, runnerId: 'cursor' } },
    deps as never,
  );
  assert.equal(plan.ok, false);
  assert.match(plan.ok === false ? plan.reason : '', /no (graceful exit|persisted session reload)/);
});

test('re-hosting refuses a numeric window reference rather than guessing a position', async () => {
  // A numeric reference names a POSITION, and positions shift when a successor
  // rewrites the session.
  const { deps } = parkHostDeps({ windows: [] });
  const plan = await rehostRunnerParkTarget(
    {
      vars,
      recoveryHandle: { ...handle, target: { ...handle.target, window: '2', target: 'slot-1:2' } },
    },
    deps as never,
  );
  assert.equal(plan.ok, false);
  assert.match(plan.ok === false ? plan.reason : '', /names no exact tmux window/);
});
