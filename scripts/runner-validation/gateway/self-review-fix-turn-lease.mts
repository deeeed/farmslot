#!/usr/bin/env tsx
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import os from 'node:os';

import type { SlotVars } from '@farmslot/slot-config';

const repo = process.env.FARMSLOT_VALIDATION_REPO;
const target = process.env.FARMSLOT_VALIDATION_TARGET;
const runner = process.env.FARMSLOT_VALIDATION_RUNNER;
const resultPath = process.env.FARMSLOT_VALIDATION_RESULT_PATH;
assert.ok(repo && target && runner && resultPath, 'validation inputs are required');

process.env.NODE_TEST_CONTEXT = '1';
process.env.FARMSLOT_DISABLE_RUN_ENGINE_START = '1';

const [{ waitForWorkerSignal }, { readRunnerTurnState }, { paneHostsRunnerProcess }] =
  await Promise.all([
    import('../../../services/gateway/src/self-review/orchestrator.js'),
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
  claudePath: '',
  codexPath: '',
  opencodePath: '',
  cursorPath: '',
  grokPath: '',
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
  value: string | null;
  confidence: string | null;
  runnerAlive: boolean | null;
}> = [];

const turnActive = async () => {
  const reading = await readRunnerTurnState(vars, target, runner);
  const structuredActive = reading?.value === 'active' && reading.confidence === 'high';
  const runnerAlive = structuredActive ? await paneHostsRunnerProcess(vars, target, runner) : null;
  turnReadings.push({
    value: reading?.value ?? null,
    confidence: reading?.confidence ?? null,
    runnerAlive,
  });
  return structuredActive && runnerAlive === true;
};

if (process.env.FARMSLOT_VALIDATION_PROBE_ONLY === '1') {
  const leaseAllowed = await turnActive();
  writeFileSync(
    resultPath,
    `${JSON.stringify({ leaseAllowed, turnReadings }, null, 2)}\n`,
    'utf-8',
  );
  process.exit(0);
}

const startedAt = Date.now();
const [baselineResult, leasedResult] = await Promise.all([
  waitForWorkerSignal(vars, 'task', idleTimeoutMs, ''),
  waitForWorkerSignal(vars, 'task', idleTimeoutMs, '', turnActive),
]);

writeFileSync(
  resultPath,
  `${JSON.stringify(
    {
      elapsedMs: Date.now() - startedAt,
      idleTimeoutMs,
      baselineTimedOut: baselineResult === undefined,
      unacceptedTurnLeaseRejected: baselineResult === undefined,
      leasedSignalStatus: leasedResult?.status ?? null,
      activeTurnObserved: turnReadings.some(
        (reading) => reading.value === 'active' && reading.confidence === 'high',
      ),
      turnReadings,
    },
    null,
    2,
  )}\n`,
  'utf-8',
);
