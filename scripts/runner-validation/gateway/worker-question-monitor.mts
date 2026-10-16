// Manual proof against the scenario's own live worker: the production monitor
// sees its open question, hands it off, and resumes once the scenario answers.
// No dispatch or live farm mutation; the only input is the answer to its own menu.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { contextIdFor, Events, isRecord, type RunDecision } from '@farmslot/protocol';

const [repo, target, question] = process.argv.slice(2);
assert(repo && target && question);
const control = mkdtempSync(path.join(repo, '.monitor-proof-'));
process.env.FARMSLOT_HOME = path.join(control, 'home');
process.env.FARMSLOT_RUNS_DIR = path.join(control, 'runs');
process.env.FARMSLOT_POOL_DIR = path.join(control, 'pool');
process.env.FARMSLOT_PROJECTS_DIR = path.join(control, 'projects');
const project = 'worker-question-proof';
const slotId = 'worker-question-proof';
const contextId = contextIdFor('dev');
const projectDir = path.join(control, 'projects', project);
const task = path.join(projectDir, 'tasks/dev/proof/TASK.md');
const write = (file: string, value: string) => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, value);
};
write(
  path.join(projectDir, 'project.json'),
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
const { createRun, getRun, updateRun } =
  await import('../../../services/gateway/src/runs/store.js');
const { initRunMonitor, monitorRun, resolveMonitorDecision } =
  await import('../../../services/gateway/src/run-engine/run-monitor.js');
const { paneOpenQuestion } =
  await import('../../../services/gateway/src/runners/pane-state-script.js');
const { deleteTestRunIfPresent } =
  await import('../../../services/gateway/src/run-engine/test-fixtures.js');
const run = createRun({
  project,
  flowType: 'dev',
  mode: 'autonomous',
  ticketOrPr: 'QUESTION-1',
  transport: 'tmux',
  runner: 'claude',
});
const startedAt = new Date().toISOString();
updateRun(run.id, {
  status: 'monitoring',
  slotId,
  taskFile: task,
  agentContexts: [
    {
      id: contextId,
      role: 'dev',
      label: 'Worker',
      runner: 'claude',
      status: 'working',
      runId: run.id,
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
const capture = () =>
  execFileSync('tmux', ['capture-pane', '-p', '-t', target], { encoding: 'utf8' });
const controller = new AbortController();
let handoff: RunDecision | undefined;
let statusWhileOpen: string | undefined;
let answerKeys = 0;
let statusAfterAnswer: string | undefined;
initRunMonitor((event, payload) => {
  const decision = isRecord(payload) && isRecord(payload.decision) ? payload.decision : undefined;
  if (event !== Events.RUN_DECISION_NEW || !decision || handoff) return;
  handoff = getRun(run.id)!.decisions.find((entry) => entry.id === decision.id);
  statusWhileOpen = getRun(run.id)?.status;
  // Answer the worker's own menu: Enter picks the highlighted first option.
  const answer = setInterval(() => {
    if (paneOpenQuestion(capture()) === null || answerKeys >= 4) return clearInterval(answer);
    execFileSync('tmux', ['send-keys', '-t', target, 'Enter']);
    answerKeys++;
  }, 1500);
});
// This is a failure ceiling, not a wait used to pass the proof.
const deadline = setTimeout(() => {
  controller.abort();
  for (const decision of getRun(run.id)?.decisions ?? [])
    if (!decision.resolvedAt) resolveMonitorDecision(decision.id, 'abort');
}, 90_000);
const settled = setInterval(() => {
  const current = handoff && getRun(run.id)?.decisions.find((entry) => entry.id === handoff!.id);
  if (current?.resolvedAt) {
    statusAfterAnswer = getRun(run.id)?.status;
    controller.abort();
  }
}, 250);
try {
  const result = await monitorRun(run.id, slotId, controller.signal);
  assert(handoff, 'The production monitor must hand off the open worker question');
  const resolved = getRun(run.id)!.decisions.find((entry) => entry.id === handoff!.id)!;
  assert.equal(resolved.type, 'monitor_interactive_handoff');
  assert.match(resolved.description, new RegExp(question.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.equal(resolved.context?.workerQuestion, true);
  // Run status stays truthful to the live turn (ADR-065); the pending decision is the signal.
  assert.equal(handoff.resolvedAt, undefined, 'The handoff is pending while the question is open');
  assert.equal(resolved.resolvedAction, 'question-closed');
  assert.equal(statusAfterAnswer, 'monitoring');
  console.log(
    JSON.stringify({
      decisionType: resolved.type,
      statusWhileOpen,
      resolvedAction: resolved.resolvedAction,
      statusAfterAnswer,
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
  await deleteTestRunIfPresent(run.id);
  rmSync(control, { recursive: true, force: true });
}
