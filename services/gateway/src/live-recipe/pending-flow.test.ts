import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createEvidenceReviewModel, runEvidenceView } from '@farmslot/adapter-sdk/evidence';
import { Methods, RECIPE_ACTION_MANIFEST_SCHEMA_URL } from '@farmslot/protocol';
import { createRecipeRunner, RECIPE_PENDING_FLOW_FILE } from '@farmslot/recipe-runner';

const root = await mkdtemp(path.join(tmpdir(), 'gateway-pending-flow-'));
process.env.FARMSLOT_HOME = path.join(root, 'home');
process.env.FARMSLOT_ROOT = root;
process.env.FARMSLOT_RUNS_DIR = path.join(root, 'runs');
for (const file of ['CLAUDE.md', 'scripts/dev.sh', 'services/gateway/package.json']) {
  const absolute = path.join(root, file);
  await mkdir(path.dirname(absolute), { recursive: true });
  await writeFile(absolute, file.endsWith('.json') ? '{}' : '');
}
await import('../runtime/mock-pty.test-support.js');
const { createRun, persistRunNow, updateRun } = await import('../runs/store.js');
const { routeRunMethod } = await import('../server/run-route.js');
const { resourceRevisions } = await import('../resources/revisions.js');
const { workspaceObservations } = await import('../resources/workspace-observations.js');
const { captureRunOutput } = await import('../run-completion/output.js');

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test('run evidence follows only the gateway-bound HUD-off attempt', async (t) => {
  t.after(async () => {
    workspaceObservations.dispose();
    await rm(root, { recursive: true, force: true });
  });
  const taskFile = path.join(root, 'TASK.md');
  const attempt = 'recipe-gateway-fixture';
  const directory = path.join(root, 'artifacts', 'recipe-runs', attempt);
  await mkdir(directory, { recursive: true });
  await writeFile(taskFile, '# Gateway-owned attempt\n');
  const { id } = createRun(
    {
      project: 'farmslot-farm',
      flowType: 'dev',
      mode: 'interactive',
      ticketOrPr: 'PENDING-FLOW',
    },
    { deferBackgroundPersist: true },
  );
  const liveRecipeContext = {
    source: 'recipe-run-live',
    recipeRunId: attempt,
    artifactRoot: directory,
    artifactManifest: null,
    recipeJson: null,
    recipeQualityArtifact: null,
    qualityReport: null,
    workerLearnings: null,
    isStale: false,
    selectionReason: 'latest-run',
  } as const;
  await persistRunNow(updateRun(id, { status: 'monitoring', taskFile, liveRecipeContext }));

  const unexpected = () => assert.fail('An evidence read cannot emit a run mutation');
  async function read(overrides = {}) {
    const response = await routeRunMethod(
      Methods.RUN_RECIPE_RUNS_FOR_RUN,
      { runId: id, includeRecordedEvidence: true, ...overrides },
      { emit: unexpected, broadcast: unexpected },
    );
    assert(response.handled);
    return response.value as import('@farmslot/protocol').RunRecipeRunsForRunResult;
  }
  const nextFileRevision = () => {
    const key = { family: 'artifacts', runId: id } as const;
    const prior = resourceRevisions.revision(key);
    return new Promise<void>((resolve) => {
      const unsubscribe = resourceRevisions.subscribe(({ changes }) => {
        if (
          changes.some(
            ({ key, revision }) =>
              key.family === 'artifacts' && key.runId === id && revision > prior,
          )
        ) {
          unsubscribe();
          resolve();
        }
      });
      t.after(unsubscribe);
    });
  };

  assert.equal((await read()).pendingFlow, undefined);
  const first = { action: 'app.status', intent: 'Read current status.', next: 'second' };
  const second = { action: 'app.status', intent: 'Check again.', next: 'done' };
  const end = { action: 'end', status: 'pass' };
  const entered = [deferred(), deferred()];
  const release = [deferred(), deferred()];
  let calls = 0;
  const runner = createRecipeRunner({
    actionManifest: {
      $schema: RECIPE_ACTION_MANIFEST_SCHEMA_URL,
      actions: {
        'app.status': {
          description: 'Pause at a fixture step.',
          schema: { type: 'object', properties: {}, additionalProperties: false },
          examples: [first],
        },
        end: { description: 'Finish.', examples: [end] },
      },
    },
    hud: false,
    defaultSource: { kind: 'operator', trust: 'trusted' },
    adapters: [
      {
        action: 'app.status',
        source: { kind: 'bundled', trust: 'trusted' },
        async execute() {
          const next = calls++;
          entered[next]!.resolve();
          await release[next]!.promise;
          return { output: { ready: true } };
        },
      },
    ],
  });
  const firstPublished = nextFileRevision();
  const running = runner.run({
    recipeDocument: {
      $schema: 'https://farmslot.io/schemas/recipe-v1.schema.json',
      title: 'Show both held actions with HUD off',
      workflow: { entry: 'hold', nodes: { hold: first, second, done: end } },
    },
    projectRoot: root,
    artifactsDir: directory,
    recordVideo: false,
    recordingReason: 'Headless evidence fixture.',
  });
  const sidecar = path.join(directory, RECIPE_PENDING_FLOW_FILE);
  let valid: string;
  try {
    await Promise.race([
      entered[0]!.promise,
      running.then(() => assert.fail('First hold missing')),
    ]);
    await firstPublished;
    const firstRead = await read();
    const pending = runEvidenceView(
      createEvidenceReviewModel({
        evidencePending: true,
        pendingFlow: firstRead.pendingFlow,
      }),
    );
    assert.equal(pending.flow?.activeId, 'hold');
    assert.equal(pending.steps.length, 0);
    const executionId = pending.flow?.recipeRunId;
    assert(executionId);
    assert.notEqual(executionId, attempt);
    assert.equal(firstRead.recordedEvidence?.input, undefined);
    assert.equal((await read({ includeRecordedEvidence: false })).pendingFlow, undefined);
    await assert.rejects(read({ decisionId: 'unknown' }), /retained decision no longer exists/);
    assert.equal((await read({ recordedRecipeRunId: 'other-execution' })).pendingFlow, undefined);

    const before = resourceRevisions.revision({ family: 'run', runId: id });
    const changed = nextFileRevision();
    release[0]!.resolve();
    await entered[1]!.promise;
    await changed;
    const secondRead = await read();
    assert.equal(secondRead.pendingFlow?.update.activeId, 'second');
    assert.equal(secondRead.pendingFlow?.update.recipeRunId, executionId);
    assert.equal(resourceRevisions.revision({ family: 'run', runId: id }), before);

    valid = await readFile(sidecar, 'utf8');
    const mismatched = { ...JSON.parse(valid), recipeRunId: 'different-execution' };
    const mismatch = nextFileRevision();
    await writeFile(sidecar + '.test', JSON.stringify(mismatched));
    await rename(sidecar + '.test', sidecar);
    await mismatch;
    assert.equal((await read()).pendingFlow, undefined);
    updateRun(id, { liveRecipeContext: { ...liveRecipeContext, isStale: true } });
    await writeFile(sidecar, valid);
    assert.equal((await read()).pendingFlow, undefined);
  } finally {
    for (const gate of release) gate.resolve();
    await running;
  }
  await writeFile(path.join(root, 'artifacts', 'report.html'), '<h1>Retained report</h1>');
  await captureRunOutput(id, false, true);
  const retained = await read();
  assert.equal(retained.pendingFlow, undefined);
  assert.ok(retained.recordedEvidence?.report?.artifactBundle);
  assert.ok(
    retained.recordedEvidence.report.artifactManifest?.some(
      ({ path }) => path === 'artifacts/report.html',
    ),
  );
});
