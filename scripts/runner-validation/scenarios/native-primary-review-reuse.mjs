import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { ROOT } from '../lib/common.mjs';
import { writeEvidence } from '../lib/evidence.mjs';
import { writeNativeFixtureTask } from '../lib/native-task.mjs';

import { assertWorkerHistoryTransfer, readPinnedWorkerHistory } from './native-worker-history.mjs';
import { rpc, wait } from './native-worker-lifecycle.mjs';
import { pinnedWorkerTarget } from './native-worker-read.mjs';

export const SCENARIO_ID = 'native-primary-review-reuse';

// The public PR supplies a real immutable review identity. The private task explicitly
// reviews only the fixture, and artifact-only policy prevents publication or PR mutation.
export async function runScenario({ runnerAdapter, slotId, model, timeoutMs, outDir, explicit }) {
  const report = { runner: runnerAdapter.RUNNER_ID, checks: [], pass: false, error: null };
  if (!slotId && !explicit) {
    report.skipped = true;
    report.skipReason = 'Requires the isolated native-worker fixture';
    return {
      scenario: SCENARIO_ID,
      runner: report.runner,
      pass: true,
      skipped: true,
      outPath: writeEvidence(report, SCENARIO_ID, report.runner, outDir),
      report,
    };
  }
  const runs = [];
  let template;
  let originalBranch;
  let fixtureCwd;
  try {
    assert.equal(process.env.FARMSLOT_GATEWAY, 'ws://127.0.0.1:18777');
    const slot = rpc('fleet.status').fleet.slots.find((slot) => slot.slot === slotId);
    assert.ok(slot?.project.startsWith('native-worker-'));
    assert.equal(slot.currentRunId, null);
    const cwd = fs.realpathSync(slot.repo);
    assert.ok(cwd.startsWith(path.join(ROOT, 'temp/native-validation') + path.sep));
    if (slot.lifecycle === 'held') rpc('slot.release', { slotId, keepWork: true });
    const variant = `native-review-${randomUUID().slice(0, 8)}`;
    const branch = `review/620-${variant}`;
    originalBranch = execFileSync('git', ['branch', '--show-current'], {
      cwd,
      encoding: 'utf8',
    }).trim();
    assert.ok(originalBranch);
    fixtureCwd = cwd;
    execFileSync('git', ['switch', '-c', branch], { cwd, stdio: 'pipe' });
    const token = randomUUID();
    const firstMarker = `native-first-review-${randomUUID()}.txt`;
    const secondMarker = `native-repeat-review-${randomUUID()}.txt`;
    const taskDir = path.join(
      ROOT,
      'projects',
      slot.project,
      'tasks/review-pr',
      `NATIVE-REVIEW-${Date.now()}`,
    );
    fs.mkdirSync(taskDir, { recursive: true });
    const taskFile = path.join(taskDir, 'TASK.md');
    const reports =
      'In this task directory, write artifacts/review.md with Recommendation: COMMENT and explain that this is a transport continuity fixture, not a review of the PR code. Write artifacts/line-comments.json as {"recommendation":"COMMENT","comments":[]} and artifacts/learnings.md describing the isolated transport check. Mark both checklist steps with this task\'s mark helper, then run mark complete --mark-last. Do not publish, commit, contact services, or modify other files.\n';
    await writeNativeFixtureTask(
      taskFile,
      '# Worker: review-pr\n\n- Task profile: review-pr\n\n## Checklist\n\n' +
        `- [ ] Read fixture.txt and write ${firstMarker} containing exactly ${token}.\n` +
        '- [ ] Write the local transport-check review artifacts and complete this task.\n\n' +
        reports,
      slot.project,
    );
    const templatePath = path.join(
      ROOT,
      'temp/native-validation/projects',
      slot.project,
      'templates/worker/review-pr.md',
    );
    template = {
      path: templatePath,
      content: fs.existsSync(templatePath) ? fs.readFileSync(templatePath, 'utf8') : null,
    };
    fs.mkdirSync(path.dirname(templatePath), { recursive: true });
    fs.writeFileSync(
      templatePath,
      '# Worker: review-pr\n\n## Checklist\n\n' +
        `- [ ] Write ${secondMarker} with the exact token from the first task, using conversation memory. Do not read previous task files, markers or transcripts.\n` +
        '- [ ] Write the local transport-check review artifacts and complete this task.\n\n' +
        reports,
    );
    const base = {
      flowType: 'review-pr',
      project: slot.project,
      ticketOrPr: 'deeeed/farmslot#620',
      slotId,
      allowedSlots: [slotId],
      runner: report.runner,
      ...(model ? { model } : {}),
      mode: 'interactive',
      skipPrepare: true,
      safetyTier: 'full-auto',
      completionPolicy: 'artifact-only',
      lane: 'comparison',
      variant,
      branch,
    };
    const first = rpc('run.createNative', { ...base, taskFile }).run;
    runs.push(first.id);
    report.firstRunId = first.id;
    writeEvidence(report, SCENARIO_ID, report.runner, outDir);
    const done = await wait(
      () => rpc('run.get', { runId: first.id }).run,
      (run) => {
        assert.ok(
          !['failed', 'blocked', 'cancelled'].includes(run.status),
          `First review ${run.status}: ${run.error}`,
        );
        return run.status === 'done';
      },
      timeoutMs,
    );
    assert.ok(done.reviewResult?.reviewSnapshot?.headSha);
    assert.equal(done.reviewResult.recommendation, 'COMMENT');
    assert.equal(fs.readFileSync(path.join(cwd, firstMarker), 'utf8').trim(), token);
    const reviewer = done.agentContexts.find((context) => context.role === 'review');
    assert.ok(reviewer?.nativeSession && reviewer.runnerSessionId);
    const sourceTarget = pinnedWorkerTarget(first.id, reviewer.id, reviewer.nativeSession.leaseId);
    if (!rpc('native.session.read', sourceTarget).session.processStopped)
      rpc('slot.release', { slotId, keepWork: true });
    const stopped = readPinnedWorkerHistory(first.id, reviewer.id, reviewer.nativeSession.leaseId);
    assert.equal(stopped.session.processStopped, true);
    report.checks.push(
      'first native primary review completed through real signal and locally collected review artifacts',
    );
    const second = rpc('run.createNative', {
      ...base,
      parentRunId: first.id,
      familyId: done.familyId,
      taskTemplate: { fileName: 'review-pr.md' },
    }).run;
    runs.push(second.id);
    report.runId = second.id;
    writeEvidence(report, SCENARIO_ID, report.runner, outDir);
    const choosing = await wait(
      () => rpc('run.get', { runId: second.id }).run,
      (run) => {
        assert.ok(
          !['failed', 'cancelled'].includes(run.status),
          `Repeat review ${run.status}: ${run.error}`,
        );
        return run.decisions.some(
          (decision) => !decision.resolvedAt && decision.type === 'engine_review_continuation',
        );
      },
      timeoutMs,
    );
    const decision = choosing.decisions.find(
      (decision) => !decision.resolvedAt && decision.type === 'engine_review_continuation',
    );
    rpc('run.resolveDecision', {
      runId: second.id,
      decisionId: decision.id,
      actionId: 'reuse-incremental-static',
    });
    const repeated = await wait(
      () => rpc('run.get', { runId: second.id }).run,
      (run) => {
        assert.ok(
          !['failed', 'cancelled', 'blocked'].includes(run.status),
          `Repeat review ${run.status}: ${run.error}`,
        );
        return run.status === 'done';
      },
      timeoutMs,
    );
    assert.equal(repeated.repeatReviewContext.priorRunId, first.id);
    assert.equal(repeated.repeatReviewContext.session.intent, 'resume');
    assert.equal(repeated.repeatReviewContext.session.continuity, 'resumed');
    assert.equal(repeated.repeatReviewContext.session.sessionId, reviewer.runnerSessionId);
    const next = repeated.agentContexts.find((context) => context.role === 'review');
    assert.equal(next.nativeSession.sessionId, reviewer.nativeSession.sessionId);
    assert.notEqual(next.nativeSession.leaseId, reviewer.nativeSession.leaseId);
    assert.notEqual(next.nativeSession.generation, reviewer.nativeSession.generation);
    const source = readPinnedWorkerHistory(first.id, reviewer.id, reviewer.nativeSession.leaseId);
    const after = readPinnedWorkerHistory(second.id, next.id, next.nativeSession.leaseId);
    assertWorkerHistoryTransfer(stopped, source, after);
    assert.deepEqual(source.events, stopped.events);
    assert.deepEqual(source.commands, stopped.commands);
    assert.deepEqual(source.session, stopped.session);
    assert.equal(source.scope.endAt, stopped.scope.endAt);
    assert.equal(after.session.nativeSessionId, stopped.session.nativeSessionId);
    assert.equal(
      after.commands.length,
      1,
      'Repeat review submits exactly one command in its own lease',
    );
    assert.equal(after.commands[0].commandId, next.nativeSession.commandId);
    assert.equal(fs.readFileSync(path.join(cwd, secondMarker), 'utf8').trim(), token);
    assert.equal(repeated.reviewResult.recommendation, 'COMMENT');
    assert.equal(after.session.processStopped, true);
    assert.equal(
      rpc('fleet.status').fleet.slots.find((slot) => slot.slot === slotId).currentRunId,
      null,
    );
    report.checks.push(
      'real repeat-review selection resumes the stopped conversation under a new lease, records continuity and completes without publishing',
    );
    report.pass = true;
  } catch (error) {
    report.error = error.message;
  } finally {
    for (const runId of runs.reverse()) {
      try {
        const run = rpc('run.get', { runId }).run;
        if (!['done', 'failed', 'cancelled'].includes(run.status)) {
          const result = rpc('run.cancel', {
            runId,
            reason: 'Native primary-review fixture cleanup',
          });
          assert.ok(result.effects.every((effect) => effect.status !== 'failed'));
        } else if (run.status === 'failed') {
          const slot = rpc('fleet.status').fleet.slots.find((slot) => slot.slot === slotId);
          assert.ok(!slot.currentRunId || slot.currentRunId === runId);
          rpc('slot.release', { slotId, keepWork: true });
        }
      } catch (error) {
        report.pass = false;
        report.error = [report.error, `cleanup: ${error.message}`].filter(Boolean).join('; ');
      }
    }
    if (template) {
      if (template.content === null) fs.rmSync(template.path);
      else fs.writeFileSync(template.path, template.content);
    }
    if (fixtureCwd && originalBranch) {
      try {
        execFileSync('git', ['switch', originalBranch], { cwd: fixtureCwd, stdio: 'pipe' });
      } catch (error) {
        report.pass = false;
        report.error = [report.error, `branch cleanup: ${error.message}`]
          .filter(Boolean)
          .join('; ');
      }
    }
  }
  const outPath = writeEvidence(report, SCENARIO_ID, report.runner, outDir);
  return { scenario: SCENARIO_ID, runner: report.runner, pass: report.pass, outPath, report };
}
