// Manual proof against the scenario's own live worker: the production monitor
// sees its open question, hands it off, and resumes once the scenario answers.
// Phase `raise` exits while the handoff is pending, like a gateway restart, and
// phase `recover` resumes the persisted run in a new process.
// No dispatch or live farm mutation; the only input is the answer to its own menu.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { contextIdFor, Events, isRecord, type RunDecision } from '@farmslot/protocol';

const [repo, target, question, phase, control, recoverRunId] = process.argv.slice(2);
assert(repo && target && question && control && ['single', 'raise', 'recover'].includes(phase));
process.env.FARMSLOT_HOME = path.join(control, 'home');
process.env.FARMSLOT_RUNS_DIR = path.join(control, 'runs');
process.env.FARMSLOT_POOL_DIR = path.join(control, 'pool');
process.env.FARMSLOT_PROJECTS_DIR = path.join(control, 'projects');
const project = 'worker-question-proof';
const slotId = 'worker-question-proof';
const write = (file: string, value: string) => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, value);
};
const task = path.join(control, 'projects', project, 'tasks/dev/proof/TASK.md');
if (phase !== 'recover') {
  write(
    path.join(control, 'projects', project, 'project.json'),
    JSON.stringify({
      name: project,
      monitoring: {
        poll_interval_min: 2 / 60,
        stuck_timeout_min: 10,
        idle_timeout_min: 10,
        total_timeout_min: 10,
        max_nudges: 0,
      },
    }),
  );
  write(
    path.join(control, 'pool/proof.json'),
    JSON.stringify({
      machine: os.hostname(),
      project,
      host: 'localhost',
      ssh_user: os.userInfo().username,
      platform: 'cli',
      os: process.platform,
      slots: [{ id: slotId, enabled: true, repo, session: 'worker-question-proof' }],
    }),
  );
  write(task, '# Isolated monitor observation\n');
}
const { createRun, getRun, loadAllRuns, persistRunNow, updateRun } =
  await import('../../../services/gateway/src/runs/store.js');
const { initRunMonitor, monitorRun, resolveMonitorDecision } =
  await import('../../../services/gateway/src/run-engine/run-monitor.js');
const { paneOpenQuestion } =
  await import('../../../services/gateway/src/runners/pane-state-script.js');
const { deleteTestRunIfPresent } =
  await import('../../../services/gateway/src/run-engine/test-fixtures.js');

const handoffs = (runId: string) =>
  getRun(runId)!.decisions.filter((entry) => entry.type === 'monitor_interactive_handoff');
const capture = () =>
  execFileSync('tmux', ['capture-pane', '-p', '-t', target], { encoding: 'utf8' });
// Answer the worker's own menu: Enter picks the highlighted first option.
let answerKeys = 0;
const answer = () => {
  const keys = setInterval(() => {
    if (paneOpenQuestion(capture()) === null || answerKeys >= 4) return clearInterval(keys);
    execFileSync('tmux', ['send-keys', '-t', target, 'Enter']);
    answerKeys++;
  }, 1500);
};

let runId: string;
if (phase === 'recover') {
  await loadAllRuns();
  runId = recoverRunId!;
  const [pending] = handoffs(runId);
  assert(
    pending && !pending.resolvedAt,
    'The restarted gateway finds the pending question handoff',
  );
} else {
  const run = createRun({
    project,
    flowType: 'dev',
    mode: 'autonomous',
    ticketOrPr: 'QUESTION-1',
    transport: 'tmux',
    runner: 'claude',
  });
  runId = run.id;
  const startedAt = new Date().toISOString();
  updateRun(runId, {
    status: 'monitoring',
    slotId,
    taskFile: task,
    agentContexts: [
      {
        id: contextIdFor('dev'),
        role: 'dev',
        label: 'Worker',
        runner: 'claude',
        status: 'working',
        runId,
        slotId,
        target: { target, session: 'worker-question-proof', paneId: target },
        taskFile: task,
        signalFile: path.join(control, 'SIGNAL.json'),
        signalAttemptId: 'owned-attempt',
        startedAt,
        attemptStartedAt: startedAt,
      },
    ],
  });
}

const controller = new AbortController();
let handoff: RunDecision | undefined = phase === 'recover' ? handoffs(runId)[0] : undefined;
let statusWhileOpen = phase === 'recover' ? getRun(runId)?.status : undefined;
let statusAfterAnswer: string | undefined;
initRunMonitor((event, payload) => {
  const decision = isRecord(payload) && isRecord(payload.decision) ? payload.decision : undefined;
  if (event !== Events.RUN_DECISION_NEW || !decision || handoff) return;
  handoff = getRun(runId)!.decisions.find((entry) => entry.id === decision.id);
  statusWhileOpen = getRun(runId)?.status;
  if (phase === 'raise') {
    // Stop like a gateway process would: the pending handoff is all that survives.
    void persistRunNow(getRun(runId)!, 'question handoff proof').then(() => {
      console.log(JSON.stringify({ phase, runId, decisionId: handoff!.id, statusWhileOpen }));
      process.exit(0);
    });
    return;
  }
  answer();
});
if (phase === 'recover')
  // The recovered monitor must hold the handoff while the question is still open.
  setTimeout(() => {
    if (handoffs(runId)[0].resolvedAt) statusWhileOpen = 'resolved-early';
    answer();
  }, 6000);
// This is a failure ceiling, not a wait used to pass the proof.
const deadline = setTimeout(() => {
  controller.abort();
  for (const decision of getRun(runId)?.decisions ?? [])
    if (!decision.resolvedAt) resolveMonitorDecision(decision.id, 'abort');
}, 90_000);
const settled = setInterval(() => {
  const current = handoff && getRun(runId)?.decisions.find((entry) => entry.id === handoff!.id);
  if (current?.resolvedAt) {
    statusAfterAnswer = getRun(runId)?.status;
    controller.abort();
  }
}, 250);
try {
  const result = await monitorRun(runId, slotId, controller.signal);
  assert(handoff, 'The production monitor must hand off the open worker question');
  const resolved = getRun(runId)!.decisions.find((entry) => entry.id === handoff!.id)!;
  assert.equal(resolved.type, 'monitor_interactive_handoff');
  assert.match(resolved.description, new RegExp(question.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.equal(resolved.context?.workerQuestion, true);
  // Run status stays truthful to the live turn (ADR-065); the pending decision is the signal.
  assert.notEqual(
    statusWhileOpen,
    'resolved-early',
    'The handoff holds while the question is open',
  );
  assert.equal(resolved.resolvedAction, 'question-closed');
  assert.equal(statusAfterAnswer, 'monitoring');
  assert.equal(handoffs(runId).length, 1, 'One handoff, adopted across a restart');
  console.log(
    JSON.stringify({
      phase,
      decisionType: resolved.type,
      decisionId: resolved.id,
      statusWhileOpen,
      resolvedAction: resolved.resolvedAction,
      statusAfterAnswer,
      handoffs: handoffs(runId).length,
      answerKeys,
      description: resolved.description,
      exitReason: result.exitReason,
      pass: true,
    }),
  );
} finally {
  clearTimeout(deadline);
  clearInterval(settled);
  controller.abort();
  await deleteTestRunIfPresent(runId);
  rmSync(control, { recursive: true, force: true });
}
