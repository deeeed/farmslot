import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, mock, test } from 'node:test';

import type { ProjectCICheckGroup, PRStatus, PRStatusParams } from '@farmslot/protocol';

import type { PRRawSnapshot } from '../methods/pr/raw-cache.js';
import type { CIWatchStepContext } from '../run-engine/ci-watch-step.js';

process.env.FARMSLOT_RUNS_DIR = mkdtempSync(path.join(tmpdir(), 'f415-infrastructure-'));
const githubClient = await import('../integrations/github-client.js');
mock.module('../integrations/github-client.js', {
  namedExports: {
    ...githubClient,
    ghRequest: async (args: string[], opts?: { force?: boolean }) => {
      assert.equal(opts?.force, true);
      if (args[0] === 'pr' && args[1] === 'checks') {
        throw new Error('HTTP 503: checks unavailable');
      }
      return {
        stdout:
          args[0] === 'pr' && args[1] === 'view' ? 'OPEN\tMERGEABLE\tCLEAN\t\tfix/product' : '',
        stderr: '',
      };
    },
  },
});
const { getPRRawData, synthesizeRawSnapshotFromGraphQL } =
  await import('../methods/pr/raw-cache.js');
const prMethods = await import('../methods/pr.js');
let conclusions: Array<[string, string]> = [];
let fixInputs: string[][] = [];
let checkGroups: ProjectCICheckGroup[] = [];
let deduped = false;
let fixSuccess = false;
let nextForcedObservation: 'unavailable' | 'partial' | undefined;
let incompleteRaw: PRRawSnapshot | undefined;
let checkObservations: PRStatus[] = [];
const config = await import('../core/config.js');
mock.module('../core/config.js', {
  namedExports: {
    ...config,
    loadProjectVars: async () => ({ projectJson: {} }),
  },
});
mock.module('../methods/pr.js', {
  namedExports: {
    ...prMethods,
    prStatus: async (params: PRStatusParams) => {
      let raw: PRRawSnapshot = {
        prStateStdout: 'OPEN\tMERGEABLE\tCLEAN\t\tfix/product',
        checksStdout: synthesizeRawSnapshotFromGraphQL({
          statusCheckRollup: {
            contexts: {
              nodes: conclusions.map(([name, conclusion]) => ({
                __typename: 'CheckRun',
                name,
                status: 'COMPLETED',
                conclusion,
              })),
            },
          },
        }).checksStdout,
        checksAvailable: true,
        commentsStdout: '',
        reviewCommentsStdout: '',
        latestCommitStdout: '',
        reviewMetaStdout: '',
        fetchedAt: 1000,
      };
      if (params.force && nextForcedObservation) {
        const observation = nextForcedObservation;
        nextForcedObservation = undefined;
        raw =
          observation === 'unavailable'
            ? await getPRRawData('example/product', 42, true)
            : { ...raw, checksStdout: '', partial: true };
        incompleteRaw = raw;
      }
      const pr = prMethods.projectPRData(
        raw,
        {
          prNum: 42,
          project: 'example-web-farm',
          repo: 'example/product',
          runs: [],
          includeCheckSnapshot: true,
        },
        { ci: { checkGroups, botPatterns: [] } },
      );
      checkObservations.push(pr);
      return { pr };
    },
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
const core = await import('../core/index.js');
mock.module('../core/index.js', {
  namedExports: { ...core, markSlotHeld: async () => {}, updateSlotStatus: async () => {} },
});
const posture = await import('../run-engine/resource-posture.js');
mock.module('../run-engine/resource-posture.js', {
  namedExports: { ...posture, reconcileRunPosture: async () => {} },
});
const sourceRuntime = await import('../sources/runtime.js');
mock.module('../sources/runtime.js', {
  namedExports: {
    ...sourceRuntime,
    withSourcePlanning: async (_project: string, action: () => unknown) => action(),
  },
});
const { monitorCI, resolveCIDecision } = await import('./service.js');
const { executeCIWatchStep } = await import('../run-engine/ci-watch-step.js');
const { createRun, getAllRuns, getRun, loadAllRuns, persistRunNow } =
  await import('../runs/store.js');
await loadAllRuns();
after(async () => {
  await Promise.all(getAllRuns().map((run) => persistRunNow(run)));
  rmSync(process.env.FARMSLOT_RUNS_DIR!, { recursive: true, force: true });
});

for (const state of ['CANCELLED', 'TIMED_OUT', 'STARTUP_FAILURE', 'ACTION_REQUIRED']) {
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
  'SUCCESS plus STALE retains the producer skipping bucket in an all aggregate',
  { timeout: 2000 },
  async () => {
    conclusions = [
      ['unit / 1', 'SUCCESS'],
      ['unit / 2', 'STALE'],
    ];
    checkGroups = [{ name: 'Unit', match: 'unit /', matchMode: 'includes', aggregate: 'all' }];
    fixInputs = [];
    try {
      const run = createRun({
        flowType: 'dev',
        project: 'example-web-farm',
        ticketOrPr: 'F415',
        mode: 'validation',
      });
      const outcome = await monitorCI(run.id, 42, 'example/product', new AbortController().signal);
      assert.equal(outcome.result, 'passed');
      assert.deepEqual(fixInputs, []);
      assert.deepEqual(getRun(run.id)?.decisions, []);
    } finally {
      checkGroups = [];
    }
  },
);

for (const resolved of [false, true]) {
  for (const blocker of [
    'infrastructure',
    'scope refusal',
    'unavailable checks',
    'partial checks',
  ]) {
    test(
      `${resolved ? 'resolved' : 'pending'} recovered repair cannot dispatch with ${blocker}`,
      { timeout: 2000 },
      async () => {
        const refusal = blocker === 'scope refusal';
        const incomplete = blocker === 'unavailable checks' || blocker === 'partial checks';
        conclusions = refusal ? [] : [['unit-tests', 'TIMED_OUT']];
        fixInputs = [];
        nextForcedObservation = undefined;
        incompleteRaw = undefined;
        checkObservations = [];
        const run = createRun({
          flowType: 'dev',
          project: 'example-web-farm',
          ticketOrPr: 'F415',
          mode: 'validation',
          slotId: 'fixture-slot',
        });
        const decision = {
          id: `retained-${run.id}`,
          type: 'ci_inline_fix_blocked' as const,
          title: 'Previous code failure',
          description: 'Repair the code',
          actions: [{ id: 'dispatch-pr-complete', label: 'Repair', style: 'primary' as const }],
          createdAt: '2026-11-01T00:00:00Z',
          ...(resolved
            ? { resolvedAt: '2026-11-01T00:01:00Z', resolvedAction: 'dispatch-pr-complete' }
            : {}),
        };
        const retainedDecision = structuredClone(decision);
        const { updateRun } = await import('../runs/store.js');
        updateRun(run.id, {
          prNumber: 42,
          decisions: [decision],
          ...(refusal
            ? {
                ciWatchState: {
                  consecutiveAttempts: 1,
                  totalAttempts: 1,
                  skips: 0,
                  fixScopeRefusal: 'CI_FIX_OUT_OF_SCOPE: unrelated.ts',
                },
              }
            : {}),
        });
        let dispatched = 0;
        const context: CIWatchStepContext = {
          activeMonitors: new Map(),
          createRetrospectiveForRun: async () => {},
          applyChainedRunEngineFlags: () => {},
          broadcastFn: () => {},
          buildCIWatchChainedRunParams: (_current, action) => {
            if (action === 'dispatch-pr-complete') dispatched++;
            return null;
          },
          hasValidPrNumber: () => true,
          loadProjectVarsOrNull: async () => ({ projectJson: { ci: { repo: 'example/product' } } }),
          resolveCIWatchTerminalPatch: () => null,
          startRun: async () => {},
          deferTerminalSlotRelease: () => {},
        };
        const armIncompleteObservation = () => {
          if (!incomplete) return;
          checkObservations = [];
          nextForcedObservation = blocker === 'unavailable checks' ? 'unavailable' : 'partial';
        };
        if (resolved) armIncompleteObservation();
        const running = executeCIWatchStep(run.id, context);
        if (!resolved) {
          // A retained card is re-presented by recovery with its original actions.
          // Resolve it once the monitor has installed its resolver.
          while (
            getRun(run.id)?.steps.find((step) => step.name === 'ci-watch')?.outputs?.phase !==
            'decision_required'
          ) {
            await new Promise<void>((resolve) => setImmediate(resolve));
          }
          armIncompleteObservation();
          resolveCIDecision(decision.id, 'dispatch-pr-complete');
        }
        const result = await running;
        assert.equal(dispatched, 0);
        assert.equal(result.outputs?.result, 'aborted');
        assert.deepEqual(getRun(run.id)?.decisions[0], {
          ...retainedDecision,
          resolvedAt: getRun(run.id)?.decisions[0].resolvedAt,
          resolvedAction: 'dispatch-pr-complete',
        });
        assert.equal(getRun(run.id)?.decisions.length, 2);
        assert.deepEqual(
          getRun(run.id)
            ?.decisions.at(-1)
            ?.actions.map((action) => action.id),
          ['wait', 'abort'],
        );
        if (incomplete) {
          assert.equal(nextForcedObservation, undefined);
          if (blocker === 'unavailable checks') {
            assert.equal(incompleteRaw?.checksAvailable, false);
            assert.equal(incompleteRaw?.checksStdout, '');
            assert.deepEqual(incompleteRaw?.errors, ['pr.checks#42: HTTP 503: checks unavailable']);
          } else {
            assert.equal(incompleteRaw?.checksAvailable, true);
            assert.equal(incompleteRaw?.partial, true);
          }
          assert.equal(checkObservations[0]?.checkSnapshot, undefined);
          assert.equal(checkObservations[1]?.checkSnapshot?.checks[0]?.conclusion, 'TIMED_OUT');
          assert.match(
            getRun(run.id)?.decisions.at(-1)?.description ?? '',
            /CI infrastructure\/timeout failure: unit-tests \(TIMED_OUT\)/,
          );
        }
        assert.deepEqual(fixInputs, []);
      },
    );
  }
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
