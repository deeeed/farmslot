#!/usr/bin/env tsx
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import type { SlotVars } from '@farmslot/slot-config';

const repo = process.env.FARMSLOT_VALIDATION_REPO;
const target = process.env.FARMSLOT_VALIDATION_TARGET;
const runner = process.env.FARMSLOT_VALIDATION_RUNNER;
const runnerBin = process.env.FARMSLOT_VALIDATION_RUNNER_BIN;
const resultPath = process.env.FARMSLOT_VALIDATION_RESULT_PATH;
assert.ok(repo && target && runner && runnerBin && resultPath, 'validation inputs are required');

process.env.NODE_TEST_CONTEXT = '1';
process.env.FARMSLOT_DISABLE_RUN_ENGINE_START = '1';

const [
  { waitForWorkerSignal },
  { deliverPromptWithRetainedFallback },
  { readLaunchAckSignalSnapshot },
  { readRunnerTurnState },
  { paneHostsRunnerProcess, runnerTurnLeaseIsActive },
] = await Promise.all([
  import('../../../services/gateway/src/self-review/orchestrator.js'),
  import('../../../services/gateway/src/runners/session-reactivation.js'),
  import('../../../services/gateway/src/runners/prompt-delivery-evidence.js'),
  import('../../../services/gateway/src/runners/registry.js'),
  import('../../../services/gateway/src/self-review/worker-lifecycle.js'),
]);

const vars: SlotVars = {
  slotId: 'runner-validation-self-review-fix-turn-lease',
  machine: os.hostname(),
  platform: 'macos',
  host: 'localhost',
  sshUser: process.env.USER ?? '',
  osType: 'macos',
  claudePath: runner === 'claude' ? runnerBin : '',
  codexPath: runner === 'codex' ? runnerBin : '',
  opencodePath: '',
  cursorPath: '',
  grokPath: runner === 'grok' ? runnerBin : '',
  dispatchCmd: '',
  recycleCmd: '',
  repo,
  session: target.split(':')[0],
  slotMode: 'branch',
  slotEnabled: true,
  sshTarget: '',
  remoteRepo: repo,
  projectName: 'missing-runner-validation-project',
  resourceVars: {},
};
const idleTimeoutMs = 10_000;
const turnReadings: Array<{
  expectedTurnToken: string;
  active: boolean;
  stateValue: string | null;
  actualTurnToken: string | null;
  runnerAlive: boolean;
}> = [];

const turnActive = (expectedTurnToken: string) => async () => {
  const state = await readRunnerTurnState(vars, target, runner);
  const runnerAlive = await paneHostsRunnerProcess(vars, target, runner);
  const active = await runnerTurnLeaseIsActive(vars, target, runner, expectedTurnToken);
  turnReadings.push({
    expectedTurnToken,
    active,
    stateValue: state?.value ?? null,
    actualTurnToken: state?.turnToken ?? null,
    runnerAlive,
  });
  return active;
};

function emitClaudeLifecycleHook(expectedTurnToken: string, event: string): void {
  const separator = expectedTurnToken.lastIndexOf(':');
  const sessionId = expectedTurnToken.slice(0, separator);
  const obsDir = path.join(repo, '.agent', '.observability');
  const sessionPath = path.join(obsDir, 'sessions', `${encodeURIComponent(sessionId)}.json`);
  const sessionState = JSON.parse(readFileSync(sessionPath, 'utf-8')) as {
    transcript_path?: string;
  };
  execFileSync(process.execPath, [path.join(obsDir, 'bin', 'farmslot-observability-hook.mjs')], {
    cwd: repo,
    env: {
      ...process.env,
      FARMSLOT_OBS_DIR: obsDir,
      FARMSLOT_SLOT_ID: vars.slotId,
      FARMSLOT_RUNNER: runner,
      TMUX_PANE: target,
    },
    input: JSON.stringify({
      hook_event_name: event,
      session_id: sessionId,
      transcript_path: sessionState.transcript_path,
      cwd: repo,
    }),
  });
}

if (process.env.FARMSLOT_VALIDATION_PROBE_ONLY === '1') {
  const state = await readRunnerTurnState(vars, target, runner);
  const expectedTurnToken =
    process.env.FARMSLOT_VALIDATION_EXPECTED_TURN_TOKEN ?? state?.turnToken ?? '';
  const leaseAllowed = expectedTurnToken ? await turnActive(expectedTurnToken)() : false;
  writeFileSync(
    resultPath,
    `${JSON.stringify({ expectedTurnToken, leaseAllowed, turnReadings }, null, 2)}\n`,
    'utf-8',
  );
  process.exit(0);
}

const fakeSignalPath = path.join(repo, 'task', 'UNACCEPTED-SIGNAL.json');
const fakeSignalBaseline = await readLaunchAckSignalSnapshot(vars, fakeSignalPath);
writeFileSync(
  fakeSignalPath,
  `${JSON.stringify({ role: 'self-review-fix', status: 'running', timestamp: new Date().toISOString() })}\n`,
  'utf-8',
);
const unacceptedDelivery = await deliverPromptWithRetainedFallback({
  vars,
  target,
  runnerId: runner,
  safetyTier: 'dangerous',
  prompt: 'This recovery prompt was never submitted to the runner.',
  launchAckSignalPath: fakeSignalPath,
  launchAckBaseline: fakeSignalBaseline,
  priorPromptSendAttempted: true,
  timeoutMs: 10_000,
  forceBusyPoll: true,
});

// Start unrelated work first, then attempt the fix delivery while that turn is
// active. The production safe-send contract must wait for a new accepted turn;
// it must never lease the fix to this unrelated turn.
const busyDelivery = await deliverPromptWithRetainedFallback({
  vars,
  target,
  runnerId: runner,
  safetyTier: 'dangerous',
  prompt: 'Use the shell tool exactly once to run this command, and do nothing else: sleep 8',
  timeoutMs: 30_000,
  forceBusyPoll: true,
});
assert.equal(busyDelivery.delivered, true, 'unrelated busy turn must be accepted');
const busyTurnToken = busyDelivery.delivered ? busyDelivery.turnToken : undefined;
assert.ok(busyTurnToken, 'unrelated busy turn must expose its identity');
const busyLeaseActiveBeforeFix = await runnerTurnLeaseIsActive(vars, target, runner, busyTurnToken);
assert.equal(busyLeaseActiveBeforeFix, true, 'unrelated turn must be live before fix delivery');

const signal = JSON.stringify({
  role: 'self-review-fix',
  status: 'complete',
  outcome: 'success',
  disposition: 'fixed',
  timestamp: new Date().toISOString(),
});
const fixSignalPath = path.join(repo, 'task', 'SELF-REVIEW-FIX-SIGNAL.json');
const fixSignalBaseline = await readLaunchAckSignalSnapshot(vars, fixSignalPath);
const command = `sleep 14; printf '%s\\n' '${signal}' > task/SELF-REVIEW-FIX-SIGNAL.json`;
const prompt = `Use the shell tool exactly once to run this command, and do nothing else: ${command}`;
const acceptedDelivery = await deliverPromptWithRetainedFallback({
  vars,
  target,
  runnerId: runner,
  safetyTier: 'dangerous',
  prompt,
  launchAckSignalPath: fixSignalPath,
  launchAckBaseline: fixSignalBaseline,
  timeoutMs: 30_000,
  forceBusyPoll: true,
});
assert.equal(acceptedDelivery.delivered, true, 'production delivery must accept the fix prompt');
const acceptedTurnToken = acceptedDelivery.delivered ? acceptedDelivery.turnToken : undefined;
assert.ok(acceptedTurnToken, 'exact production acceptance must expose a runner turn token');
assert.notEqual(
  acceptedTurnToken,
  busyTurnToken,
  'fix prompt must bind to a new turn after unrelated work finishes',
);

let lifecycleLeaseProbe: { preCompact: boolean; postCompact: boolean } | null = null;
if (runner === 'claude') {
  emitClaudeLifecycleHook(acceptedTurnToken, 'PreCompact');
  const preCompact = await runnerTurnLeaseIsActive(vars, target, runner, acceptedTurnToken);
  emitClaudeLifecycleHook(acceptedTurnToken, 'PostCompact');
  const postCompact = await runnerTurnLeaseIsActive(vars, target, runner, acceptedTurnToken);
  lifecycleLeaseProbe = { preCompact, postCompact };
}

const startedAt = Date.now();
const [baselineResult, leasedResult] = await Promise.all([
  waitForWorkerSignal(vars, 'task', idleTimeoutMs, ''),
  waitForWorkerSignal(vars, 'task', idleTimeoutMs, '', turnActive(acceptedTurnToken)),
]);

const idleDeadline = Date.now() + 20_000;
let workerReachedIdle = false;
while (Date.now() < idleDeadline) {
  const state = await readRunnerTurnState(vars, target, runner);
  if (state?.value === 'idle') {
    workerReachedIdle = true;
    break;
  }
  await new Promise((resolve) => setTimeout(resolve, 250));
}
assert.equal(workerReachedIdle, true, 'accepted fix turn must reach idle before superseding probe');
const supersedingDelivery = await deliverPromptWithRetainedFallback({
  vars,
  target,
  runnerId: runner,
  safetyTier: 'dangerous',
  prompt: 'Use the shell tool exactly once to run this command, and do nothing else: sleep 12',
  timeoutMs: 30_000,
  forceBusyPoll: true,
});
assert.equal(supersedingDelivery.delivered, true, 'superseding turn must be accepted');
const supersedingTurnToken = supersedingDelivery.delivered
  ? supersedingDelivery.turnToken
  : undefined;
assert.ok(supersedingTurnToken, 'superseding turn must expose its identity');
const supersedingTurnProbe = {
  originalLeaseActive: await runnerTurnLeaseIsActive(vars, target, runner, acceptedTurnToken),
  supersedingLeaseActive: await runnerTurnLeaseIsActive(vars, target, runner, supersedingTurnToken),
  tokensDiffer: supersedingTurnToken !== acceptedTurnToken,
};

writeFileSync(
  resultPath,
  `${JSON.stringify(
    {
      elapsedMs: Date.now() - startedAt,
      idleTimeoutMs,
      baselineTimedOut: baselineResult === undefined,
      unacceptedTurnLeaseRejected:
        unacceptedDelivery.delivered === true && unacceptedDelivery.turnToken === undefined,
      acceptedTurnToken,
      busyTurnToken,
      busyLeaseActiveBeforeFix,
      fixTurnSeparatedFromBusyTurn: acceptedTurnToken !== busyTurnToken,
      lifecycleLeaseProbe,
      leasedSignalStatus: leasedResult?.status ?? null,
      activeTurnObserved: turnReadings.some((reading) => reading.active),
      supersedingTurnProbe,
      turnReadings,
    },
    null,
    2,
  )}\n`,
  'utf-8',
);
