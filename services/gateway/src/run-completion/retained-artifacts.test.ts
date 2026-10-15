import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import {
  createEvidenceReviewModel,
  readEvidenceReviewReport,
} from '@farmslot/adapter-sdk/evidence';
import { openRunBundleStore } from '@farmslot/run-bundle';

import '../runtime/mock-pty.test-support.js';

const root = await mkdtemp(path.join(tmpdir(), 'gateway-retained-artifacts-'));
process.env.FARMSLOT_HOME = path.join(root, 'home');
process.env.FARMSLOT_RUNS_DIR = path.join(root, 'runs');
await openRunBundleStore({
  runsDir: process.env.FARMSLOT_RUNS_DIR,
  home: process.env.FARMSLOT_HOME,
  create: true,
});
after(() => rm(root, { recursive: true, force: true }));

const { createRun, getRun, updateRun } = await import('../runs/store.js');
const { captureRunOutput, acknowledgeRunOutput } = await import('./output.js');
const { retainRunArtifacts, readRetainedRunText } = await import('./retained-artifacts.js');
const { runRecipeRunsForRun } = await import('../methods/run/context.js');
const { serveRunArtifact } = await import('../methods/filesystem.js');

async function fixture() {
  const run = createRun({
    flowType: 'dev',
    project: 'example',
    ticketOrPr: 'RETAINED',
    completionPolicy: 'artifact-only',
    mode: 'validation',
  });
  const taskDir = path.join(root, run.id);
  await mkdir(path.join(taskDir, 'artifacts'), { recursive: true });
  const body = '<h1>Snapshot report</h1>';
  await writeFile(path.join(taskDir, 'artifacts/report.html'), body);
  updateRun(run.id, { taskFile: path.join(taskDir, 'TASK.md'), status: 'completing' });
  return { runId: run.id, taskDir, body };
}

test('capture, RPC metadata and HTTP ranges read one pinned bundle after the task is removed', async (t) => {
  const f = await fixture();
  await captureRunOutput(f.runId, false, true);
  const captured = getRun(f.runId)!;
  const ref = captured.output?.artifactBundle;
  assert.ok(ref);
  assert.equal(
    captured.output?.artifactManifest.find((file) => file.path === 'artifacts/report.html')?.sha256,
    createHash('sha256').update(f.body).digest('hex'),
  );
  await rm(f.taskDir, { recursive: true });
  const result = await runRecipeRunsForRun({ runId: f.runId, includeRecordedEvidence: true });
  assert.ok(result.recordedEvidence?.report);
  const model = createEvidenceReviewModel({ report: result.recordedEvidence.report });
  const server = createServer((request, response) => {
    void serveRunArtifact(request, response);
  });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}/api/run-artifact?runId=${f.runId}&path=artifacts%2Freport.html&bundleDigest=${ref.bundleDigest}`;
  const report = await readEvidenceReviewReport(model, async () => {
    const response = await fetch(url);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('x-farmslot-bundle-digest'), ref.bundleDigest);
    return new Uint8Array(await response.arrayBuffer());
  });
  assert.equal(report.body, f.body);
  const range = await fetch(url, { headers: { Range: 'bytes=0-3' } });
  assert.equal(range.status, 206);
  assert.equal(await range.text(), '<h1>');
  const retry = await retainRunArtifacts(f.runId);
  assert.deepEqual(retry.ref, ref);
  assert.deepEqual(retry.missingData, []);
});

test('mark-reviewed is metadata-only and verifies the captured report despite mirror mutation', async () => {
  const f = await fixture();
  await captureRunOutput(f.runId, false, true);
  const run = getRun(f.runId)!;
  const decision = run.decisions.find((decision) => decision.payload?.kind === 'output-review');
  assert.ok(decision);
  const before = structuredClone(run.output?.artifactBundle);
  await writeFile(path.join(f.taskDir, 'artifacts/report.html'), 'later slot bytes');
  await acknowledgeRunOutput(f.runId, decision.id);
  assert.deepEqual(getRun(f.runId)?.output?.artifactBundle, before);
  assert.equal(
    getRun(f.runId)?.decisions.find(({ id }) => id === decision.id)?.resolvedAction,
    'mark-reviewed',
  );
});

test('a generation change during acquisition cannot replace the committed snapshot', async () => {
  const f = await fixture();
  await captureRunOutput(f.runId, false, true);
  const run = getRun(f.runId)!;
  const prior = structuredClone(run.output?.artifactBundle);
  await writeFile(path.join(f.taskDir, 'artifacts/report.html'), 'new generation report');
  const capture = captureRunOutput(f.runId, false, true);
  updateRun(f.runId, {
    engineState: { ...run.engineState, generation: (run.engineState?.generation ?? 0) + 1 },
  });
  await assert.rejects(capture, /attempt changed/);
  assert.deepEqual(getRun(f.runId)?.output?.artifactBundle, prior);
});

test('unretained artifact discovery refuses without any live slot fallback', async () => {
  const f = await fixture();
  updateRun(f.runId, { slotId: 'unavailable-proof-slot', status: 'done' });
  await assert.rejects(
    runRecipeRunsForRun({ runId: f.runId }),
    /Run artifacts are not retained.*bundle retain/,
  );
  assert.equal(await readFile(path.join(f.taskDir, 'artifacts/report.html'), 'utf8'), f.body);
});

test(
  'repeated metadata, stills, ranges and aborted responses release bundle file handles',
  { skip: process.platform === 'win32' },
  async (t) => {
    const f = await fixture();
    await writeFile(path.join(f.taskDir, 'artifacts/still.png'), Buffer.alloc(128 * 1024, 7));
    await writeFile(
      path.join(f.taskDir, 'artifacts/recording.mp4'),
      Buffer.alloc(4 * 1024 * 1024, 9),
    );
    await captureRunOutput(f.runId, false, true);
    await rm(f.taskDir, { recursive: true });
    const server = createServer((request, response) => {
      void serveRunArtifact(request, response);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const url = (file: string) =>
      `http://127.0.0.1:${address.port}/api/run-artifact?runId=${f.runId}&path=artifacts/${file}`;
    const read = async (file: string, range?: string) => {
      const response = await fetch(url(file), { headers: range ? { Range: range } : {} });
      await response.arrayBuffer();
      return response.status;
    };
    try {
      await read('still.png'); // Warm persistent client sockets before counting.
      await read('report.html');
      const baseline = (await readdir('/dev/fd')).length;
      for (let i = 0; i < 20; i += 1) {
        await runRecipeRunsForRun({ runId: f.runId, includeRecordedEvidence: true });
        assert.equal(await read('report.html'), 200);
        assert.equal(await read('still.png'), 200);
        assert.equal(await read('recording.mp4', 'bytes=32-127'), 206);
        assert.equal(await read('recording.mp4', 'bytes=99999999-'), 416);
        const controller = new AbortController();
        const response = await fetch(url('recording.mp4'), { signal: controller.signal });
        controller.abort();
        await assert.rejects(response.arrayBuffer(), { name: 'AbortError' });
        const earlyAbort = new AbortController();
        server.once('request', () => earlyAbort.abort());
        await assert.rejects(fetch(url('recording.mp4'), { signal: earlyAbort.signal }), {
          name: 'AbortError',
        });
      }
      // Response-close cleanup is asynchronous. Poll it without depending on garbage collection.
      const deadline = Date.now() + 1000;
      let remaining = (await readdir('/dev/fd')).length;
      while (remaining > baseline + 4 && Date.now() < deadline) {
        await delay(5);
        remaining = (await readdir('/dev/fd')).length;
      }
      t.diagnostic(
        JSON.stringify({
          iterations: 20,
          httpRequests: 120,
          metadataRequests: 20,
          baselineFDs: baseline,
          finalFDs: remaining,
        }),
      );
      assert.ok(remaining <= baseline + 4, `File handles grew from ${baseline} to ${remaining}`);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  },
);

test('historical report discovery keeps the decision bundle after a successor capture', async () => {
  const f = await fixture();
  await mkdir(path.join(f.taskDir, 'inputs'), { recursive: true });
  await writeFile(path.join(f.taskDir, 'inputs/diff.txt'), 'frozen review input');
  await captureRunOutput(f.runId, false, true);
  const original = getRun(f.runId)!;
  const decision = original.decisions.find(({ payload }) => payload?.kind === 'output-review');
  const ref = original.output?.artifactBundle;
  assert.ok(decision && ref);
  await writeFile(path.join(f.taskDir, 'artifacts/report.html'), 'successor report');
  await writeFile(path.join(f.taskDir, 'inputs/diff.txt'), 'successor review input');
  await captureRunOutput(f.runId, false, true);
  const current = getRun(f.runId)!;
  assert.notEqual(current.output?.artifactBundle?.bundleDigest, ref.bundleDigest);
  const view = await runRecipeRunsForRun({
    runId: f.runId,
    decisionId: decision.id,
    includeRecordedEvidence: true,
  });
  assert.deepEqual(view.recordedEvidence?.report?.artifactBundle, ref);
  assert.equal(
    view.recordedEvidence?.report?.artifactManifest.find(
      ({ path }) => path === 'artifacts/report.html',
    )?.sha256,
    createHash('sha256').update(f.body).digest('hex'),
  );
  assert.equal(await readRetainedRunText(current, 'artifacts/report.html', ref), f.body);
  assert.equal(await readRetainedRunText(current, 'inputs/diff.txt', ref), 'frozen review input');
});

test('publication selection and inventory come from the same capture after source removal', async () => {
  const f = await fixture();
  updateRun(f.runId, { recordedEvidenceContractVersion: 0 });
  await writeFile(path.join(f.taskDir, 'artifacts/after.png'), 'retained image');
  await writeFile(
    path.join(f.taskDir, 'artifacts/evidence-manifest.json'),
    JSON.stringify({
      version: 1,
      preferred_mode: 'screenshots',
      standalone: [{ label: 'Result', file: 'after.png' }],
    }),
  );
  await captureRunOutput(f.runId, false, true);
  await rm(f.taskDir, { recursive: true });
  const { readCurrentPackageEvidence } = await import('./package-evidence-manifest.js');
  const evidence = await readCurrentPackageEvidence(getRun(f.runId)!);
  assert.equal(evidence.manifest?.standalone?.[0]?.file, 'after.png');
  assert.ok(
    evidence.inventory.some(
      (entry) =>
        entry.path === 'artifacts/after.png' &&
        entry.sha256 === createHash('sha256').update('retained image').digest('hex'),
    ),
  );
});

test('retained capacity refusal records a failed lifecycle step without dispatching work', async (t) => {
  const policy = path.join(root, 'home/run-bundle-retention.json');
  t.after(() => rm(policy, { force: true }));
  await writeFile(
    policy,
    JSON.stringify({
      runBundleRetention: {
        maxBundleBytes: 1,
        maxStoreBytes: 2,
        metadataReserveBytes: 1,
        mediaRetentionDays: 30,
      },
    }),
  );
  const run = createRun({
    flowType: 'dev',
    project: 'example',
    ticketOrPr: 'CAPACITY',
    mode: 'validation',
  });
  t.after(async () => {
    const { deleteTestRunIfPresent } = await import('../run-engine/test-fixtures.js');
    await deleteTestRunIfPresent(run.id);
  });
  const { startRun } = await import('../run-engine/orchestrator.js');
  await startRun(run.id);
  const refused = getRun(run.id)!;
  assert.equal(refused.status, 'failed');
  assert.match(refused.error ?? '', /retained report metadata capacity is exhausted/i);
  assert.equal(refused.steps[0]?.status, 'failed');
  assert.equal(refused.slotId, null);
});

test('a metadata capture preserves the source video when bundle capacity defers its bytes', async (t) => {
  const f = await fixture();
  const { farmslotRoot } = await import('../projects/repo-root.js');
  const taskDir = path.join(farmslotRoot, '.sandbox/retained-capacity/tasks', f.runId);
  const policy = path.join(root, 'home/run-bundle-retention.json');
  t.after(async () => {
    await rm(taskDir, { recursive: true, force: true });
    await rm(policy, { force: true });
  });
  await mkdir(path.join(taskDir, 'artifacts'), { recursive: true });
  await writeFile(path.join(taskDir, 'artifacts/report.html'), f.body);
  const video = Buffer.alloc(1024 * 1024, 3);
  await writeFile(path.join(taskDir, 'artifacts/capture.mp4'), video);
  await writeFile(
    policy,
    JSON.stringify({
      runBundleRetention: {
        maxBundleBytes: 512 * 1024,
        maxStoreBytes: 100 * 1024 * 1024,
        metadataReserveBytes: 1024 * 1024,
        mediaRetentionDays: 30,
      },
    }),
  );
  updateRun(f.runId, { taskFile: path.join(taskDir, 'TASK.md') });
  await captureRunOutput(f.runId, false, true);
  const captured = getRun(f.runId)!;
  assert.ok(
    captured.output?.retentionMissingData?.includes('media-capacity:artifacts/capture.mp4'),
  );
  assert.equal(await readRetainedRunText(captured, 'artifacts/report.html'), f.body);
  assert.deepEqual(await readFile(path.join(taskDir, 'artifacts/capture.mp4')), video);
});
