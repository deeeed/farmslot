// Opt-in real-provider proof for ADR-063 Amendment 5. All state and sessions are isolated.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { access, chmod, mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { mock } from 'node:test';
import { fileURLToPath } from 'node:url';

import { NATIVE_WORKER_RESUME } from '@farmslot/agent-runtime/native';
import {
  Methods,
  type NativeSessionReadResult,
  type NativeWorkerControlTarget,
} from '@farmslot/protocol';

import '../runtime/mock-pty.test-support.js';

import { REQUESTED_REVIEW_SOURCE } from '../quality/review-sources.js';
import { createNativeProofFixture } from '../runtime/native-proof-fixture.live-support.js';

const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

test(
  'native re-reviews before publication resume an ended session and fall back on their delta',
  { timeout: 600_000 },
  async (t) => {
    delete process.env.TMUX;
    delete process.env.TMUX_PANE;
    const root = await mkdtemp(path.join(os.tmpdir(), 'native-warm-review-'));
    const repo = path.join(root, 'repo');
    const taskDir = 'tasks/review';
    const reviewId = REQUESTED_REVIEW_SOURCE.artifactRefs(1, 'native-proof').id;
    const slotId = 'native-warm-proof-slot';
    const project = 'native-warm-proof';
    const write = async (rel: string, text: string) => {
      const file = path.join(root, rel);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, text);
    };
    await write('CLAUDE.md', 'Isolated native review proof fixture.\n');
    await write('services/gateway/package.json', '{}\n');
    await symlink(path.join(source, 'scripts'), path.join(root, 'scripts'));
    await symlink(path.join(source, 'packages'), path.join(root, 'packages'));
    await write(
      `projects/${project}/project.json`,
      JSON.stringify({
        name: project,
        task_dir: 'tasks',
        runtime_dir: '.agent',
        default_branch: 'main',
      }),
    );
    await write(
      `projects/${project}/templates/worker/review.static-code.md`,
      '# Review the text fixture\n\n- [ ] 1. Read message.txt and the diff. This fixture only changes text; confirm message.txt contains hello. Extra lines are allowed.\n- [ ] 2. Record the review result and feedback required by the execution contract, then mark this checklist complete.\n',
    );
    const binary =
      process.env.FARMSLOT_WARM_PROOF_CODEX_BIN ??
      execFileSync('which', ['codex'], { encoding: 'utf8' }).trim();
    await write(
      'pool/local.json',
      JSON.stringify({
        schema_version: 2,
        machine: os.hostname(),
        project,
        platform: 'macos',
        os: process.platform,
        host: 'localhost',
        ssh_user: os.userInfo().username,
        codex_path: binary,
        env: { REVIEW_UNUSED_PROVIDER_ROOT: '/fixture/providers/old' },
        slots: [{ id: slotId, enabled: true, repo, session: 'unused-native-proof', resources: {} }],
      }),
    );
    await mkdir(repo);
    const git = (...args: string[]) =>
      execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
    const commit = (message: string) => {
      git('add', '.');
      git(
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@example.invalid',
        'commit',
        '--quiet',
        '-m',
        message,
      );
    };
    git('init', '--quiet', '-b', 'main');
    await write('repo/.gitignore', 'tasks/\n.agent/\n');
    await write('repo/message.txt', 'base\n');
    commit('test: initialize native review fixture');
    git('checkout', '--quiet', '-b', 'proof-change');
    await write('repo/message.txt', 'hello\n');
    commit('test: update native review fixture');
    git('remote', 'add', 'origin', repo);
    git('update-ref', 'refs/remotes/origin/main', git('rev-parse', 'main'));
    await write(
      `repo/${taskDir}/TASK.md`,
      '# Text review proof\n\nConfirm message.txt contains hello. Local fixture only, no publication.\n',
    );
    await write(`repo/${taskDir}/CHECKLIST.md`, '# Worker\n\n- [x] 1. Update message.txt.\n');
    await write(
      `repo/${taskDir}/artifacts/pr-description.md`,
      '# Verify the greeting text\n\nmessage.txt contains hello. Local fixture only, no publication.\n',
    );

    process.env.FARMSLOT_ROOT = root;
    process.env.FARMSLOT_PROJECTS_DIR = path.join(root, 'projects');
    process.env.FARMSLOT_POOL_DIR = path.join(root, 'pool');
    process.env.FARMSLOT_RUNS_DIR = path.join(root, 'runs');
    process.env.FARMSLOT_NATIVE_STATE_DIR = path.join(root, 'native');
    process.env.FARMSLOT_DISABLE_RUN_ENGINE_START = '1';
    const nativeRouting = await import('../runners/native/node.js');
    const { NodeRpcTimeoutError } = await import('../fleet/node-rpc.js');
    let loseHandoffResumeReply = false;
    let handoffResumeCalls = 0;
    mock.module('../runners/native/node.js', {
      namedExports: {
        ...nativeRouting,
        routeNativeExecution: async (
          ...args: Parameters<typeof nativeRouting.routeNativeExecution>
        ) => {
          const result = await nativeRouting.routeNativeExecution(...args);
          if (args[1] === NATIVE_WORKER_RESUME && loseHandoffResumeReply) {
            handoffResumeCalls++;
            loseHandoffResumeReply = false;
            throw new NodeRpcTimeoutError('owned-proof', 1);
          }
          return result;
        },
      },
    });

    const fixture = await createNativeProofFixture(t, root);
    const { client, person, trackSession } = fixture;
    const { shellQuote } = await import('../core/tmux.js');
    await write(
      `repo/${taskDir}/mark`,
      `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(path.join(source, 'packages/agent-runtime/scripts/mark-checklist-step.cjs'))} ${shellQuote(path.join(repo, taskDir))} "$@"\n`,
    );
    await chmod(path.join(repo, taskDir, 'mark'), 0o700);
    const { loadSlotVars } = await import('../core/config.js');
    const { rewriteStatusFile } = await import('../core/state.js');
    const { createRun, getRun, updateRun } = await import('../runs/store.js');
    const { runWithSessionOriginator } = await import('../security/work-originator.js');
    const { runNativeReviewAgent } = await import('./native-review-agent.js');
    const { reReviewMode } = await import('./orchestrator.js');
    const { reReviewContinuation } = await import('./review-agent.js');
    const vars = await loadSlotVars(slotId);
    const model = process.env.FARMSLOT_WARM_PROOF_MODEL ?? 'gpt-6.1-sol';
    const run = runWithSessionOriginator(person, () =>
      createRun({
        flowType: 'dev',
        project,
        ticketOrPr: 'NATIVE-WARM-PROOF',
        slotId,
        transport: 'native',
        safetyTier: 'dangerous',
        runner: 'codex',
        model,
      }),
    );
    updateRun(run.id, {
      status: 'reviewing',
      branch: 'proof-change',
      taskFile: path.join(repo, taskDir, 'TASK.md'),
    });
    await rewriteStatusFile(() => ({
      slots: [
        {
          slot: slotId,
          current_run_id: run.id,
          slot_epoch: 1,
          task_file: path.join(repo, taskDir, 'TASK.md'),
          lifecycle: 'busy',
          phase: 'working',
          agent: 'idle',
        },
      ],
    }));
    type NativeReviewInput = Parameters<typeof runNativeReviewAgent>[0];
    type ProofReviewOptions = Pick<NativeReviewInput, 'mode' | 'loopNumber'> &
      Partial<NativeReviewInput>;
    const review = (options: ProofReviewOptions) =>
      runWithSessionOriginator(person, () =>
        runNativeReviewAgent({
          vars,
          runner: 'codex',
          model,
          taskDir,
          runId: run.id,
          reviewTimeoutMs: 180_000,
          validationDepth: 'static-code',
          artifactScope: 'proof-review',
          reviewId,
          effort: 'high',
          ...options,
        }),
      );
    const target = () => {
      const context = [...(getRun(run.id)!.agentContexts ?? [])]
        .reverse()
        .find((entry) => entry.role === 'review');
      assert.ok(context?.nativeSession && context.reviewResultValidatedAt);
      assert.ok(context.nativeSession.generation);
      const sessionId = context.nativeSession.sessionId;
      const worker: NativeWorkerControlTarget = {
        runId: run.id,
        contextId: context.id,
        generation: context.nativeSession.generation,
        leaseId: context.nativeSession.leaseId,
      };
      const target = { sessionId, worker };
      if (!context.nativeSession.closedAt) trackSession(target);
      return target;
    };

    const first = await review({ mode: 'cold', loopNumber: 1 });
    assert.equal(first.verdict, 'pass');
    assert.equal(first.mode, 'cold');
    assert.ok(first.session?.sessionId && first.reviewSnapshot?.headSha);
    assert.equal(first.reviewSnapshot.baseSha, git('rev-parse', 'main'));
    const firstTarget = target();
    const firstHistory = await client.call<NativeSessionReadResult>(
      Methods.NATIVE_SESSION_READ,
      firstTarget,
    );
    assert.ok(
      firstHistory.commands.some((command) => command.accepted),
      'Native protocol confirms acceptance',
    );
    if (!firstHistory.session.processStopped)
      await client.call(Methods.NATIVE_SESSION_CLOSE, firstTarget);

    await write('repo/message.txt', 'hello\nsecond revision\n');
    commit('test: revise native review fixture');
    // Refresh the pool between the original launch and handoff. The static
    // reviewer does not consume this tool selector; its launch must stay stable.
    const poolPath = path.join(root, 'pool/local.json');
    const pool = JSON.parse(await readFile(poolPath, 'utf8'));
    pool.env.REVIEW_UNUSED_PROVIDER_ROOT = '/fixture/providers/new';
    await writeFile(poolPath, JSON.stringify(pool));
    const updatedVars = await loadSlotVars(slotId);
    loseHandoffResumeReply = true;
    const warmMode = reReviewMode({ ...first, issues: first.issues ?? [] }, 'cold');
    const warmContinuation = reReviewContinuation(first);
    assert.ok(warmMode === 'warm' && warmContinuation);
    const second = await review({
      vars: updatedVars,
      mode: warmMode,
      loopNumber: 2,
      rereview: warmContinuation,
    });
    assert.equal(second.verdict, 'pass');
    assert.equal(second.mode, 'warm');
    assert.equal(second.session?.sessionId, first.session.sessionId);
    assert.equal(second.reviewId, first.reviewId);
    assert.equal(handoffResumeCalls, 1, 'Lost resume reply reconciled without a second resume');
    assert.equal(second.session?.fallback, undefined);
    assert.equal(second.reviewSnapshot?.baseSha, first.reviewSnapshot.headSha);
    assert.ok(second.reviewSnapshot?.headSha);
    const secondTarget = target();
    assert.equal(
      secondTarget.sessionId,
      firstTarget.sessionId,
      'Ended worker resumes under the same native session',
    );

    await write('repo/message.txt', 'hello\nthird revision\n');
    commit('test: revise native review fixture for fallback');
    const fallbackContinuation = reReviewContinuation(second);
    assert.ok(fallbackContinuation);
    const third = await review({
      mode: 'warm',
      effort: 'medium',
      loopNumber: 3,
      rereview: fallbackContinuation,
    });
    assert.equal(third.verdict, 'pass');
    assert.equal(third.mode, 'cold');
    assert.equal(third.reviewId, first.reviewId);
    assert.ok(third.reviewSnapshot?.headSha);
    assert.equal(third.session?.fallback?.reason, 'effort-mismatch');
    assert.equal(third.reviewSnapshot?.baseSha, second.reviewSnapshot.headSha);
    assert.deepEqual(third.session.fallback.comparedRanges, [
      `${second.reviewSnapshot.headSha}..${third.reviewSnapshot?.headSha}`,
    ]);
    const thirdTarget = target();
    assert.notEqual(thirdTarget.sessionId, secondTarget.sessionId);
    await client.call<NativeSessionReadResult>(Methods.NATIVE_SESSION_READ, thirdTarget);
    if (process.env.FARMSLOT_WARM_PROOF_RECEIPT) {
      await mkdir(path.dirname(process.env.FARMSLOT_WARM_PROOF_RECEIPT), { recursive: true });
      await writeFile(
        process.env.FARMSLOT_WARM_PROOF_RECEIPT,
        JSON.stringify(
          {
            pass: true,
            runId: run.id,
            familyId: run.familyId,
            prNumber: run.prNumber,
            unusedPoolChangePreservedWarm: true,
            lostHandoffResumeReplyReconciled: true,
            first: { session: first.session, snapshot: first.reviewSnapshot, ...firstTarget },
            warm: { session: second.session, snapshot: second.reviewSnapshot, ...secondTarget },
            fallback: { session: third.session, snapshot: third.reviewSnapshot, ...thirdTarget },
          },
          null,
          2,
        ) + '\n',
      );
    }

    if (process.env.FARMSLOT_WARM_PROOF_UI) {
      const { buildPublishGateReviewStatus } = await import('../run-engine/gate-policy.js');
      const { reviewLineageOptionsForRun } = await import('../run-engine/review-plan.js');
      const { createEngineDecision, resolveEngineDecision } =
        await import('../run-engine/engine-decisions.js');
      const reviewStatus = buildPublishGateReviewStatus({
        source: 'dispatch',
        priorReviewCount: 2,
        reviewResult: { ...third, verdict: 'pass', issues: third.issues ?? [], retryCount: 0 },
        requestedRunner: 'codex',
        model,
        effort: 'medium',
        reviewId,
      });
      updateRun(run.id, {
        status: 'human-gating',
        steps: getRun(run.id)!.steps.map((step) => ({
          ...step,
          status: step.name === 'human-gate' ? 'running' : 'done',
        })),
        engineState: {
          ...getRun(run.id)!.engineState,
          publishGate: {
            reviews: [reviewStatus],
            reviewSequence: [{ runner: 'codex', model, effort: 'medium', mode: 'cold' }],
          },
        },
      });
      await fixture.closeSessions();
      const lineageOptions = await reviewLineageOptionsForRun(
        getRun(run.id)!,
        [getRun(run.id)!],
        third.reviewSnapshot?.headSha,
        async (ancestor, head) => {
          try {
            git('merge-base', '--is-ancestor', ancestor, head);
            return true;
          } catch (error) {
            if (error && typeof error === 'object' && 'status' in error && error.status === 1)
              return false;
            throw error;
          }
        },
      );
      assert.equal(lineageOptions.length, 1);
      assert.equal(lineageOptions[0].unavailableReason, undefined);
      const waiting = createEngineDecision(
        run.id,
        'human_gate',
        'Native review proof',
        [
          { id: 'hold', label: 'Hold', style: 'secondary' },
          { id: 'request-review', label: 'Request Review', style: 'primary' },
        ],
        {
          kind: 'ready',
          prNumber: null,
          repo: null,
          branch: 'proof-change',
          workerReport: '',
          diffStat: { files: 1, additions: 1, deletions: 1 },
          reviews: [reviewStatus],
          reviewPolicy: { minimumReviews: 1, requestedBy: 'dispatch' },
          reviewLineageOptions: lineageOptions,
        },
        { readProgress: async () => ({ kind: 'idle' }) },
      );
      try {
        const credentialFile = path.join(root, 'ui-credential.json');
        await writeFile(
          credentialFile,
          JSON.stringify({ url: fixture.url, token: fixture.browserCredential }),
          { mode: 0o600 },
        );
        const finishFile = path.join(root, 'ui-finished');
        await writeFile(
          process.env.FARMSLOT_WARM_PROOF_UI,
          JSON.stringify({ url: fixture.url, runId: run.id, credentialFile, finishFile }) + '\n',
          { mode: 0o600 },
        );
        const deadline = Date.now() + 300_000;
        while (true) {
          const finished = await access(finishFile).then(
            () => true,
            (error: unknown) => {
              if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
                return false;
              throw error;
            },
          );
          if (finished) break;
          assert.ok(Date.now() < deadline, 'Browser proof did not finish');
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      } finally {
        for (const decision of getRun(run.id)!.decisions)
          resolveEngineDecision(decision.id, 'abort');
        await waiting;
      }
    }
  },
);
