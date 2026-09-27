// Run against a finished artifact-only run on an isolated validation gateway.
// Refreshes retained output; never acknowledges a report or resumes a worker.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

const runId = process.env.FARMSLOT_OUTPUT_RUN_ID;
const expectedReportHash = process.env.FARMSLOT_OUTPUT_REPORT_SHA256;
assert.ok(
  process.env.FARMSLOT_GATEWAY && runId && expectedReportHash,
  'Set FARMSLOT_GATEWAY, FARMSLOT_OUTPUT_RUN_ID and FARMSLOT_OUTPUT_REPORT_SHA256',
);

function rpc(method, params) {
  return JSON.parse(
    execFileSync(
      process.execPath,
      ['apps/command-center/scripts/cdp.mjs', 'gateway', method, JSON.stringify(params)],
      { encoding: 'utf8' },
    ),
  );
}

const { run: before } = rpc('run.get', { runId });
assert.equal(before.completionPolicy, 'artifact-only');
assert.ok(
  ['blocked', 'failed', 'done', 'paused', 'human-gating', 'monitoring'].includes(before.status),
);
const refreshed = rpc('run.refreshMirror', { runId });
assert.equal(refreshed.ok, true, refreshed.reason);
const { run: after } = rpc('run.get', { runId });
assert.ok(after.output?.workerFinished, 'Retained output must identify a finished worker');
assert.ok(!after.output.captureError, after.output.captureError);
const report = after.output.artifactManifest.find((a) => a.path === after.output.reportPath);
assert.equal(report?.sha256, expectedReportHash, 'The original report bytes must be retained');
assert.ok(after.output.artifactManifest.every((a) => a.sha256 && a.path.startsWith('artifacts/')));
assert.equal(after.status, before.status, 'Refreshing output must preserve run status');
assert.deepEqual(after.metrics, before.metrics, 'Refreshing output must preserve the verdict');
assert.deepEqual(after.steps, before.steps, 'Refreshing output must not restart any step');
assert.deepEqual(
  after.engineState,
  before.engineState,
  'Refreshing output must not resume execution',
);
const gate = after.decisions.find(
  (d) =>
    d.payload?.kind === 'output-review' &&
    d.payload.manifestDigest === after.output.manifestDigest &&
    d.resolvedAction !== 'superseded',
);
assert.ok(gate, 'The captured report must have its own output review');
const prior = before.decisions.find((d) => d.id === gate.id);
if (prior) assert.equal(gate.resolvedAt, prior.resolvedAt, 'Refresh must preserve acknowledgement');
console.log(
  JSON.stringify(
    {
      pass: true,
      runId,
      status: after.status,
      outcome: after.metrics.outcome,
      copied: refreshed.copied,
      indexed: after.output.artifactManifest.length,
      reportPath: after.output.reportPath,
      review: gate.resolvedAction ?? 'pending',
      executionUnchanged: true,
    },
    null,
    2,
  ),
);
