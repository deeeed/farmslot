import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

import type { AgentContext, Run } from '@farmslot/protocol';

await import('../runtime/mock-pty.test-support.js');
const store = await import('../runs/store.js');
const contexts = await import('../agents/contexts.js');
const exec = await import('../core/exec.js');
const config = await import('../core/config.js');
const state = await import('../core/state.js');
const tmux = await import('../core/tmux.js');
const registry = await import('../runners/registry.js');
const processes = await import('../runners/session-process.js');
const workerPrompt = await import('../runners/worker-prompt.js');
const snapshots = await import('./snapshots.js');
const feedback = await import('./feedback.js');
const progress = await import('./progress.js');
const watcher = await import('../tasks/watcher.js');
const checklist = await import('../tasks/checklist-target.js');
const usage = await import('../runtime/session-usage.js');
const { makeRun } = await import('../run-completion/test-fixtures.js');
const { makeVars } = await import('../runners/test-fixtures.js');

const vars = makeVars({ slotId: 'slot-1' });
const original: AgentContext = {
  id: 'rev-claude',
  role: 'review',
  label: 'Reviewer',
  status: 'working',
  runId: 'run-1',
  slotId: vars.slotId,
  runner: 'claude',
  model: 'opus',
  reviewId: 'lineage',
  reviewLoopNumber: 2,
  taskFile: 'tasks/run-1/REVIEW.rev-claude.md',
  signalFile: 'tasks/run-1/REVIEW.rev-claude-SIGNAL.json',
  target: { session: 'slot-session', window: 'rev-claude', target: 'slot-session:rev-claude' },
  runnerSessionId: 'stale-session',
  runnerSessionPath: '/stale.jsonl',
  attemptStartedAt: '2026-10-27T20:00:00.000Z',
};
let run: Run = {
  ...makeRun({ slotId: vars.slotId, status: 'monitoring' }),
  agentContexts: [original],
};
const slot = { current_run_id: run.id, slot_epoch: 1 };
const upsert: typeof contexts.upsertAgentContext = async (_id, _role, patch, options) => {
  if (options?.guard && !(await options.guard())) return null;
  const prior = run.agentContexts!.find((entry) =>
    patch.id ? entry.id === patch.id : entry.role === _role,
  );
  assert(prior);
  const next = { ...prior, ...patch };
  run = {
    ...run,
    agentContexts: run.agentContexts!.map((entry) => (entry.id === prior.id ? next : entry)),
  };
  return next;
};
let captured: Awaited<ReturnType<typeof processes.captureRunnerSessionMetadata>> = {
  runnerSessionId: 'resumed-session',
  runnerSessionPath: '/resumed.jsonl',
};
let captureAttempts = 0;
let sentPrompts = 0;
let usageSession: string | null | undefined;
let settledPath: string | null | undefined;
mock.module('../runs/store.js', {
  namedExports: {
    ...store,
    getRun: () => run,
    updateRun: (_id: string, patch: Partial<Run>) => {
      run = { ...run, ...patch };
      return run;
    },
    clearRunActiveTaskFile: () => undefined,
  },
});
mock.module('../agents/contexts.js', {
  namedExports: {
    ...contexts,
    upsertAgentContext: upsert,
    markAgentContextStatus: async () => null,
  },
});
mock.module('../core/state.js', { namedExports: { ...state, readSlotRow: async () => slot } });
mock.module('../core/config.js', {
  namedExports: { ...config, resolveProjectRuntimeDir: async () => '.agent' },
});
mock.module('../core/exec.js', {
  namedExports: {
    ...exec,
    execOnSlot: async (_vars: unknown, command: string) => ({
      exitCode: 0,
      stderr: '',
      stdout: command.startsWith('cat ')
        ? JSON.stringify({ status: 'complete', outcome: 'success', disposition: 'fixed' })
        : 'yes',
    }),
  },
});
mock.module('../core/tmux.js', {
  namedExports: {
    ...tmux,
    resolveTmuxSession: async () => 'slot-session',
    listExactTmuxWindows: async () => [{ windowId: '@22', windowName: 'rev-claude' }],
    resolveExactTmuxWindowPane: async () => ({ paneId: '%22', panePid: '2002' }),
  },
});
mock.module('../runners/registry.js', {
  namedExports: {
    ...registry,
    sendRunnerPostLaunchPrompt: async () => {
      sentPrompts++;
    },
  },
});
mock.module('../runners/session-process.js', {
  namedExports: {
    ...processes,
    probeRunnerDescendantPid: async () => ({ state: 'present', pid: '2002' }),
    captureRunnerSessionMetadata: async () => {
      if (++captureAttempts === 1) throw new Error('transient session read timeout');
      return captured;
    },
  },
});
mock.module('../runners/worker-prompt.js', {
  namedExports: {
    ...workerPrompt,
    resolveWorkerDispatchPrompt: async () => 'Review the retained task.',
  },
});
mock.module('./snapshots.js', {
  namedExports: {
    ...snapshots,
    readPersistedReviewSnapshot: async () => ({
      snapshot: {
        source: 'local-git',
        capturedAt: new Date().toISOString(),
        baseSha: 'a'.repeat(40),
        headSha: 'b'.repeat(40),
        diffPath: 'diff.txt',
      },
      artifactPaths: [],
    }),
    waitForSessionTranscriptToSettle: async (_vars: unknown, path: string | null) => {
      settledPath = path;
    },
  },
});
mock.module('./feedback.js', {
  namedExports: { ...feedback, readReviewFeedback: async () => ({ verdict: 'pass', issues: [] }) },
});
mock.module('./progress.js', {
  namedExports: { ...progress, startProgressWatcher: () => ({ stop: async () => undefined }) },
});
mock.module('../tasks/watcher.js', {
  namedExports: { ...watcher, unwatchContext: async () => undefined },
});
mock.module('../tasks/checklist-target.js', {
  namedExports: { ...checklist, restoreWorkerChecklistTargetFromSlot: async () => undefined },
});
mock.module('../runtime/session-usage.js', {
  namedExports: {
    ...usage,
    extractRunnerSessionUsage: async (
      options: Parameters<typeof usage.extractRunnerSessionUsage>[0],
    ) => {
      usageSession = options.runnerSessionId;
      return usage.unavailableRunnerSessionUsage({ ...options, error: 'fixture has no usage' });
    },
  },
});
// Namespace imports above may load these through cycles. Load the subjects
// after installing I/O mocks so their captured bindings use this fixture.
const sessionRecord: typeof import('../runners/session-record.js') = await import(
  new URL('../runners/session-record.ts?session-regression', import.meta.url).href
);
mock.module('../runners/session-record.js', { namedExports: { ...sessionRecord } });
const { runReviewAgent }: typeof import('./review-agent.js') = await import(
  new URL('./review-agent.ts?session-regression', import.meta.url).href
);

test('recovered review completion uses the refreshed binding while its original snapshot stays stale', async () => {
  const result = await runReviewAgent(
    vars,
    'claude',
    'opus',
    'tasks/run-1',
    vars.slotId,
    run.id,
    100,
    2,
    'static-code',
    null,
    'warm',
    null,
    'lineage',
  );
  assert.equal(captureAttempts, 2);
  assert.equal(sentPrompts, 1);
  assert.equal(original.runnerSessionId, 'stale-session');
  assert.equal(usageSession, 'resumed-session');
  assert.equal(settledPath, '/resumed.jsonl');
  assert.equal(result.reviewerSessionId, 'resumed-session');
  assert.equal(result.session?.sessionId, 'resumed-session');
  assert.equal(result.session?.priorSessionId, 'stale-session');
});

test('the review-fix relaunch records the primary sibling before transcript creation', async () => {
  captured = { runnerSessionId: null, runnerSessionPath: null };
  const worker: AgentContext = {
    ...original,
    id: 'dev',
    role: 'dev',
    reviewId: undefined,
    runnerSessionId: null,
    runnerSessionPath: null,
    target: { session: 'slot-session', window: 'dev', pane: null, target: 'slot-session:dev' },
  };
  run = {
    ...makeRun({ slotId: vars.slotId, flowType: 'dev' }),
    agentContexts: [worker, { ...worker, id: 'review-fix', role: 'review-fix' }],
  };
  const { recordReviewFixRunnerSession }: typeof import('./orchestrator.js') = await import(
    new URL('./orchestrator.ts?session-regression', import.meta.url).href
  );
  await recordReviewFixRunnerSession(vars, run.id, 'claude', 'slot-session:dev');
  assert.deepEqual(
    run.agentContexts!.map((entry) => [entry.id, entry.target?.paneId, entry.runnerSessionId]),
    [
      ['dev', '%22', null],
      ['review-fix', '%22', null],
    ],
  );
});
