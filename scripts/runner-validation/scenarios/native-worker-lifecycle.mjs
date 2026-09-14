import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { ROOT } from '../lib/common.mjs';
import { writeEvidence } from '../lib/evidence.mjs';
import { fixtureChecklistPath, writeNativeFixtureTask } from '../lib/native-task.mjs';

import {
  prepareNativeReviewerRestart,
  verifyNativeReviewCleanupFailure,
} from './native-reviewer-recovery.mjs';
import { verifyCancelledDeferredResume } from './native-worker-cancel-resume.mjs';
import { verifyNativeCloseResumeOrder } from './native-worker-close-order.mjs';
import { verifyHeldNativeWorkerResume } from './native-worker-held-signal.mjs';
import { assertWorkerHistoryTransfer, readPinnedWorkerHistory } from './native-worker-history.mjs';
import { verifyCancelledMonitorLateRead } from './native-worker-monitor-cancel.mjs';
import { verifyNativeNudgeReplay } from './native-worker-nudge-replay.mjs';
import { verifyNativeWorkerQueue } from './native-worker-queue.mjs';
import { pinnedWorkerTarget } from './native-worker-read.mjs';
import { prepareNativeResumeReply, resumeNativeWorkerInUi } from './native-worker-resume-reply.mjs';
import {
  prepareNativeFixRestart,
  verifyNativeFixReplay,
} from './native-worker-review-recovery.mjs';
import { verifyNativeWorkerUi } from './native-worker-ui.mjs';

export const SCENARIO_ID = 'native-worker-lifecycle';

export function rpc(method, params = {}, timeoutMs = 120000) {
  try {
    return JSON.parse(
      execFileSync(
        process.execPath,
        [
          path.join(ROOT, 'apps/command-center/scripts/cdp.mjs'),
          'gateway',
          method,
          JSON.stringify(params),
        ],
        {
          cwd: ROOT,
          env: { ...process.env, FARMSLOT_RPC_TIMEOUT_MS: String(timeoutMs) },
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
          timeout: timeoutMs + 5000,
        },
      ),
    );
  } catch (error) {
    throw new Error(
      `Gateway ${method} failed: ${String(error.stderr ?? error.message).slice(0, 1500)}`,
    );
  }
}

function expectInputRefused(method, params) {
  try {
    rpc(method, params);
  } catch (error) {
    assert.match(error.message, /"ok":false/, 'Transport failure is not a protocol refusal');
    assert.match(error.message, /"code":"(?:NATIVE_SESSION_ERROR|AUTH_FORBIDDEN|INVALID_PARAMS)"/);
    return;
  }
  throw new Error(`${method} accepted an unleased or stale worker input`);
}

export async function wait(read, predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (predicate(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error('Native worker lifecycle condition timed out');
}

/**
 * Requires an idle, dispatch-enabled local fixture slot in temp/native-validation and
 * a native-worker-* project with its normal worker/dev and worker-dispatch templates.
 * --slot selects that fixture; --model is optional. The scenario creates its own TASK
 * through the ordinary run.createNative pipeline and always tests run.cancel cleanup.
 * No gateway engine-disable test seam, fake acceptance or synthetic completion signal.
 */
export async function runScenario({
  runnerAdapter,
  slotId,
  model,
  timeoutMs,
  outDir,
  explicit,
  via,
}) {
  const report = { runner: runnerAdapter.RUNNER_ID, checks: [], pass: false, error: null };
  let runId;
  let sessionId;
  let cancelled = false;
  let cancelResult;
  let handoffFault;
  let resumeFault;
  let preserveForRecovery = false;
  let originalReviewFixture;
  let nativeNudgeRelease;
  let nativeFreshLateEffect;
  let nativeFreshProject;
  let nativeFreshPrepareReceipt;
  const reviewRestart = [
    'native-review-fix-restart-prepare',
    'native-review-fix-stop-restart-prepare',
    'native-review-fix-replay',
  ].includes(via);
  const reviewFix =
    reviewRestart || ['native-review-fix', 'native-review-fix-stopped'].includes(via);
  const reviewerRestart = [
    'native-review-restart-prepare',
    'native-review-stop-restart-prepare',
    'native-review-cleanup-failure',
    'native-review-send-reply-prepare',
  ].includes(via);
  const deferredReleaseRace = via === 'native-deferred-release-race';
  const nativeReview =
    via === 'native-review' || reviewFix || reviewerRestart || deferredReleaseRace;
  if (!slotId && !explicit) {
    report.skipped = true;
    report.skipReason = 'Requires an isolated native worker fixture slot';
    const outPath = writeEvidence(report, SCENARIO_ID, report.runner, outDir);
    return {
      runner: report.runner,
      scenario: SCENARIO_ID,
      skipped: true,
      pass: true,
      outPath,
      report,
    };
  }
  try {
    assert.equal(process.env.FARMSLOT_GATEWAY, 'ws://127.0.0.1:18777');
    assert.ok(slotId, 'Pass --slot for the isolated fixture');
    const slot = rpc('fleet.status').fleet.slots.find((slot) => slot.slot === slotId);
    assert.ok(slot?.project.startsWith('native-worker-'), 'Use a native-worker-* fixture project');
    assert.equal(slot.currentRunId, null, 'Fixture slot is already owned');
    const cwd = fs.realpathSync(slot.repo);
    assert.ok(
      cwd.startsWith(fs.realpathSync(path.join(ROOT, 'temp/native-validation')) + path.sep),
    );
    if (via === 'supervisor-census') {
      const inventory = rpc('native.session.list', { executionNodeId: 'local' });
      assert.ok(
        inventory.sessions.every(
          (session) =>
            ['closed', 'failed'].includes(session.state) &&
            (!session.processPid || session.processStopped),
        ),
        'Census proof requires an otherwise idle private host',
      );
    }
    if (slot.lifecycle === 'held') rpc('slot.release', { slotId, keepWork: true });
    assert.equal(
      rpc('fleet.status').fleet.slots.find((candidate) => candidate.slot === slotId).lifecycle,
      'ready',
    );
    const id = `NATIVE-${Date.now()}`;
    const marker = `native-worker-${randomUUID()}.txt`;
    const taskDir = path.join(ROOT, 'projects', slot.project, 'tasks', 'dev', id);
    fs.mkdirSync(taskDir, { recursive: true });
    const taskFile = path.join(taskDir, 'TASK.md');
    await writeNativeFixtureTask(
      taskFile,
      `# Worker: dev\n\n- Task profile: dev\n\n## Checklist\n\n` +
        (via === 'fresh-worker'
          ? `- [ ] Append exactly one line containing ${id} to ${marker}.\n`
          : `- [ ] Write ${marker} containing exactly ${id}.\n`) +
        '- [ ] Check both boxes in CHECKLIST.md after writing the file.\n\n' +
        'Then end the turn. Do not write a terminal signal: the task must remain in Farmslot monitoring. ' +
        'Do not commit, contact services, or modify other files.\n',
      slot.project,
    );
    const created = rpc('run.createNative', {
      flowType: 'dev',
      project: slot.project,
      ticketOrPr: id,
      slotId,
      allowedSlots: [slotId],
      taskFile,
      runner: report.runner,
      ...(model ? { model } : {}),
      mode: 'interactive',
      skipPrepare: true,
      safetyTier: 'full-auto',
      ...(nativeReview
        ? { completionPolicy: 'artifact-only', lane: 'comparison', variant: 'native-review' }
        : {}),
    });
    runId = created.run.id;
    report.runId = runId;
    // Persist the identity immediately; a failed later probe must not lose the cleanup target.
    writeEvidence(report, SCENARIO_ID, report.runner, outDir);
    const run = await wait(
      () => rpc('run.get', { runId }).run,
      (run) => {
        assert.ok(
          !['failed', 'cancelled', 'blocked'].includes(run.status),
          `Worker ${run.status}: ${run.error}`,
        );
        return run.status === 'monitoring';
      },
      timeoutMs,
    );
    assert.equal(run.transport, 'native');
    const context = run.agentContexts.find((context) => context.role === 'dev');
    assert.equal(context.target, null);
    let binding = context.nativeSession;
    assert.ok(binding?.generation && binding.leaseId && binding.commandId);
    sessionId = binding.sessionId;
    report.sessionId = sessionId;
    let readSelection = { runId, contextId: context.id, leaseId: binding.leaseId };
    const read = () =>
      rpc(
        'native.session.read',
        pinnedWorkerTarget(readSelection.runId, readSelection.contextId, readSelection.leaseId),
      );
    const snapshot = await wait(
      read,
      (snapshot) => {
        assert.equal(snapshot.session.generation, binding.generation);
        assert.equal(snapshot.session.workerLeaseId, binding.leaseId);
        const receipt = snapshot.commands.find(
          (command) => command.commandId === binding.commandId,
        );
        assert.ok(receipt?.state !== 'failed', 'Native task turn failed');
        return receipt?.outcome === 'completed' && snapshot.session.state === 'idle';
      },
      timeoutMs,
    );
    assert.ok(
      snapshot.commands.find((command) => command.commandId === binding.commandId)?.accepted,
    );
    assert.equal(fs.readFileSync(path.join(cwd, marker), 'utf8').trim(), id);
    assert.equal(
      fs.readFileSync(fixtureChecklistPath(cwd, context.taskFile), 'utf8').match(/\[x\]/gi)?.length,
      2,
    );
    if (fs.existsSync(path.join(cwd, context.signalFile)))
      assert.equal(
        JSON.parse(fs.readFileSync(path.join(cwd, context.signalFile), 'utf8')).status,
        'running',
      );
    report.checks.push('native command accepted; real tool writes and task progress observed');
    const firstPoll = rpc('run.get', { runId }).run.monitorState?.lastPollAt;
    await wait(
      () => rpc('run.get', { runId }).run,
      (current) => {
        assert.equal(current.status, 'monitoring', 'End of native turn falsely completed the task');
        return current.monitorState?.lastPollAt && current.monitorState.lastPollAt !== firstPoll;
      },
      timeoutMs,
    );
    report.checks.push('completed native turn stays in task monitoring without a terminal signal');
    const worker = {
      runId,
      contextId: context.id,
      generation: binding.generation,
      leaseId: binding.leaseId,
    };
    if (
      via === 'held-worker-signal' ||
      ['held-before-send-death', 'held-after-send-death', 'held-close-uncertain'].includes(via)
    ) {
      const recoveryTest = via === 'held-worker-signal' ? undefined : via.slice('held-'.length);
      await verifyHeldNativeWorkerResume({ runId, context, binding, cwd, timeoutMs, recoveryTest });
      report.checks.push(
        'operator Resume continues the live worker under a fresh signal attempt without consuming the previous blocked signal',
      );
      if (recoveryTest) {
        const result = rpc('run.cancel', {
          runId,
          reason: 'Held continuation recovery proof cleanup',
        });
        assert.ok(result.effects.every((effect) => effect.status !== 'failed'));
        assert.equal(read().session.processStopped, true);
        cancelled = true;
        report.checks.push(
          `held continuation ${recoveryTest} preserves delivery identity, recovers saved context and cleans up`,
        );
        report.pass = true;
        const outPath = writeEvidence(report, SCENARIO_ID, report.runner, outDir);
        return { runner: report.runner, scenario: SCENARIO_ID, pass: true, outPath, report };
      }
    }
    if (
      via === 'blocked-worker-resume' ||
      via === 'blocked-worker-resume-reply-prepare' ||
      via === 'blocked-worker-send-reply-prepare' ||
      via === 'blocked-worker-resume-ui'
    ) {
      const original = { ...binding };
      const taskBefore = fs.readFileSync(fixtureChecklistPath(cwd, context.taskFile), 'utf8');
      rpc('native.session.close', { sessionId, executionNodeId: binding.executionNodeId, worker });
      assert.equal(read().session.processStopped, true);
      const blocked = await wait(
        () => rpc('run.get', { runId }).run,
        (run) => run.status === 'blocked',
        timeoutMs,
      );
      const decision = blocked.decisions.find(
        (decision) => !decision.resolvedAt && decision.type === 'monitor_interactive_handoff',
      );
      assert.ok(decision?.actions.some((action) => action.id === 'resume-native-worker'));
      if (
        via === 'blocked-worker-resume-reply-prepare' ||
        via === 'blocked-worker-send-reply-prepare'
      ) {
        resumeFault = process.env.FARMSLOT_NATIVE_RESUME_REPLY_FAULT;
        report.recoveryState = await prepareNativeResumeReply({
          runId,
          context,
          binding,
          cwd,
          marker,
          expectedMarker: id,
          slotId,
          outDir,
          decisionId: decision.id,
          holdSendReply: via === 'blocked-worker-send-reply-prepare',
          timeoutMs,
        });
        report.checks.push(
          'blocked decision and worker recovery intent persist while the applied resume reply is withheld',
        );
        report.awaitingGatewayRestart = true;
        report.complete = false;
        report.pass = true;
        preserveForRecovery = true;
        const outPath = writeEvidence(report, SCENARIO_ID, report.runner, outDir);
        return { scenario: SCENARIO_ID, runner: report.runner, pass: true, outPath, report };
      }
      if (via === 'blocked-worker-resume-ui') {
        await resumeNativeWorkerInUi({ runId, outDir, timeoutMs });
        report.checks.push(
          'visible Command Center button resumes the stopped native worker without terminal input',
        );
      } else
        rpc('run.resolveDecision', {
          runId,
          decisionId: decision.id,
          actionId: 'resume-native-worker',
        });
      const resumed = await wait(
        () => rpc('run.get', { runId }).run,
        (run) => run.status === 'monitoring',
        timeoutMs,
      );
      binding = resumed.agentContexts.find(
        (candidate) => candidate.id === context.id,
      ).nativeSession;
      assert.equal(binding.sessionId, original.sessionId);
      assert.equal(binding.leaseId, original.leaseId);
      assert.notEqual(binding.generation, original.generation);
      assert.equal(binding.recovery, undefined);
      assert.equal(binding.closedAt, undefined);
      const completed = await wait(
        read,
        (snapshot) =>
          snapshot.commands.length === 2 &&
          snapshot.commands[1].outcome === 'completed' &&
          snapshot.session.state === 'idle',
        timeoutMs,
      );
      assert.equal(completed.session.nativeSessionId, snapshot.session.nativeSessionId);
      assert.notEqual(completed.session.processPid, snapshot.session.processPid);
      const resolvedDecision = rpc('run.get', { runId }).run.decisions.find(
        (candidate) => candidate.id === decision.id,
      );
      assert.ok(
        resolvedDecision.resolvedAt,
        'Monitor resurrected the resolved worker recovery decision',
      );
      assert.equal(
        resolvedDecision.context.nativeWorkerResume.commandId,
        completed.commands[1].commandId,
      );
      assert.equal(
        fs.readFileSync(fixtureChecklistPath(cwd, context.taskFile), 'utf8'),
        taskBefore,
      );
      let duplicateRefused = false;
      try {
        rpc('run.resolveDecision', {
          runId,
          decisionId: decision.id,
          actionId: 'resume-native-worker',
        });
      } catch (error) {
        assert.match(error.message, /Decision already resolved/);
        duplicateRefused = true;
      }
      assert.ok(duplicateRefused);
      assert.equal(read().commands.length, 2);
      expectInputRefused('native.session.send', {
        sessionId,
        worker,
        commandId: randomUUID(),
        text: 'Stale generation must not receive input',
      });
      const memoryFile = `native-blocked-memory-${randomUUID()}.txt`;
      const commandId = randomUUID();
      rpc('native.session.send', {
        sessionId,
        commandId,
        worker: { ...worker, generation: binding.generation },
        text: `Write ${memoryFile} containing exactly the value from the first task, using conversation memory. Do not read earlier task files or markers. End the turn without a terminal signal.`,
      });
      await wait(
        read,
        (snapshot) =>
          snapshot.commands.find((command) => command.commandId === commandId)?.outcome ===
            'completed' && snapshot.session.state === 'idle',
        timeoutMs,
      );
      assert.equal(fs.readFileSync(path.join(cwd, memoryFile), 'utf8').trim(), id);
      report.checks.push(
        'blocked worker decision resumes the exact conversation once, preserves checklist progress and rejects stale-generation input',
      );
    }
    if (via === 'worker-input' || via === 'retained-handoff') {
      assert.ok(binding.acceptedAt);
      const commandId = randomUUID();
      const controlMarker = `native-input-${randomUUID()}.txt`;
      const text = `Append exactly one line containing ${id} to ${controlMarker}, then end the turn. Do not write a terminal signal or modify other files.`;
      const input = { sessionId, commandId, text };
      expectInputRefused('native.session.send', input);
      expectInputRefused('native.session.interrupt', { sessionId });
      expectInputRefused('native.session.close', { sessionId });
      for (const key of ['runId', 'contextId', 'generation', 'leaseId'])
        expectInputRefused('native.session.send', {
          ...input,
          worker: { ...worker, [key]: randomUUID() },
        });
      assert.equal(read().session.state, 'idle');
      assert.equal(fs.existsSync(path.join(cwd, controlMarker)), false);
      rpc('native.session.send', { ...input, worker });
      await wait(
        read,
        (current) => {
          const receipt = current.commands.find((command) => command.commandId === commandId);
          assert.ok(receipt?.state !== 'failed', 'Pinned worker input failed');
          return receipt?.outcome === 'completed' && current.session.state === 'idle';
        },
        timeoutMs,
      );
      assert.equal(fs.readFileSync(path.join(cwd, controlMarker), 'utf8').trim(), id);
      assert.equal(rpc('native.session.send', { ...input, worker }).accepted, true);
      assert.equal(read().commands.filter((command) => command.commandId === commandId).length, 1);
      assert.equal(fs.readFileSync(path.join(cwd, controlMarker), 'utf8').trim(), id);
      report.checks.push(
        'pinned worker input succeeds once; unleased and forged worker targets are refused',
      );
    }

    if (nativeReview) {
      let deferredFault;
      if (deferredReleaseRace) {
        deferredFault = process.env.FARMSLOT_DEFERRED_RELEASE_FAULT;
        assert.ok(
          deferredFault &&
            path.resolve(deferredFault).startsWith(path.join(ROOT, 'temp/native-validation/')),
        );
        assert.equal(fs.existsSync(deferredFault), false, 'Use a fresh deferred-release fixture');
        const pids = execFileSync('lsof', ['-t', '-nP', '-iTCP:18777', '-sTCP:LISTEN'], {
          encoding: 'utf8',
        })
          .trim()
          .split('\n');
        assert.equal(pids.length, 1);
        const gatewayPid = Number(pids[0]);
        assert.ok(fs.existsSync(`${deferredFault}.${gatewayPid}.loaded`));
        fs.writeFileSync(
          deferredFault,
          JSON.stringify({
            gatewayPid,
            runId,
            generation: rpc('run.get', { runId }).run.engineState?.generation ?? 0,
          }),
          { mode: 0o600 },
        );
      }
      if (reviewFix) {
        originalReviewFixture = {
          path: path.join(cwd, 'fixture.txt'),
          text: fs.readFileSync(path.join(cwd, 'fixture.txt'), 'utf8'),
        };
        assert.equal(originalReviewFixture.text, 'Native worker validation fixture.\n');
        fs.writeFileSync(originalReviewFixture.path, 'Incorrect native review fixture.\n');
      }
      if (via === 'native-review-fix-stopped') {
        rpc('native.session.close', {
          sessionId,
          executionNodeId: binding.executionNodeId,
          worker,
        });
        assert.equal(read().session.processStopped, true);
      }
      if (reviewRestart)
        fs.writeFileSync(
          path.join(cwd, path.posix.dirname(context.taskFile), 'NATIVE-FIX-HOLD'),
          'hold\n',
        );
      if (reviewerRestart)
        fs.writeFileSync(
          path.join(cwd, path.posix.dirname(context.taskFile), 'NATIVE-REVIEW-HOLD'),
          'hold\n',
        );
      if (via === 'native-review-send-reply-prepare') {
        resumeFault = process.env.FARMSLOT_NATIVE_RESUME_REPLY_FAULT;
        assert.ok(
          resumeFault &&
            path.resolve(resumeFault).startsWith(path.join(ROOT, 'temp/native-validation/')),
        );
        assert.equal(fs.existsSync(resumeFault), false, 'Use a fresh reviewer reply fixture');
        const pids = [
          ...new Set(
            execFileSync('lsof', ['-t', '-nP', '-iTCP:18777', '-sTCP:LISTEN'], { encoding: 'utf8' })
              .trim()
              .split(/\s+/),
          ),
        ];
        assert.equal(pids.length, 1);
        const gatewayPid = Number(pids[0]);
        assert.ok(fs.existsSync(`${resumeFault}.${gatewayPid}.loaded`));
        fs.writeFileSync(
          resumeFault,
          JSON.stringify({ gatewayPid, method: 'native.worker.send' }),
          { mode: 0o600 },
        );
      }
      rpc('run.interactiveDev.resolve', { runId, action: 'run-self-review' });
      if (reviewerRestart) {
        report.recoveryState = await prepareNativeReviewerRestart({
          runId,
          cwd,
          timeoutMs,
          outDir,
          stopReviewer: via === 'native-review-stop-restart-prepare',
          replyFault: via === 'native-review-send-reply-prepare' ? resumeFault : undefined,
        });
        if (via === 'native-review-cleanup-failure') {
          await verifyNativeReviewCleanupFailure(report.recoveryState, timeoutMs);
          cancelled = true;
          report.checks.push(
            'reviewer stop error and asynchronous watcher close error are both preserved; remaining cleanup restores task and stops processes',
          );
          report.pass = true;
          const outPath = writeEvidence(report, SCENARIO_ID, report.runner, outDir);
          return { scenario: SCENARIO_ID, runner: report.runner, pass: true, outPath, report };
        }
        report.checks.push(
          'native reviewer accepted and started its scoped review task; held for isolated startup recovery',
        );
        report.awaitingGatewayRestart = true;
        report.complete = false;
        report.pass = true;
        preserveForRecovery = true;
        const outPath = writeEvidence(report, SCENARIO_ID, report.runner, outDir);
        return { scenario: SCENARIO_ID, runner: report.runner, pass: true, outPath, report };
      }
      if (reviewRestart) {
        report.recoveryState = await prepareNativeFixRestart({
          runId,
          sessionId,
          cwd,
          fixture: originalReviewFixture,
          timeoutMs,
          outDir,
          stopWorker: via === 'native-review-fix-stop-restart-prepare',
        });
        if (via === 'native-review-fix-replay') {
          await verifyNativeFixReplay(report.recoveryState, timeoutMs);
          cancelled = true;
          report.checks.push(
            'monitor replay retires the old review controller; no stale review or extra worker command follows',
          );
          report.pass = true;
          const outPath = writeEvidence(report, SCENARIO_ID, report.runner, outDir);
          return { scenario: SCENARIO_ID, runner: report.runner, pass: true, outPath, report };
        }
        report.checks.push(
          'fix instruction accepted under its task lease; interrupted or retained for isolated startup recovery',
        );
        report.awaitingGatewayRestart = true;
        report.complete = false;
        report.pass = true;
        preserveForRecovery = true;
        const outPath = writeEvidence(report, SCENARIO_ID, report.runner, outDir);
        return { scenario: SCENARIO_ID, runner: report.runner, pass: true, outPath, report };
      }
      const reviewed = await wait(
        () => rpc('run.get', { runId }).run,
        (current) => {
          const step = current.steps.find((step) => step.name === 'self-review');
          assert.ok(
            step?.status !== 'failed',
            `Native review failed: ${current.error ?? step?.detail}`,
          );
          return step?.status === 'done' && step.outputs?.verdict === 'pass';
        },
        timeoutMs,
      );
      const reviewers = reviewed.agentContexts.filter(
        (context) => context.role === 'self-review' && context.nativeSession,
      );
      const reviewer = reviewers.at(-1);
      if (reviewFix) {
        assert.equal(reviewers.length, 2, 'Findings must produce a fix and a second review');
        assert.equal(
          fs.readFileSync(originalReviewFixture.path, 'utf8'),
          originalReviewFixture.text,
        );
        const fix = reviewed.agentContexts.find((context) => context.role === 'self-review-fix');
        assert.equal(fix.status, 'complete');
        assert.equal(fix.target, null);
        assert.equal(fix.nativeSession, undefined, 'Fix must not duplicate session ownership');
        assert.equal(fix.nativeSessionOwner.sessionId, binding.sessionId);
        assert.equal(fix.nativeSessionOwner.leaseId, binding.leaseId);
        const receipt = read().commands.filter(
          (command) => command.commandId === fix.nativeCommandId,
        );
        assert.equal(receipt.length, 1);
        assert.equal(receipt[0].accepted, true);
        assert.equal(
          JSON.parse(fs.readFileSync(path.join(cwd, fix.signalFile), 'utf8')).status,
          'complete',
        );
        assert.ok(reviewers.every((context) => context.reviewResultValidatedAt));
        assert.equal(
          reviewers[0].nativeSession.sessionId,
          reviewers[1].nativeSession.sessionId,
          'Warm re-review retains the reviewer conversation',
        );
        assert.notEqual(reviewers[0].nativeSession.leaseId, reviewers[1].nativeSession.leaseId);
        assert.ok(reviewers[0].nativeSession.releasedAt);
        const priorReviewHistory = readPinnedWorkerHistory(
          runId,
          reviewers[0].id,
          reviewers[0].nativeSession.leaseId,
        );
        const nextReviewHistory = readPinnedWorkerHistory(
          runId,
          reviewers[1].id,
          reviewers[1].nativeSession.leaseId,
        );
        assert.equal(priorReviewHistory.scope.released, true);
        assert.equal(nextReviewHistory.scope.startAfter, priorReviewHistory.scope.endAt);
        assert.deepEqual(priorReviewHistory.pendingRequests, []);
        assert.deepEqual(
          priorReviewHistory.commands.map((command) => command.commandId),
          [reviewers[0].nativeSession.commandId],
        );
        assert.deepEqual(
          nextReviewHistory.commands.map((command) => command.commandId),
          [reviewers[1].nativeSession.commandId],
        );

        report.fixCommandId = fix.nativeCommandId;
        if (via === 'native-review-fix-stopped') {
          const recoveredSnapshot = read();
          const recovered = recoveredSnapshot.session;
          assert.notEqual(recovered.generation, binding.generation);
          assert.equal(recovered.nativeSessionId, snapshot.session.nativeSessionId);
          assert.equal(
            recoveredSnapshot.commands.length,
            2,
            'Idle recovery must not resubmit the original task',
          );
          report.checks.push(
            'stopped worker resumes the same conversation before accepting the new fix task',
          );
        }
        report.checks.push(
          'reviewer findings produce one leased worker fix, its terminal signal, corrected file and warm re-review under a new reviewer lease',
        );
      }
      assert.ok(reviewer?.nativeSession);
      assert.equal(reviewer.target, null);
      assert.notEqual(reviewer.nativeSession.sessionId, binding.sessionId);
      assert.ok(reviewer.nativeSession.acceptedAt);
      assert.ok(reviewer.reviewResultValidatedAt);
      const signal = JSON.parse(fs.readFileSync(path.join(cwd, reviewer.signalFile), 'utf8'));
      assert.equal(signal.status, 'complete');
      const resultFile = path.join(
        cwd,
        path.posix.dirname(reviewer.taskFile),
        reviewer.reviewResultFile,
      );
      assert.equal(JSON.parse(fs.readFileSync(resultFile, 'utf8')).verdict, 'pass');
      report.reviewerSessionId = reviewer.nativeSession.sessionId;
      await wait(
        () => rpc('run.get', { runId }).run,
        (current) => {
          assert.ok(
            current.status !== 'failed',
            `Artifact-only completion failed: ${current.error}`,
          );
          return current.status === 'done';
        },
        timeoutMs,
      );
      for (const owned of [context, reviewer]) {
        const stopped = rpc(
          'native.session.read',
          pinnedWorkerTarget(runId, owned.id, owned.nativeSession.leaseId),
        ).session;
        assert.ok(['closed', 'failed'].includes(stopped.state));
        assert.equal(stopped.processStopped, true);
      }
      if (deferredReleaseRace) {
        assert.ok(
          fs.existsSync(`${deferredFault}.held`),
          'A real retiring engine cleanup must be delayed',
        );
        assert.ok(
          fs.existsSync(`${deferredFault}.resumed`),
          'Successor must produce a real deferred release',
        );
        const interleaving = JSON.parse(fs.readFileSync(`${deferredFault}.resumed`, 'utf8'));
        assert.equal(interleaving.runId, runId);
        assert.equal(interleaving.slotId, slotId);
        assert.ok(interleaving.successorGeneration > interleaving.oldGeneration);
        assert.equal(
          interleaving.consumedSuccessorRelease,
          false,
          'Old engine cleanup consumed its successor release',
        );
        report.deferredReleaseInterleaving = interleaving;
        report.checks.push(
          'a delayed retiring engine cleanup cannot consume the successor CI-watch deferred release',
        );
      }
      assert.equal(
        rpc('fleet.status').fleet.slots.find((slot) => slot.slot === slotId).currentRunId,
        null,
      );
      cancelled = true;

      report.checks.push(
        'native reviewer launches independently and completes through scoped signal, structured result and persisted review artifacts',
      );
      report.pass = true;
      const outPath = writeEvidence(report, SCENARIO_ID, report.runner, outDir);
      return { runner: report.runner, scenario: SCENARIO_ID, pass: true, outPath, report };
    }
    if (via === 'terminal-signal') {
      rpc('run.pause', { runId });
      const commandId = randomUUID();
      rpc('native.session.send', {
        sessionId,
        worker,
        commandId,
        text: `For this fixture only, write nonempty artifacts/learnings.md and artifacts/pr-description.md under ${path.posix.dirname(context.taskFile)} explaining the successful fixture. All checklist boxes are already checked. Then run ${path.posix.dirname(context.taskFile)}/mark complete. Use the existing mark helper; do not write SIGNAL.json directly. Do not commit or publish anything.`,
      });
      await wait(
        read,
        (current) => {
          const receipt = current.commands.find((command) => command.commandId === commandId);
          assert.ok(receipt?.state !== 'failed', 'Terminal signal task failed');
          return receipt?.outcome === 'completed' && current.session.state === 'idle';
        },
        timeoutMs,
      );
      const signal = JSON.parse(fs.readFileSync(path.join(cwd, context.signalFile), 'utf8'));
      assert.equal(signal.status, 'complete');
      assert.ok(signal.attemptId);
      assert.equal(rpc('run.get', { runId }).run.status, 'paused');
      assert.equal(rpc('run.probeWorkerSignal', { runId }).ok, true);
      const count = read().commands.length;
      rpc('run.replayStep', { runId, stepName: 'dispatch', skipPrepare: true });
      await wait(
        () => rpc('run.get', { runId }).run,
        (current) => {
          const dispatch = current.steps.find((step) => step.name === 'dispatch');
          return (
            dispatch?.status === 'done' &&
            Date.parse(dispatch.completedAt) > Date.parse(signal.timestamp)
          );
        },
        Math.min(timeoutMs, 30000),
      );
      assert.equal(
        rpc('run.probeWorkerSignal', { runId }).ok,
        true,
        'Native completion became stale after dispatch reconciliation',
      );
      await wait(
        () => rpc('run.get', { runId }).run,
        (current) => {
          const monitor = current.steps.find((step) => step.name === 'monitor');
          return (
            current.status === 'paused' &&
            monitor?.outputs?.workerSignal?.status === 'complete' &&
            monitor.outputs.reason === 'interactive-completion-operator-owned'
          );
        },
        timeoutMs,
      );
      assert.equal(read().commands.length, count, 'Signal reconciliation resent task input');
      assert.equal(
        JSON.parse(fs.readFileSync(path.join(cwd, context.signalFile), 'utf8')).timestamp,
        signal.timestamp,
      );
      const settled = rpc('run.interactiveDev.resolve', {
        runId,
        action: 'done-no-pr',
        reason: 'Native terminal signal fixture complete',
      });
      assert.equal(settled.ok, true);
      assert.equal(settled.run.status, 'done');
      const stopped = read().session;
      assert.ok(['closed', 'failed'].includes(stopped.state));
      assert.equal(stopped.processStopped, true);
      cancelled = true;
      report.checks.push(
        'real mark completion passes artifact validation and remains valid across dispatch reconciliation; operator completion releases worker',
      );
      report.pass = true;
      const outPath = writeEvidence(report, SCENARIO_ID, report.runner, outDir);
      return { runner: report.runner, scenario: SCENARIO_ID, pass: true, outPath, report };
    }
    if (via === 'supervisor-census') {
      const fault = process.env.FARMSLOT_NATIVE_CENSUS_FAULT;
      const stateRoot = process.env.FARMSLOT_NATIVE_STATE_DIR;
      const privateRoot = fs.realpathSync(path.join(ROOT, 'temp/native-validation')) + path.sep;
      assert.ok(fault && path.resolve(fault).startsWith(privateRoot));
      assert.ok(stateRoot && fs.realpathSync(stateRoot).startsWith(privateRoot));
      assert.equal(fs.existsSync(fault), false, 'Use a new private census fault');
      const host = JSON.parse(fs.readFileSync(path.join(stateRoot, 'host.json'), 'utf8'));
      assert.ok(
        fs.existsSync(`${fault}.${host.pid}.loaded`),
        'Supervisor did not load census fixture',
      );
      const commandId = randomUUID();
      const pidFile = `native-census-${randomUUID()}.pid`;
      const effectFile = `native-census-${randomUUID()}.effect`;
      rpc('native.session.send', {
        sessionId,
        worker,
        commandId,
        text: `Use a shell tool to run exactly: printf '%s' "$$" > ${pidFile}; sleep 15; printf completed > ${effectFile}. Do not background it, and do nothing else.`,
      });
      await wait(() => fs.existsSync(path.join(cwd, pidFile)), Boolean, timeoutMs);
      const toolPid = Number(fs.readFileSync(path.join(cwd, pidFile), 'utf8'));
      assert.ok(Number.isSafeInteger(toolPid) && toolPid > 0);
      fs.writeFileSync(
        fault,
        JSON.stringify({ root: stateRoot, armed: false, observePid: toolPid }),
        { mode: 0o600 },
      );
      await wait(() => fs.existsSync(`${fault}.observed`), Boolean, 10000);
      fs.writeFileSync(fault, JSON.stringify({ root: stateRoot, armed: true }), { mode: 0o600 });
      const alive = (pid) => {
        try {
          process.kill(pid, 0);
          return true;
        } catch (error) {
          if (error.code === 'ESRCH') return false;
          throw error;
        }
      };
      await wait(
        () =>
          fs.existsSync(`${fault}.fired`) &&
          !alive(host.pid) &&
          !alive(snapshot.session.hostPid) &&
          !alive(snapshot.session.processPid) &&
          !alive(toolPid),
        Boolean,
        20000,
      );
      const cleanup = JSON.parse(fs.readFileSync(path.join(stateRoot, 'cleanup.json'), 'utf8'));
      assert.equal(cleanup.state, 'complete');
      assert.match(cleanup.error, /census timeout/);
      let recovered;
      await wait(
        () => {
          try {
            recovered = read();
            return true;
          } catch (error) {
            // A read overlapping the old supervisor exit can observe its startup hold.
            // Retry reads only; timeout still fails this proof rather than implying recovery.
            if (!error.message.includes('NATIVE_SESSION_ERROR')) throw error;
            return false;
          }
        },
        Boolean,
        20000,
      );
      assert.equal(recovered.session.state, 'failed');
      assert.equal(recovered.session.processStopped, true);
      assert.equal(recovered.session.generation, binding.generation);
      assert.ok(
        !recovered.events.some(
          (event) =>
            event.commandId === commandId &&
            event.type === 'turn.completed' &&
            event.status === 'completed',
        ),
      );
      await new Promise((resolve) => setTimeout(resolve, 16000));
      assert.equal(
        fs.existsSync(path.join(cwd, effectFile)),
        false,
        'Owned command continued after census failure cleanup',
      );
      assert.notEqual(rpc('run.get', { runId }).run.status, 'done');
      report.checks.push(
        'supervisor census failure stops host/runner/tool, prevents late effects, and recovers failed session state without task completion',
      );
    }
    if (
      via === 'cancel-deferred-resume' ||
      via === 'cancel-resume-probe' ||
      via === 'cancel-resume-generation-race'
    ) {
      await verifyCancelledDeferredResume({
        runId,
        context,
        binding,
        slotId,
        timeoutMs,
        duringProbe: via === 'cancel-resume-probe',
        raceApplied: via === 'cancel-resume-generation-race',
      });
      cancelled = true;
      report.checks.push(
        'cancel fences delayed recovery, reconciles any racing generation, confirms process cleanup and releases the slot without new task commands',
      );
      report.pass = true;
      const outPath = writeEvidence(report, SCENARIO_ID, report.runner, outDir);
      return { runner: report.runner, scenario: SCENARIO_ID, pass: true, outPath, report };
    }
    if (via === 'native-queue' || via === 'native-queue-prepare') {
      const checkpoint = await verifyNativeWorkerQueue({
        runId,
        binding,
        slotId,
        cwd,
        runner: report.runner,
        model,
        timeoutMs,
        outDir,
        prepareOnly: via === 'native-queue-prepare',
      });
      if (checkpoint) {
        preserveForRecovery = true;
        report.recoveryState = checkpoint;
        report.awaitingGatewayRestart = true;
        report.complete = false;
        report.pass = true;
        const outPath = writeEvidence(report, SCENARIO_ID, report.runner, outDir);
        return { runner: report.runner, scenario: SCENARIO_ID, pass: true, outPath, report };
      }
      cancelled = true;
      report.checks.push(
        'native queue preserves stored profile ownership and transport, refuses another principal, and dispatches one real native worker after slot release',
      );
      report.pass = true;
      const outPath = writeEvidence(report, SCENARIO_ID, report.runner, outDir);
      return { runner: report.runner, scenario: SCENARIO_ID, pass: true, outPath, report };
    }
    if (via === 'worker-ui') {
      await verifyNativeWorkerUi({ runId, context, binding, cwd, slotId, timeoutMs, outDir });
      report.checks.push(
        'slot native conversation sends pinned input, shows live tool/file changes and reconnects without resending through real browser controls',
      );
    }
    if (via === 'cancel-late-monitor') {
      await verifyCancelledMonitorLateRead({ runId, binding, slotId, timeoutMs });
      cancelled = true;
      report.checks.push(
        'a real delayed native liveness reply cannot recreate a handoff decision or resurrect a cancelled run',
      );
      report.pass = true;
      const outPath = writeEvidence(report, SCENARIO_ID, report.runner, outDir);
      return { runner: report.runner, scenario: SCENARIO_ID, pass: true, outPath, report };
    }
    if (via === 'close-resume-serialization') {
      await verifyNativeCloseResumeOrder({ runId, context, binding, timeoutMs });
      const result = rpc('run.cancel', {
        runId,
        reason: 'Native close/resume ordering proof cleanup',
      });
      assert.ok(result.effects.every((effect) => effect.status !== 'failed'));
      assert.equal(read().session.processStopped, true);
      cancelled = true;
      report.checks.push(
        'public close confirms its pinned process stopped before queued Resume may establish the next generation',
      );
      report.pass = true;
      const outPath = writeEvidence(report, SCENARIO_ID, report.runner, outDir);
      return { runner: report.runner, scenario: SCENARIO_ID, pass: true, outPath, report };
    }
    if (via === 'resume-reply-prepare') {
      resumeFault = process.env.FARMSLOT_NATIVE_RESUME_REPLY_FAULT;
      rpc('run.pause', { runId });
      rpc('native.session.close', { sessionId, worker });
      const statePath = await prepareNativeResumeReply({
        runId,
        context,
        binding,
        cwd,
        marker,
        expectedMarker: id,
        slotId,
        outDir,
      });
      report.checks.push(
        'native resume applied; reply withheld while the gateway retains the old generation and durable intent',
      );
      report.recoveryState = statePath;
      report.awaitingGatewayRestart = true;
      report.complete = false;
      report.pass = true;
      preserveForRecovery = true;
      const outPath = writeEvidence(report, SCENARIO_ID, report.runner, outDir);
      return { runner: report.runner, scenario: SCENARIO_ID, pass: true, outPath, report };
    }
    if (via === 'resume-worker') {
      const original = { ...binding };
      const originalNative = read().session;
      rpc('run.pause', { runId });
      rpc('native.session.close', { sessionId, worker });
      assert.equal(read().session.processStopped, true);
      const resumed = rpc('run.resume', { runId }).run;
      assert.equal(resumed.status, 'monitoring');
      binding = resumed.agentContexts.find(
        (candidate) => candidate.id === context.id,
      ).nativeSession;
      assert.equal(binding.sessionId, original.sessionId);
      assert.equal(binding.leaseId, original.leaseId);
      assert.equal(binding.commandId, original.commandId);
      assert.notEqual(binding.generation, original.generation);
      assert.equal(binding.closedAt, undefined);
      assert.equal(binding.recovery, undefined);
      const continued = await wait(
        read,
        (current) => {
          const commands = current.commands.filter(
            (command) => command.commandId !== original.commandId,
          );
          assert.ok(
            !commands.some((command) => command.state === 'failed'),
            'Native resume continuation failed',
          );
          return (
            commands.length === 1 &&
            commands[0].outcome === 'completed' &&
            current.session.state === 'idle'
          );
        },
        timeoutMs,
      );
      assert.equal(continued.session.nativeSessionId, originalNative.nativeSessionId);
      assert.notEqual(continued.session.processPid, originalNative.processPid);
      assert.equal(
        continued.commands.filter((command) => command.commandId === original.commandId).length,
        1,
      );
      expectInputRefused('native.session.send', {
        sessionId,
        worker,
        commandId: randomUUID(),
        text: 'Stale process generation',
      });
      rpc('run.pause', { runId });
      rpc('run.resume', { runId });
      const liveResume = read();
      assert.equal(liveResume.session.generation, binding.generation);
      assert.equal(
        liveResume.commands.length,
        continued.commands.length,
        'Resuming a live worker resent work',
      );
      assert.equal(fs.readFileSync(path.join(cwd, marker), 'utf8').trim(), id);
      report.checks.push(
        'stopped worker resumes its saved conversation without replaying the original command; live resume sends nothing',
      );
    }
    if (via === 'fresh-worker') {
      const original = { ...binding };
      const originalSessionId = sessionId;
      const taskProgress = fs.readFileSync(fixtureChecklistPath(cwd, context.taskFile), 'utf8');
      const commandCount = read().commands.length;
      rpc('run.replayStep', { runId, stepName: 'dispatch', skipPrepare: true });
      const reconciled = await wait(
        () => rpc('run.get', { runId }).run,
        (current) => {
          assert.ok(
            !['failed', 'cancelled', 'blocked'].includes(current.status),
            `Reconciliation ${current.status}: ${current.error}`,
          );
          return current.status === 'monitoring';
        },
        timeoutMs,
      );
      const reconciledBinding = reconciled.agentContexts.find(
        (candidate) => candidate.id === context.id,
      ).nativeSession;
      assert.equal(reconciledBinding.sessionId, original.sessionId);
      assert.equal(reconciledBinding.commandId, original.commandId);
      assert.equal(reconciledBinding.leaseId, original.leaseId);
      assert.equal(read().commands.length, commandCount);
      assert.equal(
        fs.readFileSync(fixtureChecklistPath(cwd, context.taskFile), 'utf8'),
        taskProgress,
      );
      assert.equal(fs.readFileSync(path.join(cwd, marker), 'utf8').trim(), id);
      report.checks.push(
        'dispatch reconciliation preserves checked task progress and does not send another command',
      );
      rpc('run.replayStep', {
        runId,
        stepName: 'dispatch',
        freshDispatch: true,
        skipPrepare: true,
      });
      const restarted = await wait(
        () => rpc('run.get', { runId }).run,
        (current) => {
          assert.ok(
            !['failed', 'cancelled', 'blocked'].includes(current.status),
            `Fresh task ${current.status}: ${current.error}`,
          );
          return current.status === 'monitoring';
        },
        timeoutMs,
      );
      const next = restarted.agentContexts.find((candidate) => candidate.id === context.id);
      binding = next.nativeSession;
      sessionId = binding.sessionId;
      readSelection = { runId, contextId: next.id, leaseId: binding.leaseId };
      assert.notEqual(binding.sessionId, original.sessionId);
      assert.notEqual(binding.leaseId, original.leaseId);
      assert.notEqual(binding.commandId, original.commandId);
      assert.ok(
        next.nativeSessionHistory.some(
          (prior) =>
            prior.sessionId === original.sessionId &&
            prior.generation === original.generation &&
            prior.leaseId === original.leaseId &&
            prior.closedAt,
        ),
      );
      const previous = rpc(
        'native.session.read',
        pinnedWorkerTarget(runId, context.id, original.leaseId),
      ).session;
      assert.equal(previous.state, 'closed');
      assert.equal(previous.processStopped, true);
      await wait(
        read,
        (current) => {
          const receipt = current.commands.find(
            (command) => command.commandId === binding.commandId,
          );
          assert.ok(receipt?.state !== 'failed', 'Fresh native task failed');
          return receipt?.outcome === 'completed' && current.session.state === 'idle';
        },
        timeoutMs,
      );
      assert.deepEqual(fs.readFileSync(path.join(cwd, marker), 'utf8').trim().split('\n'), [
        id,
        id,
      ]);
      expectInputRefused('native.session.send', {
        sessionId: originalSessionId,
        worker,
        commandId: randomUUID(),
        text: 'Old attempt must not receive input',
      });
      report.sessionId = sessionId;
      report.checks.push(
        'explicit fresh dispatch stops and archives the old attempt, then executes once with a new session, lease and command',
      );
    }
    if (
      via === 'retained-handoff' ||
      via === 'history-pending-request' ||
      via === 'retained-handoff-stopped' ||
      via === 'cancel-handoff' ||
      via === 'force-handoff' ||
      via === 'native-nudge' ||
      via === 'native-nudge-busy' ||
      via === 'native-nudge-replay' ||
      via === 'native-fresh-reuse'
    ) {
      const nativeNudge = ['native-nudge', 'native-nudge-busy', 'native-nudge-replay'].includes(
        via,
      );
      const freshReuse = via === 'native-fresh-reuse';
      const stoppedHandoff = via === 'retained-handoff-stopped';
      if (freshReuse) {
        const projectPath = path.join(
          ROOT,
          'temp/native-validation/projects',
          slot.project,
          'project.json',
        );
        nativeFreshProject = { path: projectPath, content: fs.readFileSync(projectPath, 'utf8') };
        const project = JSON.parse(nativeFreshProject.content);
        nativeFreshPrepareReceipt = path.join(
          cwd,
          `native-stopped-before-prepare-${randomUUID()}.json`,
        );
        const hook = path.join(
          ROOT,
          'scripts/runner-validation/fixtures/native-stopped-preflight.mjs',
        );
        assert.ok(snapshot.session.processPid);
        const quote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;
        fs.writeFileSync(
          projectPath,
          JSON.stringify(
            {
              ...project,
              prepare: {
                ...project.prepare,
                profiles: {
                  ...project.prepare?.profiles,
                  'native-stop-proof': {
                    phases: ['preflight'],
                    hooks: {
                      preflight: `node ${quote(hook)} ${snapshot.session.processPid} ${quote(nativeFreshPrepareReceipt)}`,
                    },
                  },
                },
              },
            },
            null,
            2,
          ),
        );
      }
      const parentRunId = runId;
      report.parentRunId = parentRunId;
      const childId = `NATIVE-${Date.now()}`;
      const childMarker = `native-handoff-${randomUUID()}.txt`;
      const childFlow = nativeNudge || freshReuse ? 'pr-complete' : 'dev';
      const childTaskDir = path.join(ROOT, 'projects', slot.project, 'tasks', childFlow, childId);
      fs.mkdirSync(childTaskDir, { recursive: true });
      const childTask = path.join(childTaskDir, 'TASK.md');
      await writeNativeFixtureTask(
        childTask,
        `# Worker: ${childFlow}\n\n- Task profile: ${childFlow}\n\n` +
          (freshReuse
            ? `Write ${childMarker} with exactly ${id}. `
            : `Write ${childMarker} with exactly the value you wrote in the previous task, from conversation memory. `) +
          'Do not read earlier task files or marker files. Do not write a terminal signal or commit. End the turn after writing the file.\n',
        slot.project,
      );
      if (via === 'cancel-handoff' || via === 'force-handoff') {
        handoffFault = process.env.FARMSLOT_NATIVE_HANDOFF_FAULT;
        assert.ok(
          handoffFault &&
            path
              .resolve(handoffFault)
              .startsWith(path.join(ROOT, 'temp/native-validation') + path.sep),
        );
        assert.equal(fs.existsSync(handoffFault), false, 'Use a new private transfer fault file');
        const pids = [
          ...new Set(
            execFileSync('lsof', ['-t', '-nP', '-iTCP:18777', '-sTCP:LISTEN'], { encoding: 'utf8' })
              .trim()
              .split(/\s+/),
          ),
        ];
        assert.equal(pids.length, 1);
        const gatewayPid = Number(pids[0]);
        assert.ok(
          fs.existsSync(`${handoffFault}.${gatewayPid}.loaded`),
          'Gateway did not load the transfer-delay fixture',
        );
        fs.writeFileSync(
          handoffFault,
          JSON.stringify({
            gatewayPid,
            sessionId,
            ...(via === 'force-handoff' ? { mode: 'reject' } : {}),
          }),
          { mode: 0o600 },
        );
      }
      if (via === 'native-nudge-busy' || via === 'native-nudge-replay' || freshReuse) {
        const ready = `native-nudge-ready-${randomUUID()}`;
        const release = `native-nudge-release-${randomUUID()}`;
        nativeNudgeRelease = path.join(cwd, release);
        const lateEffect = `native-fresh-late-${randomUUID()}`;
        if (freshReuse) nativeFreshLateEffect = path.join(cwd, lateEffect);
        const commandId = randomUUID();
        rpc('native.session.send', {
          sessionId,
          worker,
          commandId,
          text: `Run this shell command and wait for it to finish: touch ${ready}; while [ ! -f ${release} ]; do sleep 1; done${freshReuse ? `; touch ${lateEffect}` : ''}. Then end the turn without other changes or terminal signals.`,
        });
        await wait(() => fs.existsSync(path.join(cwd, ready)), Boolean, timeoutMs);
        assert.equal(read().session.state, 'running');
      }
      if (stoppedHandoff) {
        rpc('native.session.close', {
          sessionId,
          worker,
          executionNodeId: binding.executionNodeId,
        });
        assert.equal(read().session.processStopped, true);
      }
      const sourceSelection = { ...readSelection };
      const readSourceHistory = () =>
        readPinnedWorkerHistory(
          sourceSelection.runId,
          sourceSelection.contextId,
          sourceSelection.leaseId,
        );
      const sourceHistory = readSourceHistory();
      const child = rpc('run.createNative', {
        flowType: childFlow,
        project: slot.project,
        ticketOrPr: nativeNudge || freshReuse ? 'deeeed/farmslot#620' : childId,
        slotId,
        allowedSlots: [slotId],
        taskFile: childTask,
        parentRunId,
        familyId: run.familyId,
        runner: report.runner,
        ...(model ? { model } : {}),
        mode: 'interactive',
        skipPrepare: !freshReuse,
        safetyTier: 'full-auto',
        ...(freshReuse
          ? {
              freshReuse: true,
              prepareProfile: 'native-stop-proof',
              branch: execFileSync('git', ['branch', '--show-current'], {
                cwd,
                encoding: 'utf8',
              }).trim(),
            }
          : nativeNudge
            ? {
                nudgeReuse: true,
                branch: execFileSync('git', ['branch', '--show-current'], {
                  cwd,
                  encoding: 'utf8',
                }).trim(),
                runner: 'claude',
                model: 'fable',
              }
            : { engineState: { flags: { warmSessionReuse: true } } }),
      });
      runId = child.run.id;
      report.runId = runId;
      writeEvidence(report, SCENARIO_ID, report.runner, outDir);
      if (via === 'native-nudge-busy' || via === 'native-nudge-replay') {
        await wait(
          () => rpc('run.get', { runId }).run,
          (current) => {
            assert.ok(!['failed', 'cancelled', 'blocked'].includes(current.status), current.error);
            return current.status === 'dispatching';
          },
          timeoutMs,
        );
        await new Promise((resolve) => setTimeout(resolve, 2000));
        const waiting = rpc('run.get', { runId }).run;
        assert.equal(waiting.status, 'dispatching');
        assert.ok(
          !waiting.agentContexts.some((context) => context.nativeSession),
          'Busy nudge reserved a native lease before the old turn finished',
        );
        assert.equal(read().session.workerLeaseId, binding.leaseId);
        assert.equal(rpc('run.get', { runId: parentRunId }).run.status, 'monitoring');
        if (via === 'native-nudge-replay') {
          await verifyNativeNudgeReplay({
            runId,
            parentRunId,
            releasePath: nativeNudgeRelease,
            binding,
            read,
            timeoutMs,
            outDir,
          });
          cancelled = true;
          report.checks.push(
            'replay retires the waiting nudge without settings writes, lease transfer or dispatch',
          );
          report.pass = true;
          const outPath = writeEvidence(report, SCENARIO_ID, report.runner, outDir);
          return { runner: report.runner, scenario: SCENARIO_ID, pass: true, outPath, report };
        }
        fs.writeFileSync(nativeNudgeRelease, 'continue\n');
        report.checks.push(
          'busy native nudge waits without replacing the current task lease or stopping its monitor',
        );
      }
      if (via === 'force-handoff') {
        const failed = await wait(
          () => rpc('run.get', { runId }).run,
          (current) => current.status === 'blocked',
          timeoutMs,
        );
        const reserved = failed.agentContexts.find(
          (context) => context.role === 'dev',
        ).nativeSession;
        assert.equal(reserved.handoffFrom.leaseId, binding.leaseId);
        assert.equal(reserved.handoffCompletedAt, undefined);
        assert.equal(read().session.workerLeaseId, binding.leaseId);
        // The existing blocked-run override requires a published PR reference.
        // Supply the fixture's known reference through the real input contract.
        const prNumber = Number(process.env.FARMSLOT_VALIDATION_PUBLISHED_PR);
        assert.ok(Number.isSafeInteger(prNumber) && prNumber > 0);
        const forced = rpc('run.forceComplete', { runId, prNumber }, 30000);
        report.publishedReferencePr = prNumber;
        assert.equal(forced.run.status, 'done');
        assert.ok(forced.effects.every((effect) => effect.status !== 'failed'));
        const parent = rpc('run.get', { runId: parentRunId }).run;
        assert.equal(parent.status, 'cancelled');
        assert.ok(
          parent.agentContexts.find((candidate) => candidate.id === context.id).nativeSession
            .releasedAt,
        );
        const source = readSourceHistory();
        const stopped = readPinnedWorkerHistory(
          runId,
          failed.agentContexts.find((entry) => entry.nativeSession?.leaseId === reserved.leaseId)
            .id,
          reserved.leaseId,
        );
        assertWorkerHistoryTransfer(sourceHistory, source, stopped);
        assert.deepEqual(
          stopped.commands,
          [],
          'Cancelled successor must not inherit source receipts',
        );
        assert.equal(stopped.session.processStopped, true);
        assert.ok(!stopped.commands.some((command) => command.commandId === reserved.commandId));
        assert.equal(fs.existsSync(path.join(cwd, childMarker)), false);
        await wait(
          () => rpc('fleet.status').fleet.slots.find((slot) => slot.slot === slotId),
          (slot) => slot.currentRunId === null,
          10000,
        );
        cancelled = true;
        report.checks.push(
          'force-complete of an uncertain native handoff retires its source and releases the slot without a lifecycle lock deadlock',
        );
        report.pass = true;
        const outPath = writeEvidence(report, SCENARIO_ID, report.runner, outDir);
        return { runner: report.runner, scenario: SCENARIO_ID, pass: true, outPath, report };
      } else if (via === 'cancel-handoff') {
        await wait(() => fs.existsSync(`${handoffFault}.blocked`), Boolean, 20000);
        const reserved = rpc('run.get', { runId }).run.agentContexts.find(
          (context) => context.role === 'dev',
        ).nativeSession;
        assert.equal(reserved.handoffFrom.leaseId, binding.leaseId);
        assert.equal(
          read().session.workerLeaseId,
          binding.leaseId,
          'Transfer was not delayed before application',
        );
        cancelResult = rpc('run.cancel', {
          runId,
          reason: 'Cancel while native transfer is delayed',
        });
        cancelled = true;
        assert.ok(
          cancelResult.effects.every((effect) => effect.status !== 'failed'),
          'Pending transfer cancellation did not finish cleanup',
        );
        fs.writeFileSync(`${handoffFault}.release`, '', { mode: 0o600 });
        await wait(() => fs.existsSync(`${handoffFault}.replied`), Boolean, 20000);
        const reply = JSON.parse(fs.readFileSync(`${handoffFault}.replied`, 'utf8'));
        assert.equal(reply.state, 'closed');
        assert.equal(reply.error, undefined);
        const successorContext = cancelResult.run.agentContexts.find(
          (entry) => entry.nativeSession?.leaseId === reserved.leaseId,
        );
        assert.ok(successorContext);
        const source = readSourceHistory();
        const stopped = readPinnedWorkerHistory(runId, successorContext.id, reserved.leaseId);
        assertWorkerHistoryTransfer(sourceHistory, source, stopped);
        assert.deepEqual(
          stopped.commands,
          [],
          'Cancelled successor must not inherit source receipts',
        );
        readSelection = { runId, contextId: successorContext.id, leaseId: reserved.leaseId };
        binding = successorContext.nativeSession;
        assert.equal(stopped.session.state, 'closed');
        assert.ok(
          !stopped.commands.some((command) => command.commandId === reserved.commandId),
          'Delayed transfer started the cancelled task',
        );
        assert.equal(fs.existsSync(path.join(cwd, childMarker)), false);
        assert.equal(rpc('run.get', { runId }).run.status, 'cancelled');
        const parent = rpc('run.get', { runId: parentRunId }).run;
        assert.equal(parent.status, 'cancelled');
        assert.ok(
          parent.agentContexts.find((candidate) => candidate.id === context.id)?.nativeSession
            ?.releasedAt,
        );
        report.checks.push(
          'cancellation fences a delayed native transfer; neither task nor process is resurrected',
        );
      } else {
        const successor = await wait(
          () => rpc('run.get', { runId }).run,
          (current) => {
            assert.ok(
              !['failed', 'cancelled', 'blocked'].includes(current.status),
              `Handoff ${current.status}: ${current.error}`,
            );
            return current.status === 'monitoring';
          },
          timeoutMs,
        );
        const nextContext = successor.agentContexts.find((context) =>
          freshReuse
            ? context.nativeSession
            : context.nativeSession?.handoffFrom?.runId === parentRunId,
        );
        const next = nextContext.nativeSession;
        if (nativeNudge) {
          assert.equal(successor.metrics.runner, context.runner);
          assert.equal(successor.metrics.model, context.model);
          assert.equal(next.accountLabel, binding.accountLabel);
          assert.equal(next.effort, binding.effort);
          assert.equal(next.safetyTier, binding.safetyTier);
          report.checks.push(
            'native nudge preserves the actual worker model, account and launch settings',
          );
        }
        assert.notEqual(next.leaseId, binding.leaseId);
        assert.notEqual(next.commandId, binding.commandId);
        if (freshReuse) {
          const preparation = JSON.parse(fs.readFileSync(nativeFreshPrepareReceipt, 'utf8'));
          assert.equal(preparation.pid, snapshot.session.processPid);
          assert.equal(preparation.stopped, true);
          assert.notEqual(next.sessionId, binding.sessionId);
          assert.notEqual(next.generation, binding.generation);
          assert.equal(
            read().session.processStopped,
            true,
            'Fresh dispatch began before the old native process stopped',
          );
          fs.writeFileSync(nativeNudgeRelease, 'continue\n');
          await new Promise((resolve) => setTimeout(resolve, 1500));
          assert.equal(
            fs.existsSync(nativeFreshLateEffect),
            false,
            'Old native tool survived fresh replacement',
          );
          sessionId = next.sessionId;
          report.sessionId = sessionId;
        } else {
          assert.equal(next.sessionId, binding.sessionId);
          if (stoppedHandoff) {
            assert.notEqual(next.generation, binding.generation);
          } else assert.equal(next.generation, binding.generation);
          assert.ok(next.handoffCompletedAt);
        }
        binding = next;
        readSelection = { runId, contextId: nextContext.id, leaseId: next.leaseId };
        const handed = await wait(
          read,
          (current) => {
            const receipt = current.commands.find(
              (command) => command.commandId === next.commandId,
            );
            assert.ok(receipt?.state !== 'failed', 'Retained task failed');
            return receipt?.outcome === 'completed' && current.session.state === 'idle';
          },
          timeoutMs,
        );
        if (freshReuse) {
          assert.notEqual(handed.session.processPid, snapshot.session.processPid);
          assert.notEqual(handed.session.nativeSessionId, snapshot.session.nativeSessionId);
          assert.equal(handed.commands.length, 1);
        } else {
          if (stoppedHandoff)
            assert.notEqual(handed.session.processPid, snapshot.session.processPid);
          else assert.equal(handed.session.processPid, snapshot.session.processPid);
          assert.equal(handed.session.nativeSessionId, snapshot.session.nativeSessionId);
        }
        assert.equal(handed.session.workerLeaseId, next.leaseId);
        const sourceAfter = readSourceHistory();
        const successorHistory = readPinnedWorkerHistory(runId, nextContext.id, next.leaseId);
        if (!freshReuse) assertWorkerHistoryTransfer(sourceHistory, sourceAfter, successorHistory);
        else {
          assert.equal(sourceAfter.session.processStopped, true);
          assert.equal(successorHistory.scope.startAfter, 0);
          assert.ok(
            !successorHistory.commands.some((command) =>
              sourceAfter.commands.some((prior) => prior.commandId === command.commandId),
            ),
          );
        }
        assert.deepEqual(
          successorHistory.commands.map((command) => command.commandId),
          [next.commandId],
        );
        assert.deepEqual(
          readSourceHistory(),
          sourceAfter,
          'Retired source history changed during successor inspection',
        );
        report.checks.push(
          'source and successor task histories have separate event windows and command receipts',
        );
        if (via === 'history-pending-request') {
          const commandId = randomUUID();
          const target = pinnedWorkerTarget(runId, nextContext.id, next.leaseId);
          rpc('native.session.send', {
            ...target,
            commandId,
            text: 'Use your structured question tool once to ask: Which validation color should we choose? Offer exactly Amber and Violet. Wait for my structured answer, then reply with the selected label only. Do not answer it yourself. Do not use shell or filesystem tools or emit a task terminal signal.',
          });
          const waiting = await wait(
            read,
            (snapshot) => {
              const pending = snapshot.pendingRequests.some(
                (request) => request.type === 'question.requested',
              );
              const command = snapshot.commands.find((entry) => entry.commandId === commandId);
              assert.ok(
                pending || !['completed', 'failed', 'interrupted'].includes(command?.outcome),
                'Runner ended the turn without a structured question',
              );
              return pending;
            },
            timeoutMs,
          );
          const request = waiting.pendingRequests.find(
            (event) => event.type === 'question.requested',
          );
          assert.equal(request.commandId, commandId);
          assert.deepEqual(
            readSourceHistory(),
            sourceAfter,
            'Successor pending request changed retired history',
          );
          assert.throws(
            () =>
              rpc('native.session.respond', {
                sessionId,
                executionNodeId: next.executionNodeId,
                worker,
                requestId: request.request.id,
                answers: {},
              }),
            /closed, transferred or stale/,
          );
          const { runScenario: inspectHistoryUi } = await import('./native-worker-history-ui.mjs');
          const historyUi = await inspectHistoryUi({
            explicit: true,
            timeoutMs,
            outDir,
            prior: { parentRunId, runId, sessionId },
          });
          assert.equal(historyUi.pass, true, historyUi.report.error);
          const question = request.request.questions[0];
          assert.ok(question.options.some((option) => option.label === 'Violet'));
          rpc('native.session.respond', {
            ...target,
            requestId: request.request.id,
            answers: { [question.id]: ['Violet'] },
          });
          await wait(
            read,
            (snapshot) =>
              snapshot.session.state === 'idle' &&
              snapshot.commands.find((entry) => entry.commandId === commandId)?.outcome ===
                'completed',
            timeoutMs,
          );
          assert.deepEqual(
            readSourceHistory(),
            sourceAfter,
            'Successor response changed retired history',
          );
          report.checks.push(
            'a live successor question stays absent from retired task API and browser history; only the successor lease can answer',
          );
        }
        if (stoppedHandoff) {
          const currentContext = rpc('run.get', { runId }).run.agentContexts.find(
            (candidate) => candidate.nativeSession?.sessionId === sessionId,
          );
          const newSignalPath = path.join(cwd, currentContext.signalFile);
          assert.ok(fs.existsSync(newSignalPath), 'New task never began its signal attempt');
          const newSignal = JSON.parse(fs.readFileSync(newSignalPath, 'utf8'));
          const oldSignal = JSON.parse(fs.readFileSync(path.join(cwd, context.signalFile), 'utf8'));
          assert.equal(newSignal.status, 'running');
          assert.ok(newSignal.attemptId && oldSignal.attemptId);
          assert.notEqual(newSignal.attemptId, oldSignal.attemptId);
          assert.equal(
            handed.commands.length,
            1,
            'Saved handoff sent an extra continuation before its initial task',
          );
        }
        expectInputRefused('native.session.send', {
          sessionId,
          worker,
          commandId: randomUUID(),
          text: 'Stale task must not receive input',
        });
        expectInputRefused('native.session.send', {
          sessionId,
          worker: { ...worker, leaseId: next.leaseId },
          commandId: randomUUID(),
          text: 'Old run must not adopt successor input',
        });
        report.checks.push('transferred run views cannot send into the successor task');
        assert.equal(fs.readFileSync(path.join(cwd, childMarker), 'utf8').trim(), id);
        const parent = rpc('run.get', { runId: parentRunId }).run;
        assert.equal(parent.status, 'cancelled');
        const retired = parent.agentContexts.find(
          (candidate) => candidate.id === context.id,
        )?.nativeSession;
        assert.ok(freshReuse ? retired?.closedAt : retired?.releasedAt);
        if (freshReuse) {
          assert.ok(
            Date.parse(retired.closedAt) <=
              Date.parse(successor.steps.find((step) => step.name === 'prepare').startedAt),
            'Fresh preparation began before previous native cleanup',
          );
          report.checks.push(
            'native cleanup completed before the prepare step; the real prepare hook confirms process absence',
          );
        }
        assert.equal(
          rpc('fleet.status').fleet.slots.find((slot) => slot.slot === slotId).currentRunId,
          runId,
        );
        report.checks.push(
          freshReuse
            ? 'fresh reuse stops the old native worker and tool before starting one new conversation'
            : stoppedHandoff
              ? 'stopped native handoff transfers its lease and resumes the exact saved conversation before sending the new task'
              : 'retained handoff keeps native identity/process/context, rotates task lease, and retires prior run without releasing successor slot',
        );
      }
    }
    const result =
      cancelResult ??
      rpc('run.cancel', { runId, reason: 'Native worker lifecycle fixture complete' });
    cancelled = true;
    assert.ok(result.effects.every((effect) => effect.status !== 'failed'));
    const closedBinding = result.run.agentContexts.find(
      (context) => context.nativeSession?.sessionId === sessionId,
    )?.nativeSession;
    assert.equal(
      closedBinding?.sessionId,
      sessionId,
      'Cancel discarded native ownership before cleanup',
    );
    assert.ok(closedBinding.closedAt);
    const closed = read().session;
    assert.ok(['closed', 'failed'].includes(closed.state));
    assert.equal(closed.processStopped, true);
    assert.equal(closed.generation, binding.generation);
    assert.equal(
      rpc('fleet.status').fleet.slots.find((slot) => slot.slot === slotId).currentRunId,
      null,
    );
    report.checks.push('cancel preserves binding, confirms stopped process and releases slot');
    report.pass = true;
  } catch (error) {
    report.error = error.message;
  } finally {
    if (nativeNudgeRelease && !fs.existsSync(nativeNudgeRelease))
      fs.writeFileSync(nativeNudgeRelease, 'cleanup\n');
    if (resumeFault && fs.existsSync(resumeFault) && !preserveForRecovery)
      fs.writeFileSync(`${resumeFault}.release`, '', { mode: 0o600 });
    if (handoffFault && fs.existsSync(handoffFault))
      fs.writeFileSync(`${handoffFault}.release`, '', { mode: 0o600 });
    for (const cleanupId of preserveForRecovery
      ? []
      : [...new Set([runId, report.parentRunId].filter(Boolean))]) {
      if (cleanupId === runId && cancelled) continue;
      try {
        const current = rpc('run.get', { runId: cleanupId }).run;
        if (!['cancelled', 'done', 'failed'].includes(current.status)) {
          const result = rpc(
            'run.cancel',
            {
              runId: cleanupId,
              reason: 'Cleanup native worker fixture',
            },
            via === 'force-handoff' ? 10000 : 120000,
          );
          assert.ok(
            result.effects.every((effect) => effect.status !== 'failed'),
            `Cleanup incomplete for ${cleanupId}`,
          );
        } else if (current.status === 'failed') {
          // Failed runs can retain workers for inspection. Release this private fixture
          // through the production lifecycle, since terminal runs reject run.cancel.
          const owned = current.agentContexts.filter(
            (context) => context.nativeSession && !context.nativeSession.releasedAt,
          );
          const slot = rpc('fleet.status').fleet.slots.find((item) => item.slot === slotId);
          assert.ok(!slot.currentRunId || slot.currentRunId === cleanupId);
          rpc('slot.release', { slotId, keepWork: true });
          for (const context of owned) {
            const stopped = rpc('native.session.read', {
              ...pinnedWorkerTarget(cleanupId, context.id, context.nativeSession.leaseId),
            }).session;
            assert.equal(
              stopped.processStopped,
              true,
              'Failed fixture cleanup must stop its processes',
            );
          }
        }
      } catch (error) {
        // Preserve both the primary failure and each still-owned cleanup target in
        // evidence; one failed cleanup must not prevent trying the other fixture run.
        report.pass = false;
        report.error = [report.error, error.message].filter(Boolean).join('\n');
      }
    }
    if (originalReviewFixture && !preserveForRecovery)
      fs.writeFileSync(originalReviewFixture.path, originalReviewFixture.text);
    if (nativeFreshProject) fs.writeFileSync(nativeFreshProject.path, nativeFreshProject.content);
  }
  const outPath = writeEvidence(report, SCENARIO_ID, report.runner, outDir);
  return { runner: report.runner, scenario: SCENARIO_ID, pass: report.pass, outPath, report };
}
