// Isolated gateway proof: a refused release must stay visible and retryable.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
assert.equal(
  process.env.FARMSLOT_VALIDATION_ROOT,
  root,
  'Explicitly identify the isolated validation checkout',
);
assert.notEqual(
  execFileSync('git', ['branch', '--show-current'], { encoding: 'utf8' }).trim(),
  'main',
  'Never seed validation state on operator main',
);
const scratch = path.join(root, 'temp/output-close-retry-proof');
const saved = path.join(scratch, 'fixture.json');
const runsDir = path.join(root, 'temp/results-validation/runs');
const statusFile = path.join(root, '.farm-status.json');
const hash = (value) => createHash('sha256').update(value).digest('hex');
if (process.argv.includes('--seed')) {
  await mkdir(path.join(scratch, 'artifacts'), { recursive: true });
  const report = '<h1>PARTIAL: disposable cleanup proof</h1><p>Coverage remains incomplete.</p>';
  await writeFile(path.join(scratch, 'artifacts/report.html'), report);
  await writeFile(path.join(scratch, 'TASK.md'), '# Disposable cleanup retry proof');
  const runId = randomUUID(),
    decisionId = randomUUID(),
    now = new Date().toISOString();
  const artifact = {
    path: 'artifacts/report.html',
    sha256: hash(report),
    sizeBytes: Buffer.byteLength(report),
    purpose: 'report',
  };
  const manifestDigest = hash(
    JSON.stringify([
      { path: artifact.path, sha256: artifact.sha256, sizeBytes: artifact.sizeBytes },
    ]),
  );
  const run = {
    id: runId,
    familyId: runId,
    parentRunId: null,
    createdByPrincipalId: 'legacy-env',
    lane: 'production',
    flowType: 'dev',
    mode: 'autonomous',
    status: 'blocked',
    project: 'generic-project',
    ticketOrPr: 'disposable-output-close-retry',
    slotId: 'output-close-proof-fence',
    branch: null,
    taskFile: path.join(scratch, 'TASK.md'),
    completionPolicy: 'artifact-only',
    steps: [{ name: 'monitor', status: 'failed', detail: 'Original incomplete proof' }],
    metrics: { nudgeCount: 0, model: null, runner: null, outcome: 'partial' },
    error: 'Coverage gap retained',
    createdAt: now,
    updatedAt: now,
    completedAt: now,
    output: {
      workerFinished: true,
      capturedAt: now,
      artifactManifest: [artifact],
      manifestDigest,
      reportPath: artifact.path,
    },
    decisions: [
      {
        id: decisionId,
        type: 'engine_output_review',
        title: 'Review output',
        description: 'Disposable fixture',
        actions: [{ id: 'close-run', label: 'Close run' }],
        createdAt: now,
        payload: { kind: 'output-review', manifestDigest, reportPath: artifact.path },
      },
    ],
  };
  await writeFile(path.join(runsDir, runId + '.json'), JSON.stringify(run, null, 2));
  const status = JSON.parse(await readFile(statusFile, 'utf8'));
  assert.ok(
    !status.slots.some((slot) => slot.slot === run.slotId),
    'Previous retry fixture must be reconciled before seeding again',
  );
  status.slots.push({
    slot: run.slotId,
    lifecycle: 'busy',
    phase: 'releasing',
    current_run_id: runId,
    slot_epoch: 0,
  });
  await writeFile(statusFile, JSON.stringify(status, null, 2));
  await writeFile(saved, JSON.stringify({ runId, decisionId, slotId: run.slotId, original: run }));
  console.log(JSON.stringify({ seeded: runId, restartIsolatedGateway: true }));
} else {
  assert.equal(
    process.env.FARMSLOT_GATEWAY,
    'ws://127.0.0.1:8001',
    'Never run against operator gateway',
  );
  const fixture = JSON.parse(await readFile(saved, 'utf8'));
  const rpc = (method, params = { runId: fixture.runId }) =>
    JSON.parse(
      execFileSync(
        process.execPath,
        ['apps/command-center/scripts/cdp.mjs', 'gateway', method, JSON.stringify(params)],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
      ),
    );
  const before = rpc('run.get').run;
  assert.equal(before.ticketOrPr, 'disposable-output-close-retry');
  if (process.argv.includes('--retry')) {
    assert.equal(
      before.output.cleanupPending,
      true,
      'Cleanup obligation must survive gateway restart',
    );
    assert.match(before.output.closeError, /still owns/);
    // Simulate an independently completed release without touching any real slot.
    const status = JSON.parse(await readFile(statusFile, 'utf8'));
    const slot = status.slots.find((slot) => slot.slot === fixture.slotId);
    assert.equal(slot.current_run_id, fixture.runId);
    slot.current_run_id = null;
    slot.phase = null;
    slot.lifecycle = 'ready';
    await writeFile(statusFile, JSON.stringify(status, null, 2));
    await writeFile(
      path.join(scratch, 'artifacts/report.html'),
      '<h1>Changed report after execution closed</h1>',
    );
    const result = rpc('run.resolveDecision', {
      runId: fixture.runId,
      decisionId: fixture.decisionId,
      actionId: 'close-run',
    }).run;
    assert.equal(result.output.cleanupPending, false);
    assert.equal(result.output.closeError, undefined);
    assert.equal(result.output.closedAt, before.output.closedAt);
    assert.deepEqual(result.metrics, fixture.original.metrics);
    rpc('run.resolveDecision', {
      runId: fixture.runId,
      decisionId: fixture.decisionId,
      actionId: 'close-run',
    });
    assert.equal(rpc('run.get').run.output.closedAt, before.output.closedAt);
    console.log(
      JSON.stringify({
        pass: true,
        restartPreservedCleanup: true,
        changedBytesDoNotStrandCleanup: true,
        idempotent: true,
        runId: fixture.runId,
      }),
    );
  } else {
    const result = rpc('run.resolveDecision', {
      runId: fixture.runId,
      decisionId: fixture.decisionId,
      actionId: 'close-run',
    }).run;
    assert.equal(result.status, 'done');
    assert.equal(result.metrics.outcome, 'partial');
    assert.equal(result.output.cleanupPending, true);
    assert.match(result.output.closeError, /still owns/);
    assert.deepEqual(result.steps, before.steps);
    assert.equal(result.error, before.error);
    for (const method of ['run.archive', 'run.delete'])
      assert.throws(
        () => rpc(method),
        (error) => String(error.stderr).includes('closeout cleanup'),
      );
    console.log(
      JSON.stringify({
        pass: true,
        refusedReleaseRetained: true,
        archiveDeleteGuarded: true,
        restartThenRetry: true,
        runId: fixture.runId,
      }),
    );
  }
}
