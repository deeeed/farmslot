import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, mock, test } from 'node:test';

import type { ProjectCICheckGroup } from '@farmslot/protocol';

process.env.FARMSLOT_RUNS_DIR = mkdtempSync(path.join(tmpdir(), 'f415-infrastructure-'));
const prMethods = await import('../methods/pr.js');
let conclusions: Array<[string, string]> = [];
let fixInputs: string[][] = [];
let checkGroups: ProjectCICheckGroup[] = [];
let deduped = false;
let fixSuccess = false;
mock.module('../core/config.js', {
  namedExports: {
    loadProjectVars: async () => ({ projectJson: {} }),
  },
});
mock.module('../methods/pr.js', {
  namedExports: {
    ...prMethods,
    prStatus: async () => ({
      pr: prMethods.projectPRData(
        {
          prStateStdout: 'OPEN\tMERGEABLE\tCLEAN\t\tfix/product',
          checksStdout: conclusions
            .map(
              ([name, state]) =>
                `${name}\t${state === 'CANCELLED' ? 'cancel' : 'fail'}\t\t\t${state}`,
            )
            .join('\n'),
          checksAvailable: true,
          commentsStdout: '',
          reviewCommentsStdout: '',
          latestCommitStdout: '',
          reviewMetaStdout: '',
          fetchedAt: 1000,
        },
        {
          prNum: 42,
          project: 'example-web-farm',
          repo: 'example/product',
          runs: [],
          includeCheckSnapshot: true,
        },
        { ci: { checkGroups, botPatterns: [] } },
      ),
    }),
  },
});
mock.module('./inline-fix.js', {
  namedExports: {
    getSlotHeadSha: async () => null,
    isInlineFixDedupedNow: async () => deduped,
    rerunFailedChecks: async () => {
      throw new Error('Unexpected rerun');
    },
    tryInlineCIFix: async (_run: string, _slot: string, _comments: unknown[], checks: string[]) => {
      fixInputs.push(checks);
      return {
        attempted: true,
        success: fixSuccess,
        blocked: !fixSuccess,
        commitSha: 'fixed',
        attempts: 1,
        blockedReason: 'fixture blocked',
      };
    },
  },
});
const { monitorCI } = await import('./service.js');
const { createRun, getAllRuns, getRun, loadAllRuns, persistRunNow } =
  await import('../runs/store.js');
await loadAllRuns();
after(async () => {
  await Promise.all(getAllRuns().map((run) => persistRunNow(run)));
  rmSync(process.env.FARMSLOT_RUNS_DIR!, { recursive: true, force: true });
});

for (const state of ['CANCELLED', 'TIMED_OUT', 'STARTUP_FAILURE', 'STALE', 'ACTION_REQUIRED']) {
  test(
    `${state} reaches the operator without dispatching a CI fix`,
    { timeout: 2000 },
    async () => {
      conclusions = [['unit-tests', state]];
      fixInputs = [];
      const run = createRun({
        flowType: 'dev',
        project: 'example-web-farm',
        ticketOrPr: 'F415',
        mode: 'validation',
      });
      const outcome = await monitorCI(run.id, 42, 'example/product', new AbortController().signal);
      assert.deepEqual(fixInputs, []);
      assert.equal(outcome.result, 'aborted');
      const decision = getRun(run.id)?.decisions.at(-1);
      assert.equal(decision?.type, 'ci_inline_fix_blocked');
      assert.equal(
        decision?.description,
        `CI fix could not be validated for PR #42: CI infrastructure/timeout failure: unit-tests (${state}). Handle outside the PR. The PR still needs attention.`,
      );
    },
  );
}

test(
  'mixed failures send only code failures to the fix and report infrastructure',
  { timeout: 2000 },
  async () => {
    conclusions = [
      ['unit-tests', 'CANCELLED'],
      ['lint', 'FAILURE'],
    ];
    fixInputs = [];
    const run = createRun({
      flowType: 'dev',
      project: 'example-web-farm',
      ticketOrPr: 'F415',
      mode: 'validation',
    });
    await monitorCI(run.id, 42, 'example/product', new AbortController().signal);
    assert.deepEqual(fixInputs, [['lint']]);
    assert.equal(
      getRun(run.id)?.decisions.at(-1)?.description,
      'CI fix could not be validated for PR #42: fixture blocked. CI infrastructure/timeout failure: unit-tests (CANCELLED). Handle outside the PR. The PR still needs attention.',
    );
  },
);

test(
  'mixed shards retain their own conclusions inside an aggregated watched group',
  { timeout: 2000 },
  async () => {
    conclusions = [
      ['unit / 1', 'CANCELLED'],
      ['unit / 2', 'FAILURE'],
      ['unwatched', 'FAILURE'],
    ];
    checkGroups = [{ name: 'Unit', match: 'unit /', matchMode: 'includes', aggregate: 'all' }];
    fixInputs = [];
    const run = createRun({
      flowType: 'dev',
      project: 'example-web-farm',
      ticketOrPr: 'F415',
      mode: 'validation',
    });
    await monitorCI(run.id, 42, 'example/product', new AbortController().signal);
    assert.deepEqual(fixInputs, [['unit / 2']]);
    assert.equal(
      getRun(run.id)?.decisions.at(-1)?.description,
      'CI fix could not be validated for PR #42: fixture blocked. CI infrastructure/timeout failure: unit / 1 (CANCELLED). Handle outside the PR. The PR still needs attention.',
    );
    checkGroups = [];
  },
);

for (const alreadyFixed of [true, false]) {
  test(
    `mixed infrastructure is reported after a ${alreadyFixed ? 'deduped' : 'successful'} code fix`,
    { timeout: 2000 },
    async () => {
      conclusions = [
        ['unit-tests', 'TIMED_OUT'],
        ['lint', 'FAILURE'],
      ];
      deduped = alreadyFixed;
      fixSuccess = true;
      fixInputs = [];
      const run = createRun({
        flowType: 'dev',
        project: 'example-web-farm',
        ticketOrPr: 'F415',
        mode: 'validation',
      });
      const outcome = await monitorCI(run.id, 42, 'example/product', new AbortController().signal);
      assert.equal(outcome.result, 'aborted');
      assert.deepEqual(fixInputs, alreadyFixed ? [] : [['lint']]);
      const decision = getRun(run.id)?.decisions.at(-1);
      assert.equal(
        decision?.description,
        'CI fix could not be validated for PR #42: CI infrastructure/timeout failure: unit-tests (TIMED_OUT). Handle outside the PR. The PR still needs attention.',
      );
      assert.deepEqual(
        decision?.actions.map((action) => action.id),
        ['wait', 'abort'],
      );
      deduped = fixSuccess = false;
    },
  );
}

test(
  'a retained scope refusal reaches the operator even after checks turn green',
  { timeout: 2000 },
  async () => {
    conclusions = [];
    fixInputs = [];
    const run = createRun({
      flowType: 'dev',
      project: 'example-web-farm',
      ticketOrPr: 'F415',
      mode: 'validation',
    });
    const { updateRun } = await import('../runs/store.js');
    updateRun(run.id, {
      ciWatchState: {
        consecutiveAttempts: 1,
        totalAttempts: 1,
        skips: 0,
        fixScopeRefusal:
          'Branch maintenance refused: CI_FIX_OUT_OF_SCOPE: .github/workflows/validate.yml',
      },
    });
    const outcome = await monitorCI(run.id, 42, 'example/product', new AbortController().signal);
    assert.equal(outcome.result, 'aborted');
    assert.deepEqual(fixInputs, []);
    assert.equal(
      getRun(run.id)?.decisions.at(-1)?.description,
      'CI fix could not be validated for PR #42: Branch maintenance refused: CI_FIX_OUT_OF_SCOPE: .github/workflows/validate.yml. The PR still needs attention.',
    );
  },
);

test(
  'infrastructure is reported even when the retained CI wait window expired',
  { timeout: 2000 },
  async () => {
    conclusions = [['unit-tests', 'CANCELLED']];
    fixInputs = [];
    const run = createRun({
      flowType: 'dev',
      project: 'example-web-farm',
      ticketOrPr: 'F415',
      mode: 'validation',
    });
    const { updateRun } = await import('../runs/store.js');
    updateRun(run.id, {
      ciWatchState: {
        consecutiveAttempts: 0,
        totalAttempts: 0,
        skips: 0,
        timeoutWindowStartedAt: new Date(0).toISOString(),
      },
    });
    await monitorCI(run.id, 42, 'example/product', new AbortController().signal);
    assert.deepEqual(fixInputs, []);
    const decision = getRun(run.id)?.decisions.at(-1);
    assert.equal(decision?.type, 'ci_inline_fix_blocked');
    assert.equal(
      decision?.description,
      'CI fix could not be validated for PR #42: CI infrastructure/timeout failure: unit-tests (CANCELLED). Handle outside the PR. The PR still needs attention.',
    );
  },
);

test(
  'an old repair decision cannot auto-dispatch an infrastructure failure',
  { timeout: 2000 },
  async () => {
    conclusions = [['unit-tests', 'CANCELLED']];
    fixInputs = [];
    const run = createRun({
      flowType: 'dev',
      project: 'example-web-farm',
      ticketOrPr: 'F415',
      mode: 'validation',
    });
    const { updateRun } = await import('../runs/store.js');
    updateRun(run.id, {
      decisions: [
        {
          id: 'previous',
          type: 'ci_inline_fix_blocked',
          title: 'Previous failure',
          description: 'Previous code failure',
          actions: [{ id: 'dispatch-pr-complete', label: 'Repair', style: 'primary' }],
          createdAt: '2026-11-01T00:00:00Z',
          resolvedAt: '2026-11-01T00:01:00Z',
          resolvedAction: 'dispatch-pr-complete',
        },
      ],
    });
    const outcome = await monitorCI(run.id, 42, 'example/product', new AbortController().signal);
    assert.equal(outcome.result, 'aborted');
    assert.deepEqual(fixInputs, []);
    assert.equal(getRun(run.id)?.decisions.length, 2);
    assert.deepEqual(
      getRun(run.id)
        ?.decisions.at(-1)
        ?.actions.map((action) => action.id),
      ['wait', 'abort'],
    );
  },
);
