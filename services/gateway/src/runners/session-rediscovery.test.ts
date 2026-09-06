import assert from 'node:assert/strict';
import test from 'node:test';

import {
  rediscoverRunnerSessionPane,
  type RunnerSessionRediscoveryDeps,
} from './session-rediscovery.js';
import { makeVars } from './test-fixtures.js';

const VARS = makeVars({ slotId: 'macpro-ff-1', session: 'ff-1' });

const EXPECTED = {
  expectedSessionId: '01a06baa',
  expectedSessionPath: '/repo/.agent/codex-home/sessions/rollout-01a06baa.jsonl',
};

function ownedBinding(sessionId: string) {
  return {
    ok: true as const,
    binding: {
      runnerSessionId: sessionId,
      runnerSessionPath: EXPECTED.expectedSessionPath,
      source: 'filesystem' as const,
      canonicalSessionPath: EXPECTED.expectedSessionPath,
    },
  };
}

function deps(overrides: Partial<RunnerSessionRediscoveryDeps> = {}): RunnerSessionRediscoveryDeps {
  return {
    exec: async () => ({
      exitCode: 0,
      stdout: '%11|4001|worker\n%12|4002|dev-reopen\n',
      stderr: '',
    }),
    probeRunnerPid: async () => ({ state: 'present', pid: '9000' }),
    verifyBinding: async () => ownedBinding(EXPECTED.expectedSessionId),
    ...overrides,
  } as RunnerSessionRediscoveryDeps;
}

test('rediscovery finds the session in another window and reports its new target', async () => {
  // Only the second pane owns the session; the first runs a different one.
  const seen: string[] = [];
  const result = await rediscoverRunnerSessionPane(
    { vars: VARS, session: 'ff-1', runner: 'codex', ...EXPECTED },
    deps({
      verifyBinding: async (_vars, _runner, options) => {
        seen.push(options.paneId);
        return options.paneId === '%12'
          ? ownedBinding(EXPECTED.expectedSessionId)
          : { ok: false, reason: "active runner session id 'other' does not match persisted" };
      },
    }),
  );

  assert.deepEqual(seen, ['%11', '%12']);
  assert.equal(result.pane?.paneId, '%12');
  assert.equal(result.pane?.windowName, 'dev-reopen');
  // The routing target is the exact pane; the window name is display only.
  assert.equal(result.pane?.target, '%12');
  assert.equal(result.pane?.displayTarget, 'ff-1:dev-reopen');
  assert.equal(result.scannedPanes, 2);
});

test('rediscovery reports not found when no pane owns the session', async () => {
  const result = await rediscoverRunnerSessionPane(
    { vars: VARS, session: 'ff-1', runner: 'codex', ...EXPECTED },
    deps({
      verifyBinding: async () => ({
        ok: false,
        reason: "active runner session id 'other' does not match persisted",
      }),
    }),
  );

  assert.equal(result.pane, null);
  assert.equal(result.scannedPanes, 2);
  assert.match(result.reason ?? '', /no pane in tmux session ff-1 runs codex session 01a06baa/);
});

test('a pane whose runner is not running is skipped without a binding check', async () => {
  let verified = 0;
  const result = await rediscoverRunnerSessionPane(
    { vars: VARS, session: 'ff-1', runner: 'codex', ...EXPECTED },
    deps({
      probeRunnerPid: async () => ({ state: 'absent' }),
      verifyBinding: async () => {
        verified += 1;
        return ownedBinding(EXPECTED.expectedSessionId);
      },
    }),
  );

  assert.equal(result.pane, null);
  assert.equal(verified, 0);
});

test('rediscovery skips the pane the caller already checked', async () => {
  const seen: string[] = [];
  await rediscoverRunnerSessionPane(
    { vars: VARS, session: 'ff-1', runner: 'codex', ...EXPECTED, skipPaneId: '%11' },
    deps({
      verifyBinding: async (_vars, _runner, options) => {
        seen.push(options.paneId);
        return ownedBinding(EXPECTED.expectedSessionId);
      },
    }),
  );

  assert.deepEqual(seen, ['%12']);
});

test('an unreadable pane inventory is a reason, not a false negative claim', async () => {
  const result = await rediscoverRunnerSessionPane(
    { vars: VARS, session: 'ff-1', runner: 'codex', ...EXPECTED },
    deps({ exec: async () => ({ exitCode: 1, stdout: '', stderr: 'no server running' }) }),
  );

  assert.equal(result.pane, null);
  assert.equal(result.scannedPanes, 0);
  // An unreadable inventory proves nothing; the caller must not call it dead.
  assert.equal(result.indeterminate, true);
  assert.match(result.reason ?? '', /pane inventory for session ff-1 is unavailable/);
});

test('an unprobeable pane makes the scan indeterminate, not a confident absence', async () => {
  const result = await rediscoverRunnerSessionPane(
    { vars: VARS, session: 'ff-1', runner: 'codex', ...EXPECTED },
    deps({
      probeRunnerPid: async () => ({
        state: 'unknown',
        code: 'probe-transport',
        reason: 'ps unavailable',
      }),
    }),
  );

  assert.equal(result.pane, null);
  // Skipping a failed probe silently turned an unreadable process tree into
  // "the session is gone".
  assert.equal(result.indeterminate, true);
  assert.match(result.reason ?? '', /could not be probed/);
});

test('one unprobeable pane does not mask an owner found in another pane', async () => {
  const result = await rediscoverRunnerSessionPane(
    { vars: VARS, session: 'ff-1', runner: 'codex', ...EXPECTED },
    deps({
      probeRunnerPid: async (_vars, panePid) =>
        panePid === '4001'
          ? { state: 'unknown', code: 'probe-transport', reason: 'ps unavailable' }
          : { state: 'present', pid: '9000' },
    }),
  );

  assert.equal(result.pane?.paneId, '%12');
  assert.equal(result.indeterminate, undefined);
});

/**
 * The shape observed live on macpro-ff-1: a session reopened in a new window.
 * Fresh-launch attribution returns nothing, because the resumed transcript was
 * written by the process that has since exited and is therefore older than the
 * pane that reopened it. The runner proves ownership from the live process.
 */
test('a resumed session is recognized even though its transcript predates the pane', async () => {
  const seen: Array<{ paneId: string; runnerPid?: string }> = [];
  const result = await rediscoverRunnerSessionPane(
    { vars: VARS, session: 'ff-1', runner: 'codex', ...EXPECTED },
    deps({
      exec: async () => ({ exitCode: 0, stdout: '%32|6601|\n', stderr: '' }),
      probeRunnerPid: async () => ({ state: 'present', pid: '6892' }),
      verifyBinding: async (_vars, _runner, options) => {
        seen.push({
          paneId: options.paneId,
          ...(options.runnerPid ? { runnerPid: options.runnerPid } : {}),
        });
        // The verifier only reaches its resumed fallback when it is handed the
        // proven runner pid.
        return options.runnerPid === '6892'
          ? ownedBinding(EXPECTED.expectedSessionId)
          : { ok: false, reason: 'active runner session binding is unavailable for %32' };
      },
    }),
  );

  assert.deepEqual(seen, [{ paneId: '%32', runnerPid: '6892' }]);
  assert.equal(result.pane?.paneId, '%32');
  assert.equal(result.pane?.target, '%32');
  // tmux.newWindow leaves the window unnamed; display falls back to the session.
  assert.equal(result.pane?.displayTarget, 'ff-1');
});
