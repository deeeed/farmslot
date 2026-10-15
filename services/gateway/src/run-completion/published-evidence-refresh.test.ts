import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { mock, test } from 'node:test';

import type { ReadyGatePrPackage, RunDecision } from '@farmslot/protocol';

await import('../runtime/mock-pty.test-support.js');
const github = await import('../integrations/github-client.js');
mock.module('../integrations/github-client.js', {
  namedExports: {
    ...github,
    ghRequest: async () => {
      throw new Error('Unexpected external GitHub call in frozen-evidence refusal test.');
    },
  },
});
const { deleteTestRunIfPresent, retainRunFixture, overwriteRetainedFixture } =
  await import('../run-engine/test-fixtures.js');
const { createRun, getRun, updateRun } = await import('../runs/store.js');
const { refreshPublishedEvidence } = await import('./published-evidence-refresh.js');
const { computeReadyGatePackageHash, sha256Text } = await import('./ready-gate-package.js');

test('published evidence refresh rejects unpublished, active and imported runs without reopening them', async (t) => {
  const run = createRun({
    flowType: 'dev',
    mode: 'autonomous',
    project: 'farmslot-farm',
    ticketOrPr: 'PROJ-1',
    runner: 'scripted',
  });
  t.after(async () => deleteTestRunIfPresent(run.id));
  const events: string[] = [];
  const emit = (event: string) => events.push(event);
  await assert.rejects(refreshPublishedEvidence({ runId: run.id }, emit), /already published/);
  updateRun(run.id, {
    prNumber: 1,
    status: 'ci-watching',
    engineState: { publishGate: { publicationStatus: 'published_ready' } },
  });
  await assert.rejects(
    refreshPublishedEvidence({ runId: run.id }, emit),
    /Wait for the published run/,
  );
  assert.equal(getRun(run.id)?.status, 'ci-watching');
  updateRun(run.id, { status: 'done', readOnly: true });
  await assert.rejects(refreshPublishedEvidence({ runId: run.id }, emit), /Imported runs/);
  assert.equal(getRun(run.id)?.status, 'done');
  assert.deepEqual(events, []);
});

test('published refresh refuses a present but unapproved inventory item before external IO', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'published-selection-'));
  const run = createRun({
    flowType: 'dev',
    mode: 'autonomous',
    project: 'farmslot-farm',
    ticketOrPr: 'PROJ-2',
    runner: 'scripted',
  });
  t.after(async () => {
    await deleteTestRunIfPresent(run.id);
    await rm(root, { recursive: true, force: true });
  });
  await mkdir(path.join(root, 'artifacts'));
  const manifest = JSON.stringify({
    version: 1,
    standalone: [
      { label: 'Approved', file: 'approved.png' },
      { label: 'Unselected', file: 'unselected.png' },
    ],
  });
  await writeFile(path.join(root, 'artifacts/evidence-manifest.json'), manifest);
  const prepared = {
    selectedEvidenceKeys: ['artifacts/approved.png'],
    evidenceManifest: [
      { path: 'artifacts/approved.png', purpose: 'screenshot', sha256: sha256Text('approved') },
      { path: 'artifacts/unselected.png', purpose: 'screenshot', sha256: sha256Text('unselected') },
      {
        path: 'artifacts/evidence-manifest.json',
        purpose: 'evidence-manifest',
        sha256: sha256Text(manifest),
      },
    ],
  } as ReadyGatePrPackage;
  prepared.packageHash = computeReadyGatePackageHash(prepared);
  updateRun(run.id, {
    status: 'done',
    prNumber: 1,
    taskFile: path.join(root, 'TASK.md'),
    engineState: { publishGate: { publicationStatus: 'published_ready' } },
    decisions: [
      {
        id: 'approved',
        type: 'engine_human_gate',
        title: 'Publish reviewed evidence',
        description: 'Retained publication selection',
        actions: [],
        createdAt: new Date().toISOString(),
        resolvedAt: new Date().toISOString(),
        resolvedAction: 'approve-publish',
        payload: {
          kind: 'ready',
          prNumber: 1,
          repo: 'example/project',
          diffStat: { files: 0, additions: 0, deletions: 0 },
          workerReport: '',
          branch: 'feat/evidence',
          prPackage: prepared,
        },
      },
    ] satisfies RunDecision[],
  });
  await retainRunFixture(getRun(run.id)!, prepared);
  await assert.rejects(
    refreshPublishedEvidence(
      { runId: run.id, selectedEvidenceKeys: ['artifacts/unselected.png'] },
      () => {},
    ),
    /selection was not approved/,
  );
  assert.equal(
    getRun(run.id)?.decisions[0]?.payload && JSON.stringify(getRun(run.id)?.decisions[0]?.payload),
    JSON.stringify({
      kind: 'ready',
      prNumber: 1,
      repo: 'example/project',
      diffStat: { files: 0, additions: 0, deletions: 0 },
      workerReport: '',
      branch: 'feat/evidence',
      prPackage: prepared,
    }),
  );
  await overwriteRetainedFixture(
    getRun(run.id)!,
    'artifacts/evidence-manifest.json',
    JSON.stringify({ version: 1, standalone: [{ label: 'Replacement', file: 'unselected.png' }] }),
  );
  await assert.rejects(
    refreshPublishedEvidence({ runId: run.id }, () => {}),
    /hash mismatch/,
  );
});
