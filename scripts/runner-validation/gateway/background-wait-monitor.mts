// Manual proof against the scenario's own live worker. No dispatch, send or live farm mutation.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { contextIdFor, Events, isRecord, type WorkerSignal } from '@farmslot/protocol';

const [repo, target, phase] = process.argv.slice(2);
assert(repo && target && ['active', 'settled', 'operator-wait'].includes(phase));
const control = mkdtempSync(path.join(repo, '.monitor-proof-'));
process.env.FARMSLOT_HOME = path.join(control, 'home');
process.env.FARMSLOT_RUNS_DIR = path.join(control, 'runs');
process.env.FARMSLOT_POOL_DIR = path.join(control, 'pool');
process.env.FARMSLOT_PROJECTS_DIR = path.join(control, 'projects');
const project = 'background-monitor-proof';
const slotId = 'background-monitor-proof';
const contextId = contextIdFor('dev');
const projectDir = path.join(control, 'projects', project);
const task = path.join(projectDir, 'tasks/dev/proof/TASK.md');
const signalFile = path.join(control, 'SIGNAL.json');
const write = (file: string, value: string) => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, value);
};
write(
  path.join(projectDir, 'project.json'),
  JSON.stringify({
    name: project,
    monitoring: {
      poll_interval_min: 1 / 60000,
      stuck_timeout_min: 1,
      idle_timeout_min: 1,
      total_timeout_min: 1,
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
    slots: [{ id: slotId, enabled: true, repo, session: 'background-wait-proof' }],
  }),
);
write(task, '# Isolated monitor observation\n');
const { createRun, getRun, updateRun } =
  await import('../../../services/gateway/src/runs/store.js');
const { initRunMonitor, monitorRun, resolveMonitorDecision } =
  await import('../../../services/gateway/src/run-engine/run-monitor.js');
const { readRunProgress } = await import('../../../services/gateway/src/runners/run-progress.js');
const { deleteTestRunIfPresent } =
  await import('../../../services/gateway/src/run-engine/test-fixtures.js');
const run = createRun({
  project,
  flowType: 'dev',
  mode: 'autonomous',
  ticketOrPr: 'WAIT-1',
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
      target: { target, session: 'background-wait-proof', paneId: target },
      taskFile: task,
      signalFile,
      signalAttemptId: 'owned-attempt',
      startedAt,
      attemptStartedAt: startedAt,
    },
  ],
});
if (phase === 'operator-wait') {
  const signal: WorkerSignal = {
    status: 'running',
    timestamp: startedAt,
    role: 'dev',
    contextId,
    attemptId: 'owned-attempt',
    waitingForOperator: { who: 'fixture operator', reason: 'Approach review', since: startedAt },
  };
  write(signalFile, JSON.stringify(signal));
}
const controller = new AbortController();
let observedProgress: string | undefined;
let observedWait = false;
initRunMonitor((event, payload) => {
  if (
    event === Events.RUN_DECISION_NEW &&
    isRecord(payload) &&
    isRecord(payload.decision) &&
    typeof payload.decision.id === 'string'
  ) {
    const decisionId = payload.decision.id;
    setImmediate(() => resolveMonitorDecision(decisionId, 'abort'));
  }
  if (getRun(run.id)?.waitingForOperator) {
    observedWait = true;
    controller.abort();
  }
});
// This is a failure ceiling, not a wait used to pass the proof.
const deadline = setTimeout(() => {
  controller.abort();
  for (const decision of getRun(run.id)?.decisions ?? [])
    if (!decision.resolvedAt) resolveMonitorDecision(decision.id, 'abort');
}, 25000);
try {
  const result = await monitorRun(run.id, slotId, controller.signal, {
    // Keep the real liveness reader. Only outbound violation/nudge work is disabled.
    violations: async () => {
      observedProgress = (await readRunProgress(getRun(run.id)!)).kind;
      controller.abort();
      return [];
    },
  });
  const decisions = getRun(run.id)!.decisions.map((decision) => decision.type);
  assert.deepEqual(decisions, [], 'A live worker must not create a missing-signal handoff');
  if (phase === 'operator-wait')
    assert(observedWait, 'The real idle worker must retain its operator wait');
  else assert.equal(observedProgress, phase === 'active' ? 'making-progress' : 'idle');
  console.log(
    JSON.stringify({
      phase,
      decisions,
      observedProgress,
      observedWait,
      exitReason: result.exitReason,
      pass: true,
    }),
  );
} finally {
  clearTimeout(deadline);
  controller.abort();
  await deleteTestRunIfPresent(run.id);
  rmSync(control, { recursive: true, force: true });
}
