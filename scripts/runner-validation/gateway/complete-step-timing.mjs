// Read a finished run through the gateway and check that its COMPLETE step says where its time
// went and that its slot release was timed. Read-only: one run.get per run.
//   FARMSLOT_GATEWAY=ws://localhost:7801 FARMSLOT_GATEWAY_PROFILE=<profile> node scripts/runner-validation/gateway/complete-step-timing.mjs <run-id>...
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const gateway = process.env.FARMSLOT_GATEWAY;
const runIds = process.argv.slice(2);
assert.ok(gateway && runIds.length, 'Set FARMSLOT_GATEWAY and pass one or more finished run IDs');

// The committed gateway probe; it authenticates from FARMSLOT_HOME (FARMSLOT_GATEWAY_PROFILE).
const rpc = (method, params) =>
  JSON.parse(
    execFileSync(
      process.execPath,
      [
        path.join(root, 'apps/command-center/scripts/cdp.mjs'),
        'gateway',
        method,
        JSON.stringify(params),
      ],
      { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
    ),
  );

for (const runId of runIds) {
  const { run } = rpc('run.get', { runId });
  const complete = run.steps.find((step) => step.name === 'complete');
  assert.equal(complete?.status, 'done', `${runId}: COMPLETE is not done`);
  const timing = complete.outputs?.timing;
  const summary = {
    runId,
    flowType: run.flowType,
    durationMs: complete.durationMs,
    hasTiming: Boolean(timing),
    totalMs: timing?.totalMs,
    phasesMs: timing?.phasesMs,
    bundleLock: timing?.bundleLock,
    exec: timing?.exec,
    slotRelease: run.slotRelease ?? null,
  };
  console.log(JSON.stringify(summary));
  assert.ok(timing, `${runId}: COMPLETE has no timing`);
  assert.ok(timing.totalMs <= complete.durationMs, `${runId}: timing exceeds the step`);
  // A local-first package (gate-held) times `package`; a direct completion times `pipeline`.
  if (run.flowType !== 'review-pr')
    assert.ok(
      (timing.phasesMs.pipeline ?? 0) + (timing.phasesMs.package ?? 0) > 0,
      `${runId}: no pipeline or package phase`,
    );
  assert.ok(Number.isInteger(timing.bundleLock?.waitMs), `${runId}: no bundle-lock wait`);
  assert.ok(run.slotRelease?.durationMs >= 0, `${runId}: slot release was not timed`);
}
console.log(JSON.stringify({ checked: runIds.length, completeTimed: true }));
