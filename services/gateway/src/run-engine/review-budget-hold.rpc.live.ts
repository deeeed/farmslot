// Opt-in isolated REVIEW stop with the operator's real GatewayClient. No model or farm allocation.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { mock } from 'node:test';
import { fileURLToPath } from 'node:url';

import { isRecord, type RunExtendReviewBudgetResult, type RunGetResult } from '@farmslot/protocol';

import { createNativeProofFixture } from '../runtime/native-proof-fixture.live-support.js';

import type { PostDispatchStepContext } from './post-dispatch-steps.js';

const blockedReview = process.env.FARMSLOT_REVIEW_BUDGET_HOLD_CASE === 'blocked-review';

test(
  blockedReview
    ? 'a blocked delivered review exposes its result decision over RPC'
    : 'spent budget keeps its owned source across the operator extension RPC',
  { timeout: 60_000 },
  async (t) => {
    assert.equal(process.env.FARMSLOT_REVIEW_BUDGET_HOLD_LIVE, '1');
    const out = process.env.FARMSLOT_REVIEW_BUDGET_HOLD_OUT;
    assert(out);
    const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
    const root = await mkdtemp(path.join(os.tmpdir(), 'review-budget-hold-'));
    Object.assign(process.env, {
      NODE_TEST_CONTEXT: '1',
      FARMSLOT_ROOT: root,
      FARMSLOT_HOME: root,
      FARMSLOT_RUNS_DIR: path.join(root, 'runs'),
      FARMSLOT_POOL_DIR: path.join(root, 'pool'),
      FARMSLOT_PROJECTS_DIR: path.join(root, 'projects'),
      FARMSLOT_TEST_STATUS_FILE: path.join(root, 'status.json'),
      FARMSLOT_DISABLE_ORCHESTRATION: '1',
    });
    await mkdir(out, { recursive: true });
    for (const name of [
      'scripts',
      'packages',
      'services',
      'node_modules',
      'schemas',
      'package.json',
      'CLAUDE.md',
    ])
      await symlink(path.join(source, name), path.join(root, name));
    const repo = path.join(root, 'repo');
    await mkdir(repo);
    const git = (...args: string[]) =>
      execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
    git('init', '-q', '-b', 'owned-change');
    await writeFile(path.join(repo, 'README.md'), 'Owned budget fixture.');
    git('add', '.');
    git(
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '-qm',
      'fixture',
    );
    const head = git('rev-parse', 'HEAD'),
      slot = 'budget-slot';
    await mkdir(path.join(root, 'pool'));
    await mkdir(path.join(root, 'projects/budget'), { recursive: true });
    await writeFile(
      path.join(root, 'pool/local.json'),
      JSON.stringify({
        machine: os.hostname(),
        host: 'localhost',
        ssh_user: os.userInfo().username,
        project: 'budget',
        platform: 'cli',
        slots: [{ id: slot, repo, resources: {} }],
      }),
    );
    await writeFile(
      path.join(root, 'projects/budget/project.json'),
      JSON.stringify({ name: 'budget', hooks: {}, review: { enabled: true } }),
    );
    await import('../runtime/mock-pty.test-support.js');
    const scheduled: string[] = [];
    if (blockedReview) {
      const engine = await import('./orchestrator.js');
      const startRun = async (runId: string) => {
        scheduled.push(runId);
      };
      mock.module('./orchestrator.js', { namedExports: { ...engine, startRun } });
      assert.equal((await import('./orchestrator.js')).startRun, startRun);
    }
    const fixture = await createNativeProofFixture(t, root);
    const store = await import('../runs/store.js');
    const { statusFile } = await import('../core/state.js');
    const { recordedReviewRounds } =
      await import('../review/recorded-review-rounds.test-support.js');
    const { assertReviewRoundAvailable } = await import('../review/review-round-budget.js');
    const { executeReviewStep } = await import('./post-dispatch-steps.js');
    const { ResultDecisionHoldError, holdRunForResultDecision, takeSendBackReview } =
      await import('../run-completion/result-decision.js');
    const { retainRunFixture } = await import('./test-fixtures.js');
    const run = store.createRun({
      project: 'budget',
      flowType: 'fix-bug',
      mode: 'autonomous',
      ticketOrPr: 'BUDGET-REPRO',
    });
    try {
      const task = path.join(root, 'task');
      await mkdir(path.join(task, 'artifacts'), { recursive: true });
      await writeFile(path.join(task, 'TASK.md'), '# Budget fixture');
      await writeFile(
        path.join(task, 'artifacts/report.md'),
        'Delivered result waiting for its reviewer.',
      );
      store.updateRun(run.id, {
        status: 'reviewing',
        slotId: slot,
        branch: 'owned-change',
        taskFile: path.join(task, 'TASK.md'),
        ...recordedReviewRounds(
          Array.from({ length: blockedReview ? 3 : 5 }, (_, i) => `spent-${i}`),
        ),
        steps: [
          {
            name: 'monitor',
            status: 'done',
            outputs: { workerSignal: { status: 'complete' }, pushVerification: { verified: true } },
          },
          { name: 'review', status: 'running' },
          { name: 'complete', status: 'pending' },
          { name: 'human-gate', status: 'pending' },
          { name: 'finalize', status: 'pending' },
          { name: 'ci-watch', status: 'pending' },
        ],
        output: {
          workerFinished: true,
          capturedAt: new Date().toISOString(),
          artifactManifest: [],
          manifestDigest: 'a'.repeat(64),
          reportPath: 'artifacts/report.md',
        },
      });
      const captured = store.getRun(run.id);
      assert(captured);
      await retainRunFixture(captured);
      await writeFile(
        statusFile,
        JSON.stringify({
          updated_at: new Date().toISOString(),
          slots: [
            {
              slot,
              machine: os.hostname(),
              project: 'budget',
              platform: 'cli',
              current_run_id: run.id,
              slot_epoch: 7,
              lifecycle: 'busy',
              phase: 'working',
            },
          ],
        }),
      );
      const context: PostDispatchStepContext = {
        activeMonitors: new Map(),
        blockedRunError: (m) => new Error(m),
        broadcastFn: () => {},
        createEngineDecision: async () => assert.fail('no alternate decision'),
        executeNoChangeGate: async () => {},
        executePublishGateReviewPlan: async () => ({ reviewIds: [] }),
        executeReadyGate: async () => assert.fail('no publication'),
        executeReviewGate: async () => {},
        getDiffStat: async () => ({ files: 1, additions: 1, deletions: 0 }),
        interactiveLightweightSkipOutputs: () => ({}),
        isHumanGateEnabled: async () => true,
        monitorTerminalError: () => new Error('no monitor'),
        refreshRunLinks: async () => {},
        stepPartialIO: new Map(),
        deferTerminalSlotRelease: () => assert.fail('budget stop must not release'),
        executeReviewForRun: async () => {
          if (blockedReview)
            return {
              verdict: 'blocked',
              reason: 'The remaining fix requires an operator decision.',
              issues: [
                { file: 'README.md', description: 'The remaining fix needs an upstream change.' },
              ],
              retryCount: 3,
              maxRetries: 3,
              reviewSnapshot: {
                source: 'local-git',
                headSha: head,
                capturedAt: new Date().toISOString(),
              },
            };
          const current = store.getRun(run.id);
          assert(current);
          await assertReviewRoundAvailable(current);
          throw new Error('spent budget admitted');
        },
      };
      let refusal: InstanceType<typeof ResultDecisionHoldError> | undefined;
      try {
        await executeReviewStep(run.id, context);
      } catch (error) {
        assert(error instanceof ResultDecisionHoldError);
        refusal = error;
      }
      assert(refusal, 'REVIEW must stop at the result-decision hold boundary');
      store.updateRunStep(run.id, 'review', {
        status: 'failed',
        detail: refusal.message,
        inputs: refusal.stepInputs,
        outputs: refusal.stepOutputs,
      });
      await holdRunForResultDecision(run.id, 'review', refusal.message);
      const lease = async () => {
        const data: unknown = JSON.parse(await readFile(statusFile, 'utf8'));
        assert(isRecord(data) && Array.isArray(data.slots));
        const row: unknown = data.slots.find(
          (value: unknown) => isRecord(value) && value.slot === slot,
        );
        assert(isRecord(row));
        return row;
      };
      const before = (await fixture.client.call<RunGetResult>('run.get', { runId: run.id })).run;
      assert.equal(before.status, 'needs-decision');
      assert.equal(before.slotId, slot);
      assert.equal((await lease()).current_run_id, run.id);
      const card = before.decisions.find(
        (d) => d.payload?.kind === 'result-decision' && !d.resolvedAt,
      );
      assert(card?.payload?.kind === 'result-decision');
      const accept = card.payload.actions.find((a) => a.id === 'accept-result');
      if (blockedReview) {
        assert(accept && !accept.available && accept.requiresReason);
        assert.equal(before.reviewResult ?? null, null);
        assert.equal(before.error, 'The remaining fix requires an operator decision.');
        assert.equal(before.steps.find((step) => step.name === 'review')?.status, 'failed');
        assert.equal(
          before.steps.find((step) => step.name === 'review')?.outputs?.verdict,
          'blocked',
        );
        for (const name of ['complete', 'human-gate', 'finalize', 'ci-watch'])
          assert.equal(before.steps.find((step) => step.name === name)?.status, 'pending');
        assert.deepEqual(card.payload.findings, [
          { file: 'README.md', description: 'The remaining fix needs an upstream change.' },
        ]);
        assert(card.payload.actions.find((action) => action.id === 'send-back')?.available);
        assert(card.payload.actions.find((action) => action.id === 'close-result')?.available);
        assert.equal(git('rev-parse', 'HEAD'), head);
        await fixture.client.call('run.resolveDecision', {
          runId: run.id,
          decisionId: card.id,
          actionId: 'send-back',
        });
        const after = (await fixture.client.call<RunGetResult>('run.get', { runId: run.id })).run;
        assert.equal(after.status, 'reviewing');
        assert.equal(after.resultDecisionReceipt?.action, 'send-back');
        assert.equal(
          after.steps.find((step) => step.name === 'review')?.outputs?.verdict,
          'blocked',
        );
        const resume = takeSendBackReview(run.id);
        assert.equal(resume?.verdict, 'issues');
        assert.deepEqual(resume?.issues, card.payload.findings);
        assert.equal(resume?.retryCount, 3);
        assert.equal(resume?.reviewSnapshot?.headSha, head);
        assert.deepEqual(scheduled, [run.id]);
        await writeFile(
          path.join(out, 'receipt.json'),
          JSON.stringify(
            {
              pass: true,
              sourceHead: execFileSync('git', ['rev-parse', 'HEAD'], {
                cwd: source,
                encoding: 'utf8',
              }).trim(),
              runId: run.id,
              fixtureRoot: root,
              status: before.status,
              pendingDecisionId: card.id,
              stoppedAt: card.payload.stoppedAt,
              verdict: 'blocked',
              reasonPreserved: true,
              findingsPreserved: true,
              sendBackAvailable: true,
              closeAvailable: true,
              acceptUnavailable: true,
              primaryReviewResultAbsent: true,
              laterStepsPending: true,
              sendBackApplied: true,
              retainedFindingsQueued: true,
              scheduledLaunches: scheduled.length,
              slotOwnerUnchanged: true,
              checkoutHeadUnchanged: true,
              modelCalls: 0,
              reviewerStarted: false,
            },
            null,
            2,
          ) + '\n',
        );
        return;
      }
      assert(accept?.available && accept.requiresReason);
      const grant = await fixture.client.call<RunExtendReviewBudgetResult>(
        'run.extendReviewBudget',
        {
          runId: run.id,
          requestId: 'proof-grant',
          expectedLimit: 5,
          limit: 6,
          headSha: head,
          scopeBrief: 'One scoped correction and its review.',
        },
      );
      const after = (await fixture.client.call<RunGetResult>('run.get', { runId: run.id })).run;
      assert.equal(after.status, 'needs-decision');
      assert.equal(after.slotId, slot);
      assert.equal(grant.budget.remaining, 1);
      assert.equal((await lease()).current_run_id, run.id);
      assert.equal(git('rev-parse', 'HEAD'), head);
      const refreshed = after.decisions.find(
        (d) => d.payload?.kind === 'result-decision' && !d.resolvedAt,
      );
      assert(refreshed?.payload?.kind === 'result-decision');
      assert(refreshed.payload.actions.find((a) => a.id === 'send-back')?.available);
      await writeFile(
        path.join(out, 'receipt.json'),
        JSON.stringify(
          {
            pass: true,
            sourceHead: execFileSync('git', ['rev-parse', 'HEAD'], {
              cwd: source,
              encoding: 'utf8',
            }).trim(),
            runId: run.id,
            checkoutHead: head,
            statusBeforeGrant: before.status,
            statusAfterGrant: after.status,
            slotOwnerUnchanged: true,
            checkoutHeadUnchanged: true,
            remaining: grant.budget.remaining,
            pendingDecisionId: refreshed.id,
            acceptRequiresReason: accept.requiresReason,
            reviewVerdictInvented: Boolean(
              after.steps.find((s) => s.name === 'review')?.outputs?.verdict,
            ),
            lease: await lease(),
            principalKind: fixture.person.subject.type,
          },
          null,
          2,
        ),
      );
    } finally {
      store.updateRun(run.id, { status: 'cancelled' });
      await store.deleteRun(run.id);
    }
  },
);
