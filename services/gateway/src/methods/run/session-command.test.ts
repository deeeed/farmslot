import assert from 'node:assert/strict';
import test from 'node:test';

import type { AgentContext, Run } from '@farmslot/protocol';

import { buildRunnerSessionReloadCommand } from '../../runners/launch-command.js';
import { makeVars } from '../../runners/test-fixtures.js';

import { runSessionCommand, type RunSessionCommandDeps } from './session-command.js';
import { makeRun } from './test-fixtures.js';

const SLOT_VARS = makeVars({
  slotId: 'macpro-mm-1',
  machine: 'macpro',
  session: 'mm-1',
  repo: '/Users/example/dev/mm-1',
  remoteRepo: '/Users/example/dev/mm-1',
  dispatchCmd: '',
});

const OWNED_BINDING = {
  ok: true as const,
  binding: {
    runnerSessionId: 'codex-session-123',
    runnerSessionPath: '/Users/example/dev/mm-1/.agent/codex/sessions/codex-session-123.jsonl',
    source: 'filesystem' as const,
    canonicalSessionPath: '/Users/example/dev/mm-1/.agent/codex/sessions/codex-session-123.jsonl',
  },
};

function agentContext(overrides: Partial<AgentContext> = {}): AgentContext {
  return {
    id: 'fix-bug',
    role: 'fix-bug',
    label: 'Worker',
    status: 'working',
    slotId: 'macpro-mm-1',
    runId: 'run-1',
    runner: 'codex',
    model: 'gpt-5.6',
    runnerSessionId: 'codex-session-123',
    runnerSessionPath: '/Users/example/dev/mm-1/.agent/codex/sessions/codex-session-123.jsonl',
    runnerSessionCapturedAt: '2026-09-04T09:00:00.000Z',
    target: { session: 'mm-1', window: 'dev', pane: null, target: 'mm-1:dev' },
    updatedAt: '2026-09-04T09:00:00.000Z',
    ...overrides,
  };
}

function deps(
  run: Run | undefined,
  overrides: Partial<RunSessionCommandDeps> = {},
): RunSessionCommandDeps {
  return {
    getRun: () => run,
    loadSlotVars: async () => SLOT_VARS,
    loadProjectVars: async () => ({ projectJson: {} }) as never,
    resolveProjectRuntimeDir: async () => '.agent',
    buildReloadCommand: buildRunnerSessionReloadCommand,
    resolvePane: async () => ({ paneId: '%12', panePid: '4242' }),
    resolveSession: async () => 'mm-1',
    verifyBinding: async () => OWNED_BINDING,
    rediscoverPane: async () => ({ pane: null, scannedPanes: 0 }),
    upsert: async () => null,
    probeRunnerPid: async () => ({ state: 'present', pid: '4243' }),
    ...overrides,
  } as RunSessionCommandDeps;
}

function codexWorkerRun(overrides: Partial<Run> = {}): Run {
  return makeRun({
    id: 'run-1',
    flowType: 'fix-bug',
    slotId: 'macpro-mm-1',
    taskFile: 'tasks/run-1/TASK.md',
    metrics: {
      nudgeCount: 0,
      model: 'gpt-5.6',
      runner: 'codex',
      runnerSessionId: 'codex-session-123',
      runnerSessionPath: '/Users/example/dev/mm-1/.agent/codex/sessions/codex-session-123.jsonl',
    },
    agentContexts: [agentContext()],
    ...overrides,
  });
}

test('run.sessionCommand reopens a codex worker with the isolated CODEX_HOME and resume id', async () => {
  const result = await runSessionCommand({ runId: 'run-1' }, deps(codexWorkerRun()));

  assert.equal(result.supported, true);
  if (!result.supported) return;
  assert.equal(result.runner, 'codex');
  assert.equal(result.model, 'gpt-5.6');
  assert.equal(result.role, 'fix-bug');
  assert.equal(result.sessionId, 'codex-session-123');
  assert.equal(result.slotId, 'macpro-mm-1');
  assert.equal(result.machine, 'macpro');
  assert.equal(result.tmuxTarget, 'mm-1:dev');
  assert.equal(result.capturedAt, '2026-09-04T09:00:00.000Z');
  assert.match(result.reopenCommand, /CODEX_HOME=/);
  assert.match(result.reopenCommand, /resume/);
  assert.match(result.reopenCommand, /'codex-session-123'/);
  assert.equal(result.attachCommand, "tmux select-window -t 'mm-1:dev' \\; attach -t '=mm-1'");
});

test('run.sessionCommand reports live runner liveness from the process probe, not pane text', async () => {
  const live = await runSessionCommand({ runId: 'run-1' }, deps(codexWorkerRun()));
  assert.equal(live.supported && live.liveness, 'live');

  const dead = await runSessionCommand(
    { runId: 'run-1' },
    deps(codexWorkerRun(), { probeRunnerPid: async () => ({ state: 'absent' }) }),
  );
  assert.equal(dead.supported && dead.liveness, 'dead');

  const unknown = await runSessionCommand(
    { runId: 'run-1' },
    deps(codexWorkerRun(), {
      probeRunnerPid: async () => ({ state: 'unknown', reason: 'ssh unreachable' }),
    }),
  );
  assert.equal(unknown.supported && unknown.liveness, 'unknown');
  assert.equal(unknown.supported && unknown.livenessReason, 'ssh unreachable');
});

test('run.sessionCommand marks a vanished tmux pane dead without probing for a pid', async () => {
  let probed = false;
  const result = await runSessionCommand(
    { runId: 'run-1' },
    deps(codexWorkerRun(), {
      resolvePane: async () => null,
      probeRunnerPid: async () => {
        probed = true;
        return { state: 'present', pid: '1' };
      },
    }),
  );

  assert.equal(result.supported && result.liveness, 'dead');
  assert.equal(probed, false);
});

test('run.sessionCommand selects the requested role instead of the primary worker', async () => {
  const run = codexWorkerRun({
    agentContexts: [
      agentContext(),
      agentContext({
        id: 'rev1-ctx',
        role: 'self-review',
        label: 'Reviewer',
        runner: 'claude',
        model: 'sonnet',
        runnerSessionId: 'claude-session-9',
        runnerSessionPath: '/Users/example/dev/mm-1/.claude/sessions/claude-session-9.jsonl',
        target: { session: 'mm-1', window: 'rev-claude', pane: null, target: 'mm-1:rev-claude' },
      }),
    ],
  });

  const result = await runSessionCommand({ runId: 'run-1', role: 'self-review' }, deps(run));

  assert.equal(result.supported, true);
  if (!result.supported) return;
  assert.equal(result.role, 'self-review');
  assert.equal(result.runner, 'claude');
  assert.equal(result.sessionId, 'claude-session-9');
  assert.match(result.reopenCommand, /--resume 'claude-session-9'/);
});

test('run.sessionCommand returns a typed unsupported reason for a runner with no session reload', async () => {
  const run = codexWorkerRun({
    metrics: { nudgeCount: 0, model: 'auto', runner: 'cursor' },
    agentContexts: [
      agentContext({
        runner: 'cursor',
        model: 'auto',
        runnerSessionId: 'cursor-session-1',
        runnerSessionPath: '/tmp/cursor-session-1.json',
      }),
    ],
  });

  const result = await runSessionCommand({ runId: 'run-1' }, deps(run));

  assert.equal(result.supported, false);
  if (result.supported) return;
  assert.equal(result.reason, 'session-reload-unsupported');
  assert.equal(result.role, 'fix-bug');
  assert.match(result.detail, /cursor/);
  assert.equal('reopenCommand' in result, false);
});

test('run.sessionCommand reports session-not-captured instead of guessing a command', async () => {
  const run = codexWorkerRun({
    metrics: { nudgeCount: 0, model: 'gpt-5.6', runner: 'codex' },
    agentContexts: [agentContext({ runnerSessionId: null, runnerSessionPath: null })],
  });

  const result = await runSessionCommand({ runId: 'run-1' }, deps(run));

  assert.equal(result.supported, false);
  if (result.supported) return;
  assert.equal(result.reason, 'session-not-captured');
});

test('run.sessionCommand reports a missing role context and an unbound slot', async () => {
  const noContext = await runSessionCommand(
    { runId: 'run-1', role: 'ci-fix' },
    deps(codexWorkerRun()),
  );
  assert.equal(noContext.supported, false);
  assert.equal(noContext.supported === false && noContext.reason, 'no-agent-context');

  const unbound = await runSessionCommand(
    { runId: 'run-1' },
    deps(
      codexWorkerRun({
        slotId: null,
        agentContexts: [agentContext({ slotId: '' as unknown as string })],
      }),
    ),
  );
  assert.equal(unbound.supported, false);
  assert.equal(unbound.supported === false && unbound.reason, 'no-slot');
});

test('run.sessionCommand surfaces a missing run instead of returning an empty result', async () => {
  await assert.rejects(
    () => runSessionCommand({ runId: 'missing' }, deps(undefined)),
    /Run not found: missing/,
  );
});

test('a context without a tmux target still gets the slot attach line', async () => {
  const run = codexWorkerRun({
    agentContexts: [agentContext({ target: null })],
  });

  const result = await runSessionCommand({ runId: 'run-1' }, deps(run));

  assert.equal(result.supported, true);
  if (!result.supported) return;
  assert.equal(result.tmuxTarget, null);
  assert.equal(result.attachCommand, "tmux attach -t '=mm-1'");
  assert.equal(result.liveness, 'unknown');
  assert.match(result.livenessReason ?? '', /no tmux target/);
});

function twoReviewerRun(): Run {
  return codexWorkerRun({
    agentContexts: [
      agentContext(),
      agentContext({
        id: 'rev-codex',
        role: 'self-review',
        label: 'Reviewer 1',
        runnerSessionId: 'reviewer-session-1',
        runnerSessionPath: '/repo/.agent/codex/sessions/reviewer-session-1.jsonl',
        target: { session: 'mm-1', window: 'rev-codex', pane: null, target: 'mm-1:rev-codex' },
        updatedAt: '2026-09-04T09:10:00.000Z',
      }),
      agentContext({
        id: 'rev2-codex',
        role: 'self-review',
        label: 'Reviewer 2',
        runnerSessionId: 'reviewer-session-2',
        runnerSessionPath: '/repo/.agent/codex/sessions/reviewer-session-2.jsonl',
        target: { session: 'mm-1', window: 'rev2-codex', pane: null, target: 'mm-1:rev2-codex' },
        updatedAt: '2026-09-04T09:20:00.000Z',
      }),
    ],
  });
}

test('contextId resolves each of two same-role reviewers to its own session', async () => {
  const run = twoReviewerRun();

  const first = await runSessionCommand({ runId: 'run-1', contextId: 'rev-codex' }, deps(run));
  const second = await runSessionCommand({ runId: 'run-1', contextId: 'rev2-codex' }, deps(run));

  assert.equal(first.supported, true);
  assert.equal(second.supported, true);
  if (!first.supported || !second.supported) return;
  assert.equal(first.contextId, 'rev-codex');
  assert.equal(first.sessionId, 'reviewer-session-1');
  assert.match(first.reopenCommand, /'reviewer-session-1'/);
  assert.equal(second.contextId, 'rev2-codex');
  assert.equal(second.sessionId, 'reviewer-session-2');
  assert.match(second.reopenCommand, /'reviewer-session-2'/);
  assert.notEqual(first.reopenCommand, second.reopenCommand);
});

test('role alone still resolves, and contextId overrides a conflicting role', async () => {
  const run = twoReviewerRun();

  // Role-only picks the newest reviewer — the historical ambiguity.
  const byRole = await runSessionCommand({ runId: 'run-1', role: 'self-review' }, deps(run));
  assert.equal(byRole.supported && byRole.contextId, 'rev2-codex');

  // An explicit id wins over a role that would have chosen differently.
  const byId = await runSessionCommand(
    { runId: 'run-1', contextId: 'rev-codex', role: 'self-review' },
    deps(run),
  );
  assert.equal(byId.supported && byId.contextId, 'rev-codex');
  assert.equal(byId.supported && byId.role, 'self-review');
});

test('an unknown contextId is a typed miss naming the id, not a silent role fallback', async () => {
  const result = await runSessionCommand(
    { runId: 'run-1', contextId: 'rev9-codex' },
    deps(twoReviewerRun()),
  );

  assert.equal(result.supported, false);
  if (result.supported) return;
  assert.equal(result.reason, 'no-agent-context');
  assert.match(result.detail, /rev9-codex/);
});

test('liveness is live only when the pane runner owns this exact session', async () => {
  const owned = await runSessionCommand({ runId: 'run-1' }, deps(codexWorkerRun()));
  assert.equal(owned.supported && owned.liveness, 'live');

  // Same runner type in the pane, but it is running a different session.
  const foreign = await runSessionCommand(
    { runId: 'run-1' },
    deps(codexWorkerRun(), {
      verifyBinding: async () => ({
        ok: false,
        reason:
          "active runner session id 'other-session' does not match persisted 'codex-session-123'",
      }),
    }),
  );
  assert.equal(foreign.supported && foreign.liveness, 'unknown');
  assert.match((foreign.supported && foreign.livenessReason) || '', /does not match persisted/);
});

test('a pane with no runner process stays dead without consulting the binding', async () => {
  let verified = false;
  const result = await runSessionCommand(
    { runId: 'run-1' },
    deps(codexWorkerRun(), {
      probeRunnerPid: async () => ({ state: 'absent' }),
      verifyBinding: async () => {
        verified = true;
        return OWNED_BINDING;
      },
    }),
  );

  assert.equal(result.supported && result.liveness, 'dead');
  assert.equal(verified, false);
});

test('a session reopened in another window is reported live at its new target', async () => {
  const upserts: Array<{ contextId?: string; target?: unknown }> = [];
  const result = await runSessionCommand(
    { runId: 'run-1' },
    deps(codexWorkerRun(), {
      // The recorded role window is gone: dispatch destroys it when the runner exits.
      resolvePane: async () => null,
      rediscoverPane: async () => ({
        pane: {
          paneId: '%42',
          panePid: '5150',
          windowName: 'dev-reopen',
          target: 'mm-1:dev-reopen',
        },
        scannedPanes: 3,
      }),
      upsert: async (_runId, _role, patch) => {
        upserts.push({ contextId: patch.id, target: patch.target });
        return null;
      },
    }),
  );

  assert.equal(result.supported, true);
  if (!result.supported) return;
  assert.equal(result.liveness, 'live');
  assert.equal(result.tmuxTarget, 'mm-1:dev-reopen');
  assert.equal(result.rediscoveredTarget, true);
  // The attach line must follow the session to the window it actually lives in.
  assert.equal(
    result.attachCommand,
    "tmux select-window -t 'mm-1:dev-reopen' \\; attach -t '=mm-1'",
  );
  // The context is rebound so Command Center and the CLI stop pointing at a
  // window that no longer exists.
  assert.equal(upserts.length, 1);
  assert.equal(upserts[0]?.contextId, 'fix-bug');
  assert.deepEqual(upserts[0]?.target, {
    session: 'mm-1',
    window: 'dev-reopen',
    pane: null,
    paneId: '%42',
    target: 'mm-1:dev-reopen',
  });
});

test('a session found nowhere in the slot stays dead and never rebinds the context', async () => {
  let upserted = 0;
  const result = await runSessionCommand(
    { runId: 'run-1' },
    deps(codexWorkerRun(), {
      resolvePane: async () => null,
      rediscoverPane: async () => ({
        pane: null,
        scannedPanes: 2,
        reason: 'no pane in tmux session mm-1 runs codex session codex-session-123',
      }),
      upsert: async () => {
        upserted += 1;
        return null;
      },
    }),
  );

  assert.equal(result.supported && result.liveness, 'dead');
  assert.match(
    (result.supported && result.livenessReason) || '',
    /no pane in tmux session mm-1 runs codex session/,
  );
  assert.equal(upserted, 0);
});

test('a live recorded pane never triggers a session-wide scan', async () => {
  let scans = 0;
  const result = await runSessionCommand(
    { runId: 'run-1' },
    deps(codexWorkerRun(), {
      rediscoverPane: async () => {
        scans += 1;
        return { pane: null, scannedPanes: 0 };
      },
    }),
  );

  assert.equal(result.supported && result.liveness, 'live');
  assert.equal(result.supported && result.tmuxTarget, 'mm-1:dev');
  assert.equal(scans, 0);
});

test("the result carries the runner's declared graceful exit, not a client literal", async () => {
  const codex = await runSessionCommand({ runId: 'run-1' }, deps(codexWorkerRun()));
  assert.equal(codex.supported, true);
  if (!codex.supported) return;
  // Sourced from the runner capability registry so no caller hardcodes `/exit`.
  assert.equal(codex.interrupt?.command, '/exit');
  assert.equal(codex.interrupt?.submitDelayMs, 50);
});

test('each reload-capable runner carries its own registry-declared exit', async () => {
  // Every runner the RPC supports declares a graceful exit today, so the field
  // is always present; it is read from the registry rather than assumed.
  for (const [runner, model, sessionId, sessionPath] of [
    ['claude', 'opus', 'claude-session-1', '/repo/.claude/sessions/claude-session-1.jsonl'],
    [
      'grok',
      'grok-code-fast-1',
      'grok-session-1',
      '/repo/.agent/grok/sessions/grok-session-1.json',
    ],
  ] as const) {
    const run = codexWorkerRun({
      metrics: {
        nudgeCount: 0,
        model,
        runner,
        runnerSessionId: sessionId,
        runnerSessionPath: sessionPath,
      },
      agentContexts: [
        agentContext({ runner, model, runnerSessionId: sessionId, runnerSessionPath: sessionPath }),
      ],
    });

    const result = await runSessionCommand({ runId: 'run-1' }, deps(run));
    assert.equal(result.supported, true, `${runner} must be supported`);
    if (!result.supported) continue;
    assert.equal(result.runner, runner);
    assert.equal(result.interrupt?.command, '/exit', `${runner} exit command`);
  }
});
