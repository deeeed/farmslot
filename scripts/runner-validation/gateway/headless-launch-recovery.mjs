import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const runId = process.env.FARMSLOT_HEADLESS_PROOF_RUN_ID;
const decisionId = process.env.FARMSLOT_HEADLESS_PROOF_DECISION_ID;
const sessionId = process.env.FARMSLOT_HEADLESS_PROOF_SESSION_ID;
const machine = process.env.FARMSLOT_HEADLESS_PROOF_MACHINE;
assert.ok(runId && decisionId && sessionId && machine, 'Set run, decision, session and machine');

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
const { candidates } = rpc('dispatch.candidates', {
  project: run.project,
  flowType: run.flowType,
  machines: [machine],
  ticketOrPr: run.ticketOrPr,
  targetBranch: run.branch,
});
const candidate = candidates.find((entry) => entry.slotId === run.slotId);
assert.equal(candidate?.nudgeEligible, true, 'Production launch policy must allow this worker');
assert.equal(candidate.nudgeMeta.canNudge, true);
console.log(
  JSON.stringify({
    runId,
    slotId: run.slotId,
    decisionId,
    sessionId,
    status: run.status,
    oldWholeCommandMatcher: 'headless',
    nudgeEligible: candidate.nudgeEligible,
    canNudge: candidate.nudgeMeta.canNudge,
  }),
);
