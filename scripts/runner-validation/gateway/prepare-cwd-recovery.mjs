#!/usr/bin/env node
// Read-only proof after replaying prepare against a tmux server with a deleted cwd.
// FARMSLOT_GATEWAY and FARMSLOT_CWD_PROOF_RUN_ID select the production run.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const runId = process.env.FARMSLOT_CWD_PROOF_RUN_ID;
assert.ok(runId, 'Set FARMSLOT_CWD_PROOF_RUN_ID to the replayed run');
const { run } = JSON.parse(
  execFileSync(
    process.execPath,
    [
      path.join(root, 'apps/command-center/scripts/cdp.mjs'),
      'gateway',
      'run.get',
      JSON.stringify({ runId }),
    ],
    { cwd: root, encoding: 'utf8' },
  ),
);
const prepare = run.steps.find((step) => step.name === 'prepare');
assert.equal(prepare?.status, 'done', 'Prepare must finish through the live gateway');
assert.ok(
  run.recoveryAttempts.some((attempt) => attempt.stepName === 'prepare'),
  'The run must have retried prepare',
);
const fixtures = prepare.outputs.subSteps.find((step) => step.name === 'fixtures');
assert.equal(fixtures?.outcome, 'ok');
const logPath = path.join(root, '.omx/logs', `prepare-${run.slotId}`, 'fixtures.log');
assert.ok(statSync(logPath).mtimeMs >= Date.parse(prepare.startedAt), 'Fixture log must be fresh');
const log = readFileSync(logPath, 'utf8');
assert.ok(log.includes(`prepare-${run.id.slice(0, 8)}-fixtures`), 'Log must belong to this run');
assert.ok(
  log.includes(`Slot ${run.slotId} fixtures synced to `),
  'Actual fixture copy must complete',
);
assert.doesNotMatch(log, /uv_cwd|Prepare working directory unavailable/);
console.log(
  JSON.stringify(
    { runId, slotId: run.slotId, prepare: prepare.status, fixtures: 'synced', logPath },
    null,
    2,
  ),
);
