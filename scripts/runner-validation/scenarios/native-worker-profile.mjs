import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {
  isTerminalRunStatus,
  Methods,
  NATIVE_WORKER_RESUME_ACTION,
  NativeSessionEventTypes,
} from '@farmslot/protocol';

import { ROOT } from '../lib/common.mjs';
import { writeEvidence } from '../lib/evidence.mjs';
import { writeNativeFixtureTask } from '../lib/native-task.mjs';

import { verifyRemoteWorkerHandoff } from './native-remote-worker-handoff.mjs';
import { rpc, wait } from './native-worker-lifecycle.mjs';
import { pinnedWorkerTarget } from './native-worker-read.mjs';

export const SCENARIO_ID = 'native-worker-profile';

/** Named configuration through actual task dispatch, stopped-worker recovery and native memory. */
export async function runScenario({
  runnerAdapter,
  slotId,
  model,
  outDir,
  timeoutMs = 180000,
  expectResume = true,
  cancelAtMonitor = false,
  reviewAfterHandoff = false,
}) {
  const report = { runner: runnerAdapter.RUNNER_ID, checks: [], pass: false };
  let runId;
  let contextId;
  let leaseId;
  const target = () => pinnedWorkerTarget(runId, contextId, leaseId);
  const read = () => rpc(Methods.NATIVE_SESSION_READ, target());
  try {
    assert.equal(process.env.FARMSLOT_GATEWAY, 'ws://127.0.0.1:18777');
    const profileId = process.env.FARMSLOT_NATIVE_WORKER_PROFILE;
    assert.ok(profileId && slotId);
    const profile = rpc(Methods.NATIVE_PROFILE_STATUS, { profileId });
    assert.equal(profile.account.login, 'authenticated');
    assert.equal(profile.profile.runner, report.runner);
    const nativeProfile = {
      executionNodeId: 'local',
      runner: report.runner,
      profileId,
      accountContextId: profile.profile.accountContextId,
    };
    rpc(Methods.FLEET_REFRESH);
    const slot = rpc(Methods.FLEET_STATUS).fleet.slots.find((slot) => slot.slot === slotId);
    assert.ok(slot && slot.lifecycle === 'ready' && !slot.currentRunId);
    const cwd = fs.realpathSync(slot.repo);
    assert.ok(
      cwd.startsWith(fs.realpathSync(path.join(ROOT, 'temp/native-validation')) + path.sep),
    );
    const stopDuringWork = cancelAtMonitor || !expectResume;
    const nonce = randomUUID();
    const marker = `profile-worker-${nonce}.txt`;
    const token = `WORKER_PROFILE_${randomUUID().replaceAll('-', '')}`;
    const taskFile = path.join(
      ROOT,
      'projects',
      slot.project,
      'tasks/dev',
      `PROFILE-${nonce}`,
      'TASK.md',
    );
    fs.mkdirSync(path.dirname(taskFile), { recursive: true });
    await writeNativeFixtureTask(
      taskFile,
      '# Worker: dev\n\n- Task profile: dev\n\n## Checklist\n\n' +
        `- [ ] Write ${marker} containing exactly ${nonce}.\n` +
        (stopDuringWork
          ? '- [ ] After writing the marker, run sleep 30, then check both boxes in CHECKLIST.md.\n\n'
          : '- [ ] Check both boxes in CHECKLIST.md.\n\n') +
        `Remember ${token} for this conversation. ` +
        (stopDuringWork
          ? 'The sleep is the controlled in-flight operation for this lifecycle fixture. Complete the task only after it finishes. '
          : 'End the turn without a terminal signal. ') +
        'Do not commit, contact services or modify other files.\n',
      slot.project,
    );
    const params = {
      flowType: 'dev',
      project: slot.project,
      ticketOrPr: `PROFILE-${nonce}`,
      slotId,
      allowedSlots: [slotId],
      taskFile,
      runner: report.runner,
      model,
      mode: 'interactive',
      skipPrepare: true,
      safetyTier: 'full-auto',
      nativeProfile,
    };
    assert.throws(
      () => rpc(Methods.RUN_CREATE, { ...params, transport: 'tmux' }),
      /requires native worker transport/,
    );
    runId = rpc(Methods.RUN_CREATE_NATIVE, params).run.id;
    report.runId = runId;
    writeEvidence(report, SCENARIO_ID, report.runner, outDir);
    const run = await wait(
      () => rpc(Methods.RUN_GET, { runId }).run,
      (run) => {
        assert.ok(!['failed', 'cancelled', 'blocked'].includes(run.status), run.error);
        return (
          run.status === 'monitoring' &&
          run.agentContexts?.some((context) => context.nativeSession?.acceptedAt)
        );
      },
      timeoutMs,
    );
    assert.deepEqual(run.nativeProfile, nativeProfile);
    const context = run.agentContexts.find((context) => context.nativeSession?.acceptedAt);
    const binding = context.nativeSession;
    contextId = context.id;
    leaseId = binding.leaseId;
    report.sessionId = binding.sessionId;
    assert.deepEqual(binding.profile, nativeProfile);
    const completed = await wait(
      read,
      (page) =>
        (stopDuringWork
          ? page.session.state === 'running' && fs.existsSync(path.join(cwd, marker))
          : page.session.state === 'idle') &&
        page.commands.some(
          (command) =>
            command.commandId === binding.commandId &&
            command.accepted &&
            (stopDuringWork || command.outcome === 'completed'),
        ),
      timeoutMs,
    );
    assert.equal(completed.session.profileId, profileId);
    assert.equal(completed.session.accountContextId, nativeProfile.accountContextId);
    assert.equal(fs.readFileSync(path.join(cwd, marker), 'utf8').trim(), nonce);
    report.checks.push(
      'Selected native configuration persisted on the run and worker; real task accepted and file written',
    );

    if (cancelAtMonitor) {
      const proofPath = process.env.FARMSLOT_NATIVE_MONITOR_CANCEL_PROOF;
      assert.ok(
        proofPath &&
          path.resolve(proofPath).startsWith(path.join(ROOT, 'temp/native-validation') + path.sep),
      );
      assert.equal(fs.existsSync(proofPath), false, 'Use a fresh monitor cancellation fixture');
      const gatewayPid = Number(process.env.FARMSLOT_NATIVE_MONITOR_GATEWAY_PID);
      assert.ok(Number.isSafeInteger(gatewayPid) && gatewayPid > 1);
      fs.writeFileSync(proofPath, JSON.stringify({ runId, gatewayPid }), { mode: 0o600 });
      rpc(Methods.NATIVE_SESSION_CLOSE, target());
      assert.equal(read().session.processStopped, true);
      await wait(() => fs.existsSync(`${proofPath}.held`), Boolean, timeoutMs);
      const held = JSON.parse(fs.readFileSync(`${proofPath}.held`, 'utf8'));
      assert.equal(held.runId, runId);
      assert.equal(held.gatewayPid, gatewayPid);
      assert.equal(held.sessionId, binding.sessionId);
      const cancelled = rpc(Methods.RUN_CANCEL, {
        runId,
        reason: 'Private cancellation during monitor status read',
      });
      assert.ok(cancelled.effects.every((effect) => effect.status !== 'failed'));
      fs.writeFileSync(`${proofPath}.release`, 'release\n');
      await wait(() => fs.existsSync(`${proofPath}.settled`), Boolean, timeoutMs);
      assert.equal(
        JSON.parse(fs.readFileSync(`${proofPath}.settled`, 'utf8')).outcome,
        'aborted',
        'A stale monitor reached decision publication',
      );
      const current = rpc(Methods.RUN_GET, { runId }).run;
      assert.equal(current.status, 'cancelled', 'A stale monitor revived the cancelled run');
      assert.equal(
        current.decisions.some((decision) => !decision.resolvedAt),
        false,
        'A stale monitor published a decision after cancellation',
      );
      assert.equal(read().session.processStopped, true);
      report.checks.push(
        'Cancellation during the actual monitor capability read remains terminal, without a new decision or process',
      );
    } else if (!reviewAfterHandoff) {
      rpc(Methods.NATIVE_SESSION_CLOSE, target());
      assert.equal(read().session.processStopped, true);
      const blocked = await wait(
        () => rpc(Methods.RUN_GET, { runId }).run,
        (run) => run.status === 'blocked',
        timeoutMs,
      );
      const decision = blocked.decisions.find(
        (decision) =>
          !decision.resolvedAt &&
          decision.actions.some((action) => action.id === NATIVE_WORKER_RESUME_ACTION),
      );
      assert.equal(
        completed.session.capabilities.resume,
        expectResume,
        'Unexpected runner resume capability',
      );
      if (!expectResume) {
        assert.equal(decision, undefined, 'Unsupported runner was offered saved-session resume');
        assert.ok(
          blocked.decisions.some(
            (item) =>
              !item.resolvedAt &&
              item.description.includes(completed.session.capabilities.resumeUnavailableReason),
          ),
        );
        report.checks.push(
          'Stopped unsupported runner exposes its capability reason without a resume action',
        );
      } else {
        assert.ok(decision);
        assert.equal(
          rpc(Methods.NATIVE_PROFILE_STATUS, { profileId }).profile.accountContextId,
          nativeProfile.accountContextId,
          'Login status refresh replaced the configuration registration',
        );
        rpc(Methods.RUN_RESOLVE_DECISION, {
          runId,
          decisionId: decision.id,
          actionId: NATIVE_WORKER_RESUME_ACTION,
        });
        const resumed = await wait(
          read,
          (page) =>
            page.session.generation !== binding.generation &&
            page.session.state === 'idle' &&
            page.commands.some(
              (command) =>
                command.commandId !== binding.commandId &&
                command.accepted &&
                command.outcome === 'completed',
            ),
          timeoutMs,
        );
        assert.equal(resumed.session.nativeSessionId, completed.session.nativeSessionId);
        assert.equal(resumed.session.profileId, profileId);
        assert.equal(resumed.session.accountContextId, nativeProfile.accountContextId);
        assert.equal(
          resumed.commands.filter((command) => command.commandId === binding.commandId).length,
          1,
        );
        const commandId = randomUUID();
        rpc(Methods.NATIVE_SESSION_SEND, {
          ...target(),
          commandId,
          text: 'Reply with only the WORKER_PROFILE token you remembered earlier. Use no tools and write no terminal signal.',
        });
        const remembered = await wait(
          read,
          (page) =>
            page.session.state === 'idle' &&
            page.commands.some(
              (command) =>
                command.commandId === commandId &&
                command.accepted &&
                command.outcome === 'completed',
            ),
          timeoutMs,
        );
        const events = remembered.events.filter((event) => event.commandId === commandId);
        assert.ok(
          events
            .filter((event) => event.type === NativeSessionEventTypes.TEXT_DELTA)
            .map((event) => event.text ?? '')
            .join('')
            .includes(token),
        );
        assert.equal(
          events.some((event) => event.type === NativeSessionEventTypes.TOOL_STARTED),
          false,
        );
        report.checks.push(
          'Stopped worker resumes the same native conversation and profile; accepted task is not replayed; remembered token survives',
        );
      }
    }
    if (reviewAfterHandoff) {
      const parent = rpc(Methods.RUN_GET, { runId }).run;
      const primary = parent.agentContexts.find((item) => item.id === contextId);
      const successor = await verifyRemoteWorkerHandoff({
        runId,
        context: primary,
        binding: primary.nativeSession,
        slot,
        token,
        timeoutMs,
        recordChild(id) {
          report.parentRunId = runId;
          runId = id;
          report.runId = id;
          contextId = undefined;
          writeEvidence(report, SCENARIO_ID, report.runner, outDir);
        },
      });
      contextId = successor.contextId;
      leaseId = successor.leaseId;
      const child = rpc(Methods.RUN_GET, { runId }).run;
      assert.equal(child.nativeProfile, undefined, 'Handoff must omit a new profile selection');
      assert.deepEqual(
        child.agentContexts.find((item) => item.id === contextId).nativeSession.profile,
        nativeProfile,
      );
      rpc(Methods.RUN_INTERACTIVE_DEV_RESOLVE, { runId, action: 'run-self-review' });
      const reviewed = await wait(
        () => rpc(Methods.RUN_GET, { runId }).run,
        (current) => {
          const step = current.steps.find((item) => item.name === 'self-review');
          assert.notEqual(
            step?.status,
            'failed',
            current.error ?? step?.detail ?? 'Reviewer failed',
          );
          for (const item of current.agentContexts.filter(
            (item) => item.role === 'self-review' && item.nativeSession,
          ))
            assert.deepEqual(
              item.nativeSession.profile,
              nativeProfile,
              'Fresh reviewer lost the inherited native profile',
            );
          return step?.status === 'done' && step.outputs?.verdict === 'pass';
        },
        timeoutMs,
      );
      const reviewer = reviewed.agentContexts.find(
        (item) => item.role === 'self-review' && item.nativeSession,
      );
      assert.ok(reviewer?.nativeSession.acceptedAt && reviewer.reviewResultValidatedAt);
      assert.notEqual(reviewer.nativeSession.sessionId, primary.nativeSession.sessionId);
      const page = rpc(
        Methods.NATIVE_SESSION_READ,
        pinnedWorkerTarget(runId, reviewer.id, reviewer.nativeSession.leaseId),
      );
      assert.equal(page.session.profileId, nativeProfile.profileId);
      assert.equal(page.session.accountContextId, nativeProfile.accountContextId);
      report.checks.push(
        'Retained child omits requested selection; fresh same-runner reviewer completes using its inherited configuration',
      );
    }
    report.pass = true;
  } catch (error) {
    report.error = error.message;
  } finally {
    if (runId) {
      try {
        const current = rpc(Methods.RUN_GET, { runId }).run;
        if (!isTerminalRunStatus(current.status)) {
          const cancelled = rpc(Methods.RUN_CANCEL, {
            runId,
            reason: 'Native worker profile validation complete',
          });
          assert.ok(cancelled.effects.every((effect) => effect.status !== 'failed'));
        } else if (
          current.agentContexts.some(
            (item) =>
              item.nativeSession && !item.nativeSession.closedAt && !item.nativeSession.releasedAt,
          )
        ) {
          const slot = rpc(Methods.FLEET_STATUS).fleet.slots.find((item) => item.slot === slotId);
          assert.ok(
            !slot.currentRunId || slot.currentRunId === runId,
            'Cleanup cannot release a successor slot',
          );
          rpc(Methods.SLOT_RELEASE, {
            slotId,
            keepWork: true,
            ...(slot.currentRunId ? { expectedRunId: runId } : {}),
          });
        }
        for (const item of rpc(Methods.RUN_GET, { runId }).run.agentContexts) {
          if (!item.nativeSession?.generation || item.nativeSession.releasedAt) continue;
          const page = rpc(
            Methods.NATIVE_SESSION_READ,
            pinnedWorkerTarget(runId, item.id, item.nativeSession.leaseId),
          );
          assert.equal(page.session.processStopped, true);
        }
      } catch (error) {
        report.pass = false;
        report.cleanupError = error.message;
      }
    }
  }
  const outPath = writeEvidence(report, SCENARIO_ID, report.runner, outDir);
  return { scenario: SCENARIO_ID, runner: report.runner, pass: report.pass, report, outPath };
}
