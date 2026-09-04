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
