import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

import type { AgentContext, Run } from '@farmslot/protocol';

import { makeRun } from '../run-engine/test-fixtures.js';
import { makeVars } from '../runners/test-fixtures.js';

const original = {
  runnerSessionId: 'primary-session',
  runnerSessionPath: '/sessions/primary.jsonl',
};
const reviewer = { runnerSessionId: 'review-session', runnerSessionPath: '/sessions/review.jsonl' };
const capture = '2026-10-12T20:23:00.000Z';
let run: Run;
let processStarted: number | null;
let sessionExists: boolean;
let paneSession: string;
let observed: typeof original | null = original;
let runnerAlive: boolean;
let normalizeBinding:
  | ((...args: unknown[]) => Promise<{ sessionId: string; sessionPath: string } | null>)
  | undefined;
const launches: string[] = [];
const lookups: (string | null | undefined)[] = [];
const commands: string[] = [];

const execModule = await import('../core/exec.js');
mock.module('../core/exec.js', {
  namedExports: {
    ...execModule,
    execOnSlot: async (_vars: unknown, command: string) => {
      commands.push(command);
      assert.ok(!/new-session|new-window|respawn|send-keys|kill-session/.test(command));
      if (command.includes('has-session'))
        return { exitCode: sessionExists ? 0 : 1, stdout: '', stderr: '' };
      // The exact pane moved to the archive session; it is filtered out of the slot session.
      return {
        exitCode: 0,
        stdout: command.includes('list-panes')
          ? `${paneSession}\t1\tdev\t1\t%1\t101\tbash\t/repo\n`
          : '',
        stderr: '',
      };
    },
  },
});
const config = await import('../core/config.js');
mock.module('../core/config.js', {
  namedExports: {
    ...config,
    loadSlotVars: async () => makeVars({ slotId: 'slot-1', codexPath: '/bin/codex' }),
    loadProjectVars: async () => ({ projectJson: {} }),
    resolveProjectRuntimeDir: async () => 'runtime',
  },
});
const tmux = await import('../core/tmux.js');
mock.module('../core/tmux.js', {
  namedExports: {
    ...tmux,
    resolveTmuxSession: async () => 'slot-1',
    respawnTmuxWindowWithCommand: async (_vars: unknown, _target: unknown, command: string) => {
      launches.push(command);
      runnerAlive = true;
    },
  },
});
const sessions = await import('../runners/session-process.js');
mock.module('../runners/session-process.js', {
  namedExports: {
    ...sessions,
    readPaneProcessStartedAtMs: async () => processStarted,
    isRunnerAliveUnderPane: async () => runnerAlive,
    resolveRunnerSessionBinding: async (
      _vars: unknown,
      _runner: unknown,
      _before: unknown,
      options: { paneId?: string | null },
    ) => {
      lookups.push(options.paneId);
      if (!observed) return null;
      return options.paneId
        ? { ...observed, source: 'hook' }
        : { ...reviewer, source: 'filesystem' };
    },
  },
});
const registry = await import('../runners/registry.js');
mock.module('../runners/registry.js', {
  namedExports: {
    ...registry,
    getRunnerObservability: () => ({ normalizeRetainedSessionBinding: normalizeBinding }),
  },
});
const support = await import('../node-support/ensure.js');
mock.module('../node-support/ensure.js', {
  namedExports: { ...support, ensureNodeSupportBundle: async () => {} },
});
const index = await import('../core/index.js');
mock.module('../core/index.js', {
  namedExports: { ...index, readSlotRow: async () => ({ current_run_id: run.id, slot_epoch: 1 }) },
});
const store = await import('../runs/store.js');
mock.module('../runs/store.js', {
  namedExports: {
    ...store,
    getRun: () => run,
    updateRun: (_id: string, patch: Partial<Run>) => Object.assign(run, patch),
    updateRunAgentContexts: (
      _id: string,
      mutate: (run: Run, contexts: AgentContext[]) => AgentContext[],
    ) => {
      run.agentContexts = mutate(run, run.agentContexts!);
      return run;
    },
  },
});
const { reconcileRunAgentRuntime, restoreTmuxWorker } = await import('./runtime-recovery.js');

function fixture(corrupt = false): void {
  lookups.length = 0;
  commands.length = 0;
  launches.length = 0;
  runnerAlive = true;
  normalizeBinding = undefined;
  processStarted = Date.parse('2026-10-12T20:22:03.000Z');
  sessionExists = true;
  paneSession = 'slot-1-orch';
  observed = original;
  run = makeRun({
    id: 'run-1',
    flowType: 'dev',
    status: 'blocked',
    slotId: 'slot-1',
    metrics: { nudgeCount: 0, runner: 'claude', model: 'opus', ...(corrupt ? reviewer : original) },
  });
  run.agentContexts = [
    {
      id: 'dev',
      runId: run.id,
      slotId: run.slotId!,
      role: 'dev',
      label: 'Dev',
      status: 'blocked',
      runner: 'claude',
      model: 'opus',
      startedAt: '2026-10-12T20:22:01.000Z',
      runnerSessionCapturedAt: capture,
      target: { session: 'slot-1', window: 'dev', paneId: '%1', target: '%1' },
      ...(corrupt ? reviewer : original),
    },
    {
      id: 'rev-claude',
      runId: run.id,
      slotId: run.slotId!,
      role: 'review',
      label: 'Review',
      status: 'complete',
      runner: 'claude',
      model: 'sonnet',
      target: { session: 'slot-1-orch', window: 'rev-claude', paneId: '%2', target: '%2' },
      runnerSessionCapturedAt: '2026-10-12T22:05:00.000Z',
      ...reviewer,
    },
  ];
}

test('a moved exact pane never replaces the primary session with the newest reviewer transcript', async () => {
  fixture();
  await reconcileRunAgentRuntime(run);
  assert.deepEqual(lookups, ['%1']);
  assert.equal(run.agentContexts![0].runnerSessionId, original.runnerSessionId);
  assert.equal(run.agentContexts![1].runnerSessionId, reviewer.runnerSessionId);
});

test('the original process repairs a primary binding contaminated with its completed reviewer identity', async () => {
  fixture(true);
  const savedReviewer = structuredClone(run.agentContexts![1]);
  await reconcileRunAgentRuntime(run);
  assert.equal(run.agentContexts![0].runnerSessionId, original.runnerSessionId);
  assert.equal(run.agentContexts![0].runnerSessionPath, original.runnerSessionPath);
  assert.equal(run.agentContexts![0].runnerSessionCapturedAt, capture);
  assert.equal(run.metrics.runnerSessionId, original.runnerSessionId);
  assert.equal(run.metrics.runnerSessionPath, original.runnerSessionPath);
  assert.deepEqual(run.agentContexts![1], savedReviewer);
  assert.equal(run.status, 'blocked');
});

test('a missing slot session still resolves only its recorded pane', async () => {
  fixture(true);
  sessionExists = false;
  await reconcileRunAgentRuntime(run);
  assert.deepEqual(lookups, ['%1']);
  assert.equal(run.agentContexts![0].runnerSessionId, original.runnerSessionId);
});

test('a different or uninspectable process cannot repair the reviewer collision', async () => {
  for (const started of [Date.parse('2026-10-12T23:00:00.000Z'), null]) {
    fixture(true);
    processStarted = started;
    await reconcileRunAgentRuntime(run);
    assert.equal(run.agentContexts![0].runnerSessionId, reviewer.runnerSessionId);
  }
});

test('an unrelated live session cannot overwrite a valid retained primary identity', async () => {
  fixture();
  paneSession = 'slot-1';
  observed = { runnerSessionId: 'foreign-session', runnerSessionPath: '/sessions/foreign.jsonl' };
  await reconcileRunAgentRuntime(run);
  assert.equal(run.agentContexts![0].runnerSessionId, original.runnerSessionId);
});

test('a retained context without an exact pane never falls back to another role transcript', async () => {
  fixture();
  run.agentContexts![0].target = null;
  sessionExists = false;
  await reconcileRunAgentRuntime(run);
  assert.deepEqual(lookups, []);
  assert.equal(run.agentContexts![0].runnerSessionId, original.runnerSessionId);
});

function legacyCodexFixture(): void {
  fixture();
  paneSession = 'slot-1';
  const primary = run.agentContexts![0];
  primary.runner = 'codex';
  primary.model = 'gpt-6.1-sol';
  primary.runnerSessionId = 'rollout-original';
  primary.runnerSessionPath = '/sessions/rollout-original.jsonl';
  run.metrics.runnerSessionId = primary.runnerSessionId;
  run.metrics.runnerSessionPath = primary.runnerSessionPath;
  normalizeBinding = async (_vars, binding) => {
    assert.deepEqual(binding, {
      sessionId: 'rollout-original',
      sessionPath: '/sessions/rollout-original.jsonl',
    });
    return { sessionId: 'native-session', sessionPath: '/sessions/rollout-original.jsonl' };
  };
}

test('live reconciliation preserves the runner capability migration to native session IDs', async () => {
  legacyCodexFixture();
  observed = {
    runnerSessionId: 'native-session',
    runnerSessionPath: '/sessions/rollout-original.jsonl',
  };
  await reconcileRunAgentRuntime(run);
  assert.equal(run.agentContexts![0].runnerSessionId, 'native-session');
  assert.equal(run.metrics.runnerSessionId, 'native-session');
});

test('a dead worker reload passes the normalized native ID instead of its rollout filename', async () => {
  legacyCodexFixture();
  observed = null;
  runnerAlive = false;
  await restoreTmuxWorker({ slotId: 'slot-1', runId: run.id, mode: 'reload-session' });
  assert.equal(launches.length, 1);
  assert.match(launches[0], /native-session/);
  assert.doesNotMatch(launches[0], /resume[^\n]*rollout-original/);
  assert.equal(run.agentContexts![0].runnerSessionId, 'native-session');
});
