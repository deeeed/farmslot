import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const runId = process.env.FARMSLOT_HEADLESS_PROOF_RUN_ID;
const decisionId = process.env.FARMSLOT_HEADLESS_PROOF_DECISION_ID;
const sessionId = process.env.FARMSLOT_HEADLESS_PROOF_SESSION_ID;
const gatewayLog = process.env.FARMSLOT_HEADLESS_PROOF_GATEWAY_LOG;
assert.ok(
  runId && decisionId && sessionId && gatewayLog,
  'Set run, decision, session and gateway log',
);

function rpc(method, params) {
  return JSON.parse(
    execFileSync(
      process.execPath,
      [
        path.join(root, 'apps/command-center/scripts/cdp.mjs'),
        'gateway',
        method,
        JSON.stringify(params),
      ],
      { cwd: root, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 },
    ),
  );
}

const { run } = rpc('run.get', { runId });
const decision = run.decisions.find((entry) => entry.id === decisionId);
assert.equal(decision?.type, 'monitor_runner_waiting');
assert.equal(decision.resolvedAction, 'continue');
assert.ok(decision.resolvedAt);
assert.equal(run.status, 'monitoring');
assert.equal(run.transport, 'tmux');
assert.equal(run.metrics.runnerSessionId, sessionId, 'Recovery must preserve the live session');
assert.equal(
  run.decisions.some((entry) => !entry.resolvedAt),
  false,
);

const launch = run.steps.find((step) => step.name === 'dispatch').outputs.launchCommand;
assert.match(launch, /mkdir -p/);
assert.equal(/(^|\s)--print(\s|$)|(^|\s)-p(\s|$)/.test(launch), true);
const context = run.agentContexts.find((entry) => entry.runnerSessionId === sessionId);
assert.ok(context?.target?.paneId);
const prefix = '[run-monitor] [observability] degraded — ';
const records = readFileSync(gatewayLog, 'utf8')
  .split('\n')
  .filter((line) => line.includes(prefix))
  .map((line) => JSON.parse(line.slice(line.indexOf(prefix) + prefix.length)));
const attemptedSend = records.find(
  (entry) =>
    entry.record === 'observability-degraded-recovery' &&
    entry.slotId === run.slotId &&
    entry.target === context.target.paneId &&
    entry.timestamp > Date.parse(decision.resolvedAt),
);
assert.ok(attemptedSend, 'The production monitor must pass the launch guard and enter send safety');
assert.equal(attemptedSend.action, 'hold-send');
const { summary } = rpc('intelligence.actions.summary', {
  dateFrom: decision.resolvedAt,
  limit: 1000,
});
const audited = summary.records.find(
  (entry) =>
    entry.runId === runId &&
    Date.parse(entry.decidedAt) === attemptedSend.timestamp &&
    entry.actor === 'auto-nudge',
);
assert.ok(audited, 'The send-safety event must also exist in the gateway audit');
assert.equal(audited.verdict.patternId, 'composer-draft-hold');
console.log(
  JSON.stringify({
    runId,
    slotId: run.slotId,
    decisionId,
    sessionId,
    status: run.status,
    oldWholeCommandMatcher: 'headless',
    monitorPassedLaunchGuard: true,
    delivery: attemptedSend.action,
    auditId: audited.id,
  }),
);
