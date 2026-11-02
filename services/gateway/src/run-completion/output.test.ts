import assert from 'node:assert/strict';
import fsPromises, { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { buildRunResolveDecisionParams, type RunOutput } from '@farmslot/protocol';

import type { RunArtifactAcquisition } from './retained-artifacts.js';

await import('../runtime/mock-pty.test-support.js');
const { runResolveDecision } = await import('../methods/run.js');
const { makeRun } = await import('../methods/run/test-fixtures.js');
const { createRun, deleteRun, getRun, updateRun } = await import('../runs/store.js');
const {
  captureRunOutput,
  failRunOutputCapture,
  outputManifestDigest,
  outputReviewDecisions,
  verifyRunOutputReview,
} = await import('./output.js');
const { closeRunOutput } = await import('./output-close.js');
const { createRunArtifactAcquisition, retainedRunTaskDirectory } =
  await import('./retained-artifacts.js');
const { createRetrospectiveForRun } = await import('./retrospective.js');

/**
 * An acquisition that waits in acquireMedia until released. A capture acquires its media after
 * the bundle's metadata commit and before its final commit.
 */
function gatedAcquisition(runId: string) {
  let release = () => {};
  let reach = () => {};
  const gate = new Promise<void>((resolve) => (release = resolve));
  const reached = new Promise<void>((resolve) => (reach = resolve));
  const inner = createRunArtifactAcquisition(getRun(runId)!);
  const acquisition: RunArtifactAcquisition = {
    get media() {
      return inner.media;
    },
    beforeCopy: (locality) => inner.beforeCopy(locality),
    acquireMedia: async (artifact, destination, maxBytes) => {
      reach();
      await gate;
      return inner.acquireMedia(artifact, destination, maxBytes);
    },
  };
  return { acquisition, reached, release: () => release() };
}

const output: RunOutput = {
  workerFinished: true,
  capturedAt: new Date().toISOString(),
  manifestDigest: 'digest',
  reportPath: 'artifacts/report.md',
  artifactManifest: [],
};

test('completion diagnostics and a pending retrospective preserve the captured QA review and close', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'output-retrospective-'));
  await mkdir(path.join(dir, 'artifacts'));
  await writeFile(path.join(dir, 'artifacts/report.html'), '<h1>Passed 17/17</h1>');
  await writeFile(path.join(dir, 'artifacts/qa-result.json'), '{"passed":17}\n');
  const run = createRun({ flowType: 'dev', project: 'generic-project', ticketOrPr: 'PROJ-123' });
  t.after(async () => {
    if (getRun(run.id)) {
      updateRun(run.id, { status: 'failed' });
      await deleteRun(run.id);
    }
    await rm(dir, { recursive: true, force: true });
  });
  updateRun(run.id, {
    flowType: 'qa',
    status: 'done',
    completedAt: new Date().toISOString(),
    completionPolicy: 'artifact-only',
    taskFile: path.join(dir, 'TASK.md'),
    metrics: { ...run.metrics, outcome: 'success' },
    steps: [{ name: 'complete', status: 'done' }],
  });
  const logs = t.mock.method(console, 'info', () => {});
  await captureRunOutput(run.id, false);
  const scanLogs = logs.mock.calls.filter((call) =>
    String(call.arguments[0]).includes(' acquisition scan: '),
  );
  assert.equal(scanLogs.length, 1, 'one acquisition timing line per output capture');
  assert.match(
    String(scanLogs[0]!.arguments[0]),
    new RegExp(
      `^\\[output\\] ${run.id} acquisition scan: files=\\d+ settledDirs=\\d+ durationMs=\\d+\\.\\d$`,
    ),
  );
  const captured = getRun(run.id)!;
  const review = captured.decisions.find((decision) => decision.payload?.kind === 'output-review')!;
  const digest = captured.output!.manifestDigest;
  const metrics = structuredClone(captured.metrics);
  const steps = structuredClone(captured.steps);
  await writeFile(path.join(dir, 'artifacts/diff-stat.json'), '{"files":0}\n');
  await writeFile(path.join(dir, 'artifacts/iteration-diff-stat.json'), '{"files":0}\n');
  await createRetrospectiveForRun(run.id);
  const retrospective = getRun(run.id)!.decisions.find(
    (decision) => decision.type === 'retrospective',
  )!;
  assert.ok(retrospective);
  const acknowledged = await runResolveDecision(
    { runId: run.id, decisionId: review.id, actionId: 'mark-reviewed' },
    () => {},
  );
  assert.equal(acknowledged.run.output?.manifestDigest, digest);
  assert.equal(
    acknowledged.run.decisions.find((decision) => decision.id === retrospective.id)?.resolvedAt,
    undefined,
  );
  const close = acknowledged.run.decisions.find(
    (decision) => !decision.resolvedAt && decision.payload?.kind === 'output-review',
  )!;
  await writeFile(path.join(dir, 'artifacts/diff-stat.json'), '{"files":1}\n');
  await captureRunOutput(run.id, false);
  assert.equal(
    getRun(run.id)!.decisions.find((decision) => decision.id === close.id)?.resolvedAt,
    undefined,
  );
  assert.ok(
    getRun(run.id)!.output!.artifactManifest.some(
      (artifact) => artifact.path === 'artifacts/diff-stat.json',
    ),
  );
  const closed = await closeRunOutput(run.id, close.id, {
    publish: async (current) => current,
    releaseSlot: async () => ({ released: true }),
    slotOwner: async () => null,
  });
  assert.ok(closed.output?.closedAt);
  assert.deepEqual(closed.metrics, metrics);
  assert.deepEqual(closed.steps, steps);
  assert.equal(
    closed.decisions.find((decision) => decision.id === retrospective.id)?.resolvedAt,
    undefined,
  );
});

test('output digest excludes only top-level gateway diff diagnostics, retaining worker evidence', () => {
  const report = {
    path: 'artifacts/report.md',
    purpose: 'report' as const,
    sha256: 'report',
    sizeBytes: 1,
  };
  const digest = outputManifestDigest([report]);
  for (const name of [
    'diff.txt',
    'diff-stat.json',
    'iteration-diff.txt',
    'iteration-diff-stat.json',
  ]) {
    const diagnostic = { ...report, path: `artifacts/${name}` };
    assert.equal(outputManifestDigest([report, diagnostic]), digest);
    assert.equal(
      outputManifestDigest([report, { ...diagnostic, sha256: 'changed', sizeBytes: 2 }]),
      digest,
    );
    assert.notEqual(
      outputManifestDigest([report, { ...diagnostic, path: `artifacts/attempt-3/${name}` }]),
      digest,
    );
  }
  assert.notEqual(outputManifestDigest([{ ...report, sha256: 'changed' }]), digest);
  assert.notEqual(
    outputManifestDigest([report, { ...report, path: 'artifacts/qa-result.json' }]),
    digest,
  );
  assert.notEqual(outputManifestDigest([]), digest);
});

test('an override arriving during output verification invalidates both confirmation actions', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'output-override-fence-'));
  const reportFile = path.join(dir, 'artifacts/report.md');
  await mkdir(path.dirname(reportFile));
  await writeFile(reportFile, '# Finished report\n');
  const run = createRun({
    flowType: 'dev',
    project: 'generic-project',
    ticketOrPr: 'override-fence',
  });
  t.after(async () => {
    updateRun(run.id, { status: 'failed' });
    await deleteRun(run.id);
    await rm(dir, { recursive: true, force: true });
  });
  updateRun(run.id, {
    status: 'blocked',
    taskFile: path.join(dir, 'TASK.md'),
    completionPolicy: 'artifact-only',
    completedAt: new Date().toISOString(),
  });
  await captureRunOutput(run.id, false);
  const decision = getRun(run.id)!.decisions.find((entry) => !entry.resolvedAt)!;
  const retainedReportFile = path.join(
    await retainedRunTaskDirectory(getRun(run.id)!),
    'artifacts/report.md',
  );
  const originalRead = fsPromises.readFile;
  let inject = false;
  t.mock.method(fsPromises, 'readFile', async (...args: Parameters<typeof originalRead>) => {
    const result = await originalRead(...args);
    if (inject && String(args[0]) === retainedReportFile) {
      inject = false;
      updateRun(run.id, {
        decisions: getRun(run.id)!.decisions.map((entry) =>
          entry.id === decision.id && entry.payload?.kind === 'output-review'
            ? { ...entry, payload: { ...entry.payload, claimOverrideReceiptIds: ['new-receipt'] } }
            : entry,
        ),
      });
    }
    return result;
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  for (const actionId of ['mark-reviewed', 'close-run']) {
    updateRun(run.id, { decisions: [structuredClone(decision)] });
    const request = buildRunResolveDecisionParams({ runId: run.id, decision, actionId });
    inject = true;
    await assert.rejects(
      runResolveDecision(request, () => {}),
      /claim override review changed/,
    );
    assert.equal(getRun(run.id)!.decisions[0].resolvedAt, undefined);
    assert.equal(getRun(run.id)!.status, 'blocked');
  }
  for (const actionId of ['mark-reviewed', 'close-run']) {
    const staleRequest = buildRunResolveDecisionParams({ runId: run.id, decision, actionId });
    const current = structuredClone(decision);
    if (current.payload?.kind === 'output-review')
      current.payload.visualJudgmentReceiptIds = ['new-visual-review'];
    updateRun(run.id, { decisions: [current] });
    await assert.rejects(
      runResolveDecision(staleRequest, () => {}),
      /claim override review changed/,
    );
    assert.equal(getRun(run.id)!.decisions[0].resolvedAt, undefined);
  }
});

test('report review applies across projects and flows without changing outcome', () => {
  for (const flowType of ['qa', 'dev', 'fix-bug'] as const) {
    const run = makeRun({
      flowType,
      project: 'arbitrary-project',
      status: 'blocked',
      completionPolicy: 'artifact-only',
    });
    const decisions = outputReviewDecisions(run, output);
    assert.equal(decisions.length, 1);
    assert.equal(decisions[0].payload?.kind, 'output-review');
    assert.equal(run.status, 'blocked');
    assert.equal(outputReviewDecisions({ ...run, decisions }, output).length, 1);
    decisions[0].resolvedAt = new Date().toISOString();
    decisions[0].resolvedAction = 'mark-reviewed';
    assert.equal(decisions[0].payload?.kind, 'output-review');
    if (decisions[0].payload?.kind === 'output-review') {
      decisions[0].payload.visualJudgmentReceiptIds = ['qualified-review'];
      decisions[0].payload.claimOverrideReceiptIds = ['qualified-override'];
    }
    const acknowledged = outputReviewDecisions({ ...run, decisions }, output);
    assert.equal(acknowledged.length, 2);
    assert.deepEqual(acknowledged[1].payload, decisions[0].payload);
    assert.deepEqual(
      acknowledged[1].actions.map((action) => action.id),
      ['close-run'],
    );
    assert.equal(outputReviewDecisions({ ...run, decisions: acknowledged }, output).length, 2);
    const changed = outputReviewDecisions(
      { ...run, decisions },
      { ...output, manifestDigest: 'new' },
    );
    assert.equal(changed.filter((decision) => !decision.resolvedAt).length, 1);
    const payload = changed.at(-1)?.payload;
    assert.equal(payload?.kind, 'output-review');
    if (payload?.kind === 'output-review')
      assert.equal(payload.visualJudgmentReceiptIds, undefined);
  }
});

test('running output, eval packages and publication flows do not acquire an output gate', () => {
  const run = makeRun({ completionPolicy: 'artifact-only' });
  assert.equal(outputReviewDecisions(run, { ...output, workerFinished: false }).length, 0);
  assert.equal(outputReviewDecisions({ ...run, lane: 'comparison' }, output).length, 0);
  assert.equal(outputReviewDecisions({ ...run, completionPolicy: 'default' }, output).length, 0);
  assert.equal(
    outputReviewDecisions(run, { ...output, captureError: 'failed transfer' }).length,
    0,
  );
});

test('a failed manual refresh does not mark an active worker finished', async (t) => {
  const run = createRun({
    flowType: 'dev',
    project: 'generic-project',
    ticketOrPr: 'active-output',
  });
  t.after(async () => {
    updateRun(run.id, { status: 'failed' });
    await deleteRun(run.id);
  });
  updateRun(run.id, { status: 'monitoring' });
  const failed = failRunOutputCapture(run.id, new Error('Unavailable worker files'));
  assert.equal(failed.status, 'monitoring');
  assert.equal(failed.output?.workerFinished, false);
  updateRun(run.id, { status: 'dispatching', output: { ...failed.output!, workerFinished: true } });
  assert.equal(
    failRunOutputCapture(run.id, new Error('Retry failed')).output?.workerFinished,
    false,
    'an active retry must not inherit completion from its previous attempt',
  );
  // Completion only starts after the monitor has finished.
  updateRun(run.id, {
    status: 'completing',
    output: { ...failed.output!, workerFinished: true },
    steps: getRun(run.id)!.steps.map((step) =>
      step.name === 'monitor' ? { ...step, status: 'done' } : step,
    ),
  });
  assert.equal(
    failRunOutputCapture(run.id, new Error('Gate refresh failed')).output?.workerFinished,
    true,
    'a refresh failure during completion preserves the already observed worker terminal mark',
  );
});

test('capture follows the existing narrative report names for every flow', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'flow-output-'));
  await mkdir(path.join(dir, 'artifacts'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const cases = [
    ['qa', 'qa-report.md'],
    ['dev', 'pr-description.md'],
    ['fix-bug', 'pr-description.md'],
    ['review-pr', 'review.md'],
    ['pr-complete', 'comments-report.md'],
    ['update-branch', 'report.md'],
  ] as const;
  for (const [, name] of cases) await writeFile(path.join(dir, 'artifacts', name), `# ${name}\n`);
  for (const [flowType, name] of cases) {
    const run = createRun({
      flowType: 'dev',
      project: 'generic-project',
      ticketOrPr: 'report-name-test',
    });
    t.after(async () => {
      updateRun(run.id, { status: 'failed' });
      await deleteRun(run.id);
    });
    updateRun(run.id, {
      flowType,
      status: 'done',
      completionPolicy: 'artifact-only',
      taskFile: path.join(dir, 'TASK.md'),
    });
    await captureRunOutput(run.id, false);
    const captured = getRun(run.id)!;
    assert.equal(captured.output?.reportPath, `artifacts/${name}`, flowType);
    if (flowType === 'pr-complete') assert.equal(captured.decisions.length, 0);
    else assert.equal(captured.decisions[0].payload?.kind, 'output-review', flowType);
    if (name !== 'report.md') {
      await writeFile(path.join(dir, 'artifacts', name), '  \n');
      await captureRunOutput(run.id, false);
      assert.equal(
        getRun(run.id)?.output?.reportPath,
        'artifacts/report.md',
        `${flowType} skips a whitespace-only preferred report`,
      );
      await writeFile(path.join(dir, 'artifacts', name), `# ${name}\n`);
    }
  }
});

test('partial output review uses its frozen bytes and only an explicit capture advances them', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'run-output-'));
  await mkdir(path.join(dir, 'artifacts'));
  await writeFile(path.join(dir, 'artifacts/report.md'), '# Partial report\nOne gap remains.\n');
  await writeFile(path.join(dir, 'artifacts/coverage.json'), '{"passed":1,"untested":2}\n');
  const run = createRun({ flowType: 'dev', project: 'generic-project', ticketOrPr: 'output test' });
  t.after(async () => {
    if (getRun(run.id)) {
      updateRun(run.id, { status: 'failed' });
      await deleteRun(run.id);
    }
    await rm(dir, { recursive: true, force: true });
  });
  updateRun(run.id, {
    status: 'blocked',
    completedAt: new Date().toISOString(),
    taskFile: path.join(dir, 'TASK.md'),
    completionPolicy: 'artifact-only',
    metrics: { ...run.metrics, outcome: 'partial' },
    steps: [
      { name: 'monitor', status: 'done' },
      { name: 'complete', status: 'skipped' },
    ],
  });
  await captureRunOutput(run.id, false);
  const captured = getRun(run.id)!;
  assert.equal(captured.output?.artifactManifest.length, 2);
  const pending = captured.decisions.find((decision) => !decision.resolvedAt)!;
  const events: string[] = [];
  const result = await runResolveDecision(
    { runId: run.id, decisionId: pending.id, actionId: 'mark-reviewed' },
    (event) => events.push(event),
  );
  assert.equal(result.run.status, 'blocked');
  assert.equal(result.run.metrics.outcome, 'partial');
  assert.equal(result.run.steps[1].status, 'skipped');
  assert.ok(events.includes('run.decision.resolved'));
  const close = result.run.decisions.find((decision) => !decision.resolvedAt)!;
  assert.deepEqual(
    close.actions.map((action) => action.id),
    ['close-run'],
  );
  assert.equal(
    result.run.decisions.find((decision) => decision.id === pending.id)?.resolvedAction,
    'mark-reviewed',
  );
  assert.equal(getRun(run.id)?.status, 'blocked');
  await writeFile(path.join(dir, 'artifacts/report.md'), '# Changed report\n');
  await captureRunOutput(run.id, false);
  const next = getRun(run.id)!.decisions.find((decision) => !decision.resolvedAt)!;
  await writeFile(path.join(dir, 'artifacts/coverage.json'), '{"passed":0}\n');
  const pinned = structuredClone(getRun(run.id)!.output?.artifactBundle);
  await runResolveDecision(
    { runId: run.id, decisionId: next.id, actionId: 'mark-reviewed' },
    () => {},
  );
  assert.ok(getRun(run.id)!.decisions.find((decision) => decision.id === next.id)?.resolvedAt);
  assert.deepEqual(getRun(run.id)!.output?.artifactBundle, pinned);
  updateRun(run.id, { status: 'paused', completedAt: undefined });
  await captureRunOutput(run.id, false);
  assert.equal(
    getRun(run.id)?.output?.workerFinished,
    true,
    'refresh preserves a finished worker at an operator hold',
  );
  updateRun(run.id, { status: 'monitoring' });
  await captureRunOutput(run.id, false);
  assert.equal(
    getRun(run.id)?.output?.workerFinished,
    true,
    'refresh preserves terminal capture before monitor routes the run status',
  );
  const reviewBeforeFailure = getRun(run.id)!.decisions.find((decision) => !decision.resolvedAt)!;
  failRunOutputCapture(run.id, new Error('Could not fingerprint output'));
  assert.equal(getRun(run.id)?.output?.captureError, 'Could not fingerprint output');
  assert.equal(getRun(run.id)?.output?.artifactManifest.length, 2);
  assert.equal(
    getRun(run.id)!.decisions.find((d) => d.id === reviewBeforeFailure.id)?.resolvedAction,
    'superseded',
  );
  assert.equal(
    getRun(run.id)!.decisions.some((d) => !d.resolvedAt),
    false,
  );
  await captureRunOutput(run.id, false);
  assert.equal(getRun(run.id)?.output?.captureError, undefined);
  assert.ok(
    getRun(run.id)!.decisions.some((d) => !d.resolvedAt && d.id !== reviewBeforeFailure.id),
  );
  updateRun(run.id, {
    status: 'monitoring',
    completedAt: undefined,
    output: { ...getRun(run.id)!.output!, workerFinished: false },
  });
  const inFlight = captureRunOutput(run.id, false);
  updateRun(run.id, {
    status: 'blocked',
    output: { ...getRun(run.id)!.output!, workerFinished: true },
  });
  await inFlight;
  assert.equal(
    getRun(run.id)?.output?.workerFinished,
    true,
    'refresh uses completion recorded while artifact IO was in flight',
  );
  updateRun(run.id, { status: 'cancelled' });
  const decisionsBefore = getRun(run.id)!.decisions.length;
  await captureRunOutput(run.id, false);
  assert.equal(
    getRun(run.id)?.output?.artifactManifest.length,
    2,
    'cancelled runs keep readable output',
  );
  assert.equal(
    getRun(run.id)!.decisions.length,
    decisionsBefore,
    'cancel does not introduce another gate',
  );
});

test('QA with every step done or skipped keeps close available after acknowledgement', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'qa-reviewed-output-'));
  await mkdir(path.join(dir, 'artifacts'));
  await writeFile(
    path.join(dir, 'artifacts/qa-report.md'),
    '# QA partial output\nUnproved criteria remain.\n',
  );
  const run = createRun({ flowType: 'dev', project: 'generic-project', ticketOrPr: 'QA-123' });
  t.after(async () => {
    updateRun(run.id, { status: 'done' });
    await deleteRun(run.id);
    await rm(dir, { recursive: true, force: true });
  });
  updateRun(run.id, {
    flowType: 'qa',
    status: 'blocked',
    taskFile: path.join(dir, 'TASK.md'),
    completionPolicy: 'artifact-only',
    completedAt: new Date().toISOString(),
    metrics: { ...run.metrics, outcome: 'partial' },
    steps: [
      { name: 'monitor', status: 'done' },
      { name: 'complete', status: 'skipped' },
    ],
  });
  await captureRunOutput(run.id, false);
  const initial = getRun(run.id)!;
  const originalSteps = structuredClone(initial.steps);
  const review = initial.decisions.find((decision) => !decision.resolvedAt)!;
  const acknowledged = await runResolveDecision(
    { runId: run.id, decisionId: review.id, actionId: 'mark-reviewed' },
    () => {},
  );
  assert.equal(acknowledged.run.status, 'blocked');
  const close = acknowledged.run.decisions.find((decision) => !decision.resolvedAt)!;
  assert.deepEqual(
    close.actions.map((action) => action.id),
    ['close-run'],
  );
  const closed = await closeRunOutput(run.id, close.id, {
    publish: async (run) => run,
    releaseSlot: async () => ({ released: false }),
    slotOwner: async () => null,
  });
  assert.equal(closed.status, 'done');
  assert.equal(closed.metrics.outcome, 'partial');
  assert.deepEqual(closed.steps, originalSteps);
  assert.equal(closed.decisions.filter((decision) => !decision.resolvedAt).length, 0);
});

// F304: run 67feec52's parity evidence included `queryUiTarget__textContains-Tokens-…json`. The
// retained bundle skips any name containing `token`, so every close and acknowledgement refused
// with "Run output changed" although nothing had changed.
test('a capture holding a file the bundle never retains still reviews and closes', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'output-review-excluded-'));
  await mkdir(path.join(dir, 'artifacts/parity'), { recursive: true });
  await writeFile(path.join(dir, 'artifacts/report.md'), '# Spike report\nAll criteria pass.\n');
  await writeFile(
    path.join(dir, 'artifacts/parity/queryUiTarget__textContains-Tokens-tree.json'),
    '{"present":true}\n',
  );
  const run = createRun({ flowType: 'dev', project: 'generic-project', ticketOrPr: 'F304' });
  t.after(async () => {
    updateRun(run.id, { status: 'done' });
    await deleteRun(run.id);
    await rm(dir, { recursive: true, force: true });
  });
  updateRun(run.id, {
    status: 'blocked',
    taskFile: path.join(dir, 'TASK.md'),
    completionPolicy: 'artifact-only',
    completedAt: new Date().toISOString(),
    metrics: { ...run.metrics, outcome: 'success' },
    steps: [
      { name: 'monitor', status: 'done' },
      { name: 'complete', status: 'skipped' },
    ],
  });
  await captureRunOutput(run.id, false);
  const captured = getRun(run.id)!;
  assert.equal(captured.output?.artifactManifest.length, 2, 'the capture lists both files');
  const review = captured.decisions.find((decision) => !decision.resolvedAt)!;
  const acknowledged = await runResolveDecision(
    { runId: run.id, decisionId: review.id, actionId: 'mark-reviewed' },
    () => {},
  );
  const close = acknowledged.run.decisions.find((decision) => !decision.resolvedAt)!;
  const closed = await closeRunOutput(run.id, close.id, {
    publish: async (run) => run,
    releaseSlot: async () => ({ released: false }),
    slotOwner: async () => null,
  });
  assert.equal(closed.status, 'done');

  // Any other difference from the reviewed capture still refuses.
  const reopened = createRun({ flowType: 'dev', project: 'generic-project', ticketOrPr: 'F304b' });
  t.after(async () => {
    updateRun(reopened.id, { status: 'done' });
    await deleteRun(reopened.id);
  });
  updateRun(reopened.id, {
    status: 'blocked',
    taskFile: path.join(dir, 'TASK.md'),
    completionPolicy: 'artifact-only',
    completedAt: new Date().toISOString(),
    steps: [
      { name: 'monitor', status: 'done' },
      { name: 'complete', status: 'skipped' },
    ],
  });
  await captureRunOutput(reopened.id, false);
  const pending = getRun(reopened.id)!.decisions.find((decision) => !decision.resolvedAt)!;
  const tampered = getRun(reopened.id)!.output!;
  updateRun(reopened.id, {
    output: {
      ...tampered,
      artifactManifest: tampered.artifactManifest.map((artifact) =>
        artifact.path === 'artifacts/report.md' ? { ...artifact, sizeBytes: 1 } : artifact,
      ),
    },
  });
  await assert.rejects(
    verifyRunOutputReview(reopened.id, pending.id),
    /Run output changed; refresh the report before reviewing/,
  );
});

// F305: run e8f6b0bc's replayed review and its recovered review gate captured the output at the
// same time. Both started from the same committed bundle, and the one that committed second
// failed the review step with "A newer retained capture committed".
test('two overlapping captures of one run both succeed, the later one committed last', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'output-capture-overlap-'));
  await mkdir(path.join(dir, 'artifacts'));
  await writeFile(path.join(dir, 'artifacts/report.md'), '# Report\nDone.\n');
  await writeFile(path.join(dir, 'artifacts/first.png'), 'first image bytes');
  const run = createRun({ flowType: 'dev', project: 'generic-project', ticketOrPr: 'F305' });
  t.after(async () => {
    updateRun(run.id, { status: 'done' });
    await deleteRun(run.id);
    await rm(dir, { recursive: true, force: true });
  });
  updateRun(run.id, {
    status: 'blocked',
    taskFile: path.join(dir, 'TASK.md'),
    completionPolicy: 'artifact-only',
    completedAt: new Date().toISOString(),
    steps: [
      { name: 'monitor', status: 'done' },
      { name: 'complete', status: 'skipped' },
    ],
  });
  const gated = gatedAcquisition(run.id);
  const first = captureRunOutput(run.id, false, false, { acquisition: gated.acquisition });
  await gated.reached;
  await writeFile(path.join(dir, 'artifacts/second.png'), 'second image bytes');
  const second = captureRunOutput(run.id, false);
  // Unserialized, the second capture commits while the first waits, and the first then fails its
  // final commit; serialized, the second queues behind the first.
  let secondSettled = false;
  void second.then(
    () => (secondSettled = true),
    () => (secondSettled = true),
  );
  const deadline = Date.now() + 500;
  while (!secondSettled && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 10));
  gated.release();
  await first;
  await second;
  assert.ok(
    getRun(run.id)!.output?.artifactManifest.some(
      (artifact) => artifact.path === 'artifacts/second.png',
    ),
    'the later capture is the committed one',
  );
});

test('a capture queued behind another still refuses once its attempt changed', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'output-capture-queued-attempt-'));
  await mkdir(path.join(dir, 'artifacts'));
  await writeFile(path.join(dir, 'artifacts/report.md'), '# Report\nDone.\n');
  await writeFile(path.join(dir, 'artifacts/first.png'), 'first image bytes');
  const run = createRun({ flowType: 'dev', project: 'generic-project', ticketOrPr: 'F305' });
  t.after(async () => {
    updateRun(run.id, { status: 'done' });
    await deleteRun(run.id);
    await rm(dir, { recursive: true, force: true });
  });
  updateRun(run.id, {
    status: 'monitoring',
    taskFile: path.join(dir, 'TASK.md'),
    engineState: { generation: 1 },
  });
  const gated = gatedAcquisition(run.id);
  const first = captureRunOutput(run.id, false, false, { acquisition: gated.acquisition });
  const second = captureRunOutput(run.id, false, true);
  updateRun(run.id, { engineState: { generation: 2 } });
  gated.release();
  await assert.rejects(first, /attempt changed/);
  await assert.rejects(second, /attempt changed/);
  assert.equal(getRun(run.id)!.output, undefined);
});

// F243: run f74906ee's reviewer re-captured its output while `reviewing`, which read as a
// running worker, retired the output review and left COMPLETE refusing for good.
test('a reviewer or refresh capture keeps the artifact-only output review COMPLETE reads', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'output-review-route-'));
  await mkdir(path.join(dir, 'artifacts'));
  await writeFile(
    path.join(dir, 'artifacts/pr-description.md'),
    '# Fixed\nCriteria await review.\n',
  );
  const run = createRun({ flowType: 'dev', project: 'generic-project', ticketOrPr: 'TAT-3216' });
  t.after(async () => {
    if (getRun(run.id)) {
      updateRun(run.id, { status: 'failed' });
      await deleteRun(run.id);
    }
    await rm(dir, { recursive: true, force: true });
  });
  const finished = {
    name: 'monitor',
    status: 'done' as const,
    outputs: { workerSignal: { status: 'complete' } },
  };
  updateRun(run.id, {
    status: 'monitoring',
    lane: 'validation',
    completionPolicy: 'artifact-only',
    taskFile: path.join(dir, 'TASK.md'),
    steps: [
      finished,
      { name: 'review', status: 'pending' },
      { name: 'complete', status: 'pending' },
    ],
  });
  const pendingReview = () =>
    getRun(run.id)!.decisions.filter((d) => !d.resolvedAt && d.payload?.kind === 'output-review');

  await captureRunOutput(run.id, false, true);
  const [gate] = pendingReview();
  assert.ok(gate, 'the finished worker raises the output review');

  updateRun(run.id, { status: 'reviewing' });
  await captureRunOutput(run.id);
  assert.equal(getRun(run.id)!.output?.workerFinished, true);
  assert.deepEqual(
    pendingReview().map((d) => d.id),
    [gate.id],
    'the reviewer capture keeps the same pending output review',
  );
  await verifyRunOutputReview(run.id, gate.id, true);

  // The state f74906ee was left in: a downgraded capture, no output review, a waiting result.
  updateRun(run.id, {
    status: 'needs-decision',
    output: { ...getRun(run.id)!.output!, workerFinished: false },
    decisions: [],
  });
  await captureRunOutput(run.id);
  assert.equal(pendingReview().length, 1, 'a refresh restores the output review COMPLETE needs');
  assert.equal(getRun(run.id)!.output?.workerFinished, true);

  // Send-back relaunches the worker into a fresh monitor; its last capture still says finished.
  updateRun(run.id, {
    status: 'monitoring',
    steps: [{ name: 'monitor', status: 'running' }, ...getRun(run.id)!.steps.slice(1)],
  });
  await captureRunOutput(run.id);
  assert.equal(getRun(run.id)!.output?.workerFinished, false, 'a re-entered monitor is running');
  assert.equal(pendingReview().length, 0);
  updateRun(run.id, { status: 'fixing', steps: [finished, ...getRun(run.id)!.steps.slice(1)] });
  await captureRunOutput(run.id);
  assert.equal(getRun(run.id)!.output?.workerFinished, false, 'a review fix worker is running');
});
