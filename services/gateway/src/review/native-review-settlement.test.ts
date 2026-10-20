import assert from 'node:assert/strict';
import { mock, test, type TestContext } from 'node:test';

import type { Principal } from '@farmslot/protocol';

await import('../runtime/mock-pty.test-support.js');
const config = await import('../core/config.js');
const checklist = await import('../tasks/checklist-target.js');
const snapshots = await import('./snapshots.js');
const reviewAgent = await import('./review-agent.js');
const { upsertAgentContext } = await import('../agents/contexts.js');
const { rewriteStatusFile } = await import('../core/state.js');
const { createRun, deleteRun, getRun, updateRun } = await import('../runs/store.js');
const { runWithSessionOriginator } = await import('../security/work-originator.js');
const { makeVars } = await import('../runners/test-fixtures.js');
const { NativeWorkerOperationUncertainError } = await import('../runners/native/worker-error.js');
const { PromptDeliveryUncertainError } = await import('../runners/registry.js');

type Ending =
  | 'timeout'
  | 'exit'
  | 'incomplete'
  | 'verdict'
  | 'uncertain-launch'
  | 'uncertain-delivery';
let ending: Ending = 'verdict';
const vars = makeVars();
const owner: Principal = {
  id: 'native-review-settlement-owner',
  subject: { type: 'person', displayName: 'Owner' },
  roles: [{ role: 'admin', scope: { kind: 'global' } }],
};
const binding = {
  sessionId: 'reviewer-session',
  executionNodeId: 'local',
  ownerPrincipalId: owner.id,
  leaseId: 'lease',
  generation: 'generation',
  commandId: 'review-command',
};
const noop = async () => {};

// The reviewer's host, slot files and runner are scripted; the run store and the
// review round budget are real.
mock.module('../core/config.js', {
  namedExports: { ...config, loadProjectVars: async () => ({ projectJson: {} }) },
});
// The reviewer's TASK.md, by path.
const slotFiles = new Map<string, string>();
mock.module('../methods/dispatch/slot-file-write.js', {
  namedExports: {
    writeTextFileOnSlot: async (_vars: unknown, file: string, content: string) => {
      slotFiles.set(file, content);
    },
  },
});
mock.module('../run-engine/run-monitor.js', {
  namedExports: {
    probeWorkerSignalForRun: async () =>
      ending === 'timeout' || ending === 'exit'
        ? { ok: false, code: 'missing', message: 'no signal' }
        : { ok: true },
  },
});
mock.module('../run-engine/stack-base.js', { namedExports: { stackPrBase: async () => null } });
mock.module('../runners/native/manager.js', { namedExports: { validateNativeRunner: () => {} } });
mock.module('../runners/native/review-owner.js', {
  namedExports: {
    nativeReviewerOwner: () => owner.id,
    nativeReviewerResultSchema: () => undefined,
  },
});
mock.module('../runners/native/worker.js', {
  namedExports: {
    cancelNativeWorkerContext: noop,
    dispatchNativeWorker: async (input: { runId: string; contextId: string }) => {
      await upsertAgentContext(input.runId, 'review', {
        id: input.contextId,
        status: 'working',
        nativeSession: binding,
      });
      // The host may have started the reviewer before its reply was lost.
      if (ending === 'uncertain-launch')
        throw new NativeWorkerOperationUncertainError('launch', 'launch reply lost', undefined);
      if (ending === 'uncertain-delivery')
        throw new PromptDeliveryUncertainError('review prompt delivery is unconfirmed');
    },
  },
});
mock.module('../runners/native/worker-control.js', {
  namedExports: {
    readNativeWorkerSnapshot: async () => ({
      session:
        ending === 'exit'
          ? { state: 'closed', processStopped: true, error: 'reviewer process exited' }
          : { state: 'running' },
      commands:
        ending === 'timeout' || ending === 'exit'
          ? []
          : [{ commandId: binding.commandId, state: 'completed', outcome: 'completed' }],
    }),
  },
});
mock.module('../runners/native/worker-recovery.js', { namedExports: { resumeNativeWorker: noop } });
mock.module('../security/native-worker-owner.js', {
  namedExports: { assertNativeRunOwner: () => {} },
});
mock.module('../tasks/checklist-target.js', {
  namedExports: {
    ...checklist,
    restoreWorkerChecklistTargetFromSlot: noop,
    syncChecklistTargetForRole: noop,
  },
});
mock.module('../tasks/watcher.js', { namedExports: { unwatchContext: noop } });
mock.module('./feedback.js', {
  namedExports: {
    readReviewFeedback: async () =>
      ending === 'incomplete'
        ? { verdict: 'pass', issues: [], incomplete: true }
        : { verdict: 'issues', issues: [{ file: 'a.ts', description: 'finding' }] },
  },
});
mock.module('./native-reviewer-approvals.js', {
  namedExports: { refuseReviewerApprovals: async () => 0 },
});
mock.module('./progress.js', { namedExports: { startProgressWatcher: () => ({ stop() {} }) } });
mock.module('./review-agent.js', {
  namedExports: {
    ...reviewAgent,
    persistReviewOutputArtifacts: async () => ({ artifactPaths: [] }),
    readTerminalReviewSignal: async () => null,
  },
});
mock.module('./reviewed-inputs.js', { namedExports: { noteReviewInputsAtLaunch: noop } });
mock.module('./snapshots.js', {
  namedExports: {
    ...snapshots,
    captureReviewSnapshot: async () => ({
      snapshot: {
        source: 'local-git',
        baseSha: 'b'.repeat(40),
        headSha: 'a'.repeat(40),
        diffPath: 'artifacts/review.diff',
        capturedAt: new Date().toISOString(),
      },
      artifactPaths: [],
    }),
    removeSlotFiles: noop,
  },
});
mock.module('./templates.js', {
  namedExports: { expandReviewTemplate: async () => '# Review\n' },
});

const { runNativeReviewAgent } = await import('./native-review-agent.js');
const { runReviewRoundBudget } = await import('./review-round-budget.js');

async function nativeRun(t: TestContext) {
  const previous = process.env.FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID;
  process.env.FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID = owner.id;
  const run = runWithSessionOriginator(owner, () =>
    createRun({
      flowType: 'dev',
      project: 'native-review-settlement',
      ticketOrPr: `SETTLE-${ending}`,
      slotId: vars.slotId,
      transport: 'native',
    }),
  );
  updateRun(run.id, { status: 'reviewing', taskFile: 'tasks/review/TASK.md' });
  const slotRow = (row: Record<string, unknown>[]) =>
    rewriteStatusFile((current) => ({
      ...current,
      slots: [...(current?.slots ?? []).filter((entry) => entry.slot !== vars.slotId), ...row],
    }));
  t.after(async () => {
    await slotRow([]);
    const closedAt = new Date().toISOString();
    updateRun(run.id, {
      status: 'done',
      completedAt: closedAt,
      agentContexts: getRun(run.id)!.agentContexts?.map((context) =>
        context.nativeSession
          ? { ...context, nativeSession: { ...context.nativeSession, closedAt } }
          : context,
      ),
    });
    await deleteRun(run.id);
    if (previous === undefined) delete process.env.FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID;
    else process.env.FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID = previous;
  });
  await slotRow([{ slot: vars.slotId, current_run_id: run.id }]);
  return run;
}

const review = (runId: string) =>
  runNativeReviewAgent({
    vars,
    runner: 'claude',
    model: 'opus',
    taskDir: 'tasks/review',
    runId,
    reviewTimeoutMs: ending === 'timeout' ? 0 : 60_000,
    loopNumber: 1,
    validationDepth: 'static-code',
    mode: 'cold',
    reviewId: `pipeline-review-${runId}`,
  });

for (const [end, reason] of [
  ['timeout', /did not complete within 0ms/],
  ['exit', /reviewer process exited/],
] as const) {
  test(`a reviewer ${end} settles its admitted round no-verdict`, async (t) => {
    ending = end;
    const run = await nativeRun(t);
    await assert.rejects(review(run.id));
    const settled = Object.values(getRun(run.id)!.reviewRoundSettlements ?? {});
    assert.equal(settled.length, 1);
    assert.match(settled[0]!.reason, reason);
    const budget = await runReviewRoundBudget(getRun(run.id)!);
    assert.deepEqual([budget.used, budget.noVerdict], [0, 1]);
  });
}

test('a reviewer that leaves no feedback file settles no-verdict; a verdict counts', async (t) => {
  ending = 'incomplete';
  const incomplete = await nativeRun(t);
  assert.equal((await review(incomplete.id)).incomplete, true);
  assert.deepEqual(
    Object.values(getRun(incomplete.id)!.reviewRoundSettlements ?? {}).map((entry) => entry.reason),
    ['no-feedback-file'],
  );

  ending = 'verdict';
  const reviewed = await nativeRun(t);
  assert.equal((await review(reviewed.id)).verdict, 'issues');
  assert.equal(getRun(reviewed.id)!.reviewRoundSettlements, undefined);
  const budget = await runReviewRoundBudget(getRun(reviewed.id)!);
  assert.deepEqual([budget.used, budget.noVerdict], [1, 0]);
});

test('a slot reviewer is told to keep probe tests and scratch out of the checkout', async (t) => {
  // A gate reviewer's probe tests in the task's artifacts broke the product's unit run.
  ending = 'verdict';
  const run = await nativeRun(t);
  await review(run.id);
  const reviewer = getRun(run.id)!.agentContexts!.find((context) => context.role === 'review')!;
  const contract = slotFiles.get(reviewer.taskFile!) ?? '';
  assert.match(contract, /^## Reviewer-specific execution contract/);
  assert.ok(contract.includes(`\${TMPDIR:-/tmp}/farmslot-review/${reviewer.id}`));
  assert.match(contract, /write nothing in the checkout/);
  assert.match(contract, /delete it before you write your result/);
});

for (const [end, uncertainty] of [
  ['uncertain-launch', NativeWorkerOperationUncertainError],
  ['uncertain-delivery', PromptDeliveryUncertainError],
] as const) {
  test(`an ${end.replace('-', ' ')} leaves its round counted while the reviewer may run`, async (t) => {
    ending = end;
    const run = await nativeRun(t);
    await assert.rejects(review(run.id), uncertainty);
    assert.equal(getRun(run.id)!.reviewRoundSettlements, undefined);
    const budget = await runReviewRoundBudget(getRun(run.id)!);
    assert.deepEqual([budget.used, budget.noVerdict], [1, 0]);
  });
}
