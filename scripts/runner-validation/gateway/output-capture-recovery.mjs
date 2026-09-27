import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmod, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

const runId = process.env.FARMSLOT_OUTPUT_RUN_ID;
const workerArtifacts = process.env.FARMSLOT_OUTPUT_FIXTURE_ARTIFACTS;
const expectedReport = process.env.FARMSLOT_OUTPUT_EXPECT_REPORT_PATH;
const route = process.env.FARMSLOT_OUTPUT_REGRESSION_ROUTE;
const activeRunId = process.env.FARMSLOT_OUTPUT_ACTIVE_RETRY_ID;
const videoPath = process.env.FARMSLOT_OUTPUT_VIDEO_PATH;
const videoFps = Number(process.env.FARMSLOT_OUTPUT_VIDEO_FPS);
assert.ok(
  runId &&
    workerArtifacts &&
    expectedReport &&
    route &&
    activeRunId &&
    videoPath &&
    videoFps > 0 &&
    process.env.FARMSLOT_GATEWAY,
  'Set the output fixture run, artifacts directory, expected report, UI route and gateway',
);
assert.equal(
  (await readFile(path.join(workerArtifacts, '../.output-validation-fixture'), 'utf8')).trim(),
  runId,
  'This destructive negative control requires a dedicated, marked fixture',
);
function cdp(...args) {
  return JSON.parse(
    execFileSync(process.execPath, ['apps/command-center/scripts/cdp.mjs', ...args], {
      encoding: 'utf8',
    }),
  );
}
const rpc = (method, id = runId) => cdp('gateway', method, JSON.stringify({ runId: id }));
async function browserAssert(expression) {
  for (let i = 0; i < 20; i++) {
    if (
      cdp(
        'eval',
        route,
        `const root = document.querySelector('run-detail')?.shadowRoot; return Boolean(root && (${expression}));`,
      )
    )
      return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  assert.fail(`Browser assertion failed: ${expression}`);
}
assert.equal(rpc('run.refreshMirror').ok, true);
const before = rpc('run.get').run;
assert.equal(before.output.reportPath, expectedReport);
assert.ok(before.steps.some((step) => step.name === 'complete' && step.status === 'done'));
await browserAssert(
  `root.querySelector('[data-testid="run-output-files"] summary')?.textContent === 'Browse files (${before.output.artifactManifest.length})'`,
);
cdp('click', route, 'run-detail >>> [data-testid="run-results"] .evidence-actions button');
await browserAssert(
  `root.querySelector('media-lightbox')?.items?.some(item => item.path === ${JSON.stringify(videoPath)} && item.frameRate === ${videoFps})`,
);
cdp('eval', route, 'location.reload(); return true');
await browserAssert(`!!root.querySelector('[data-testid="run-results"]')`);
assert.ok(expectedReport.startsWith('artifacts/') && !expectedReport.split('/').includes('..'));
const preferredFile = path.join(workerArtifacts, expectedReport.slice('artifacts/'.length));
const originalReport = await readFile(preferredFile);
await writeFile(preferredFile, ' \n');
try {
  assert.equal(rpc('run.refreshMirror').ok, true);
  assert.equal(
    rpc('run.get').run.output.reportPath,
    'artifacts/report.md',
    'Empty preferred narrative uses fallback',
  );
} finally {
  await writeFile(preferredFile, originalReport);
  assert.equal(rpc('run.refreshMirror').ok, true);
}
const pending = rpc('run.get').run.decisions.find(
  (d) => !d.resolvedAt && d.payload?.kind === 'output-review',
);
assert.ok(pending, 'Fixture needs a pending output review');
const active = rpc('run.get', activeRunId).run;
assert.equal(active.status, 'dispatching');
assert.equal(
  active.output.workerFinished,
  true,
  'Retry fixture retains its prior completed snapshot',
);
assert.equal(
  path.dirname(active.taskFile),
  path.dirname(before.taskFile),
  'Both disposable fixture runs must use this marked task',
);
const originalMode = (await stat(workerArtifacts)).mode & 0o777;
await chmod(workerArtifacts, 0);
try {
  assert.equal(rpc('run.refreshMirror').ok, false, 'Unreadable worker files must fail capture');
  const failed = rpc('run.get').run;
  assert.ok(failed.output.captureError);
  assert.equal(failed.decisions.find((d) => d.id === pending.id)?.resolvedAction, 'superseded');
  assert.ok(!failed.decisions.some((d) => !d.resolvedAt && d.payload?.kind === 'output-review'));
  assert.equal(rpc('run.refreshMirror', activeRunId).ok, false);
  const failedActive = rpc('run.get', activeRunId).run;
  assert.equal(failedActive.status, 'dispatching');
  assert.equal(
    failedActive.output.workerFinished,
    false,
    'Capture failure must not label an active retry finished',
  );
  await browserAssert(
    `!root.querySelector('[data-testid="output-review-gate"]') && [...root.querySelectorAll('[role="alert"]')].some(el => el.textContent.includes('Could not retrieve worker files'))`,
  );
} finally {
  await chmod(workerArtifacts, originalMode);
  assert.equal(rpc('run.refreshMirror').ok, true, 'Restore the fixture and recapture');
}
const recovered = rpc('run.get').run;
assert.ok(!recovered.output.captureError);
assert.ok(
  recovered.decisions.some(
    (d) => !d.resolvedAt && d.payload?.kind === 'output-review' && d.id !== pending.id,
  ),
);
assert.equal(recovered.output.manifestDigest, before.output.manifestDigest);
assert.deepEqual(recovered.steps, before.steps);
assert.deepEqual(recovered.metrics, before.metrics);
assert.equal(recovered.status, before.status);
await browserAssert(`!!root.querySelector('[data-testid="output-review-gate"]')`);
console.log(
  JSON.stringify({
    pass: true,
    preferredReport: expectedReport,
    uniqueFiles: before.output.artifactManifest.length,
    failedReviewSuperseded: true,
    recoveryCreatedReview: true,
    executionUnchanged: true,
    emptyReportFallback: true,
    videoFrameRateRetained: true,
    activeRetryStillRunning: true,
  }),
);
