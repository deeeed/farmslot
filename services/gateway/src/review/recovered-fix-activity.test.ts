import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

import '../runtime/mock-pty.test-support.js';

import { makeVars } from '../runners/test-fixtures.js';

const vars = makeVars({ slotId: 'recovered-fix-activity', projectName: 'recovered-fix-activity' });
let ended = false;
let activityReads = 0;
let enteredWait = () => {};
const config = await import('../core/config.js');
mock.module('../core/config.js', {
  namedExports: {
    ...config,
    loadSlotVars: async () => vars,
    loadProjectVars: async () => ({ projectJson: { review: { enabled: true, max_retries: 1 } } }),
  },
});
const execution = await import('../core/exec.js');
mock.module('../core/exec.js', {
  namedExports: {
    ...execution,
    execOnSlot: async (_vars: unknown, command: string) => {
      if (command.includes('REVIEW-FIX-SIGNAL.json'))
        return {
          exitCode: 0,
          stderr: '',
          stdout: JSON.stringify({
            attemptId: 'retained-attempt',
            status: ended ? 'blocked' : 'running',
            ...(ended ? { reason: 'Fixture stopped after the activity probe' } : {}),
            timestamp: new Date(ended ? Date.now() : 0).toISOString(),
          }),
        };
      if (command.includes('REVIEW-FIX.md'))
        return {
          exitCode: 0,
          stderr: '',
          stdout: '## Findings\n\n- **a.ts:1** — fix the finding\n',
        };
      throw new Error(`Unexpected recovery fixture command: ${command}`);
    },
  },
});
const templates = await import('./templates.js');
mock.module('./templates.js', {
  namedExports: {
    ...templates,
    getReviewConfig: async () => ({ enabled: true, max_retries: 1 }),
    resolveWorkerTaskDir: async () => 'tasks/review',
  },
});
const capabilities = await import('../run-engine/declared-capabilities.js');
mock.module('../run-engine/declared-capabilities.js', {
  namedExports: { ...capabilities, prepareRetainedRunCapabilities: async () => {} },
});
const checklist = await import('../tasks/checklist-target.js');
mock.module('../tasks/checklist-target.js', {
  namedExports: {
    ...checklist,
    syncChecklistTargetForRole: async () => {},
    restoreWorkerChecklistTargetFromSlot: async () => {},
  },
});
const native = await import('./native-fix.js');
mock.module('./native-fix.js', {
  namedExports: {
    ...native,
    deliverNativeFix: async () => ({ status: 'delivered' }), // retained receipt has no delivery token
    nativeFixTurnIsActive: async (_runId: string, command: string) => {
      assert.equal(command, 'owned-command');
      activityReads++;
      return true;
    },
  },
});
const progress = await import('./progress.js');
mock.module('./progress.js', {
  namedExports: {
    ...progress,
    startProgressWatcher: () => {
      enteredWait();
      return { stop: async () => {}, ready: Promise.resolve() };
    },
  },
});
const snapshots = await import('./snapshots.js');
mock.module('./snapshots.js', {
  namedExports: {
    ...snapshots,
    captureFixDeltaSnapshot: async () => ({
      snapshot: {
        source: 'local-git',
        capturedAt: new Date().toISOString(),
        fixBaseSha: null,
        fixHeadSha: null,
        diffStat: { files: 0, additions: 0, deletions: 0 },
      },
      artifactPaths: [],
    }),
  },
});
const reviewer = await import('./native-review-agent.js');
mock.module('./native-review-agent.js', {
  namedExports: {
    ...reviewer,
    runNativeReviewAgent: async () => assert.fail('A recovered fix must not launch another review'),
  },
});
const { createRun, getRun, updateRun } = await import('../runs/store.js');
const { rewriteStatusFile } = await import('../core/state.js');
const { deleteTestRunIfPresent } = await import('../run-engine/test-fixtures.js');
// The native and capability readers can preload the facade before their mocks exist.
const recoveryModule = './orchestrator.js?recovered-activity';
const { executeReview }: typeof import('./orchestrator.js') = await import(recoveryModule);

async function flush() {
  for (let i = 0; i < 8; i++) await new Promise((resolve) => setImmediate(resolve));
}

test('recovered tokenless fix waits invoke activity observation without a new review', async (t) => {
  ended = false;
  activityReads = 0;
  const priorOwner = process.env.FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID;
  process.env.FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID = 'recovery-fixture-owner';
  t.after(() => {
    if (priorOwner === undefined) delete process.env.FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID;
    else process.env.FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID = priorOwner;
  });
  const run = createRun(
    {
      flowType: 'dev',
      mode: 'interactive',
      project: vars.projectName,
      ticketOrPr: 'RECOVERED-FIX-ACTIVITY',
      runner: 'claude',
      slotId: vars.slotId,
      transport: 'native',
    },
    { nativeOwnerPrincipalId: 'recovery-fixture-owner' },
  );
  const slotRow = (remove = false) =>
    rewriteStatusFile((state) => ({
      ...state,
      slots: [
        ...(state?.slots ?? []).filter((slot) => slot.slot !== vars.slotId),
        ...(remove ? [] : [{ slot: vars.slotId, current_run_id: run.id }]),
      ],
    }));
  await slotRow();
  t.after(async () => {
    t.mock.timers.reset();
    await slotRow(true);
    await deleteTestRunIfPresent(run.id);
  });
  updateRun(run.id, {
    status: 'reviewing',
    taskFile: '/fixture/tasks/review/TASK.md',
    agentContexts: [
      {
        id: 'review-fix',
        role: 'review-fix',
        label: 'Retained fix',
        status: 'working',
        runId: run.id,
        slotId: vars.slotId,
        runner: 'claude',
        nativeCommandId: 'owned-command',
        taskFile: 'tasks/review/REVIEW-FIX.md',
        signalFile: 'tasks/review/REVIEW-FIX-SIGNAL.json',
        signalAttemptId: 'retained-attempt',
        artifactScope: null,
      },
    ],
  });
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  const waiting = new Promise<void>((resolve) => {
    enteredWait = resolve;
  });
  const reviewing = executeReview(run.id, vars.slotId, {
    reviewRunner: 'claude',
    validationDepth: 'static-code',
    maxRetries: 1,
  });
  await Promise.race([
    waiting,
    reviewing.then(() => {
      throw new Error('Recovery returned before entering its signal wait');
    }),
  ]);
  await flush();
  try {
    t.mock.timers.tick(2000);
    await flush();
    assert.ok(
      activityReads > 0,
      'recovery must pass an activity callback even without delivery.turnToken',
    );
    assert.equal(getRun(run.id)?.agentContexts?.[0]?.status, 'working');
  } finally {
    ended = true;
    t.mock.timers.tick(2000);
    await flush();
    await reviewing;
  }
  assert.equal(
    getRun(run.id)?.agentContexts?.find((context) => context.id === 'review-fix')?.status,
    'blocked',
  );
});
