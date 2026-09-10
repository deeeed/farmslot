import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import type { PRProjectMonitorPolicy, Run } from '@farmslot/protocol';

import { recordRunPRPublication } from '../integrations/pr-linkage.js';
import { makeRun } from '../run-engine/test-fixtures.js';
import { createRun, deleteRun, getRun, updateRun } from '../runs/store.js';

import { PRPublicationEnrollment } from './publication.js';
import { PRMonitorStore } from './store.js';

const config: PRProjectMonitorPolicy['config'] = {
  account: { host: 'github.com', login: 'reader' },
  policy: { mode: 'notify-only' },
  pollIntervalMs: 300_000,
  watchedChecks: [],
  automaticAttemptLimit: 2,
  cooldownMs: 300_000,
};
function published(id: string, publishedAt: string, number = 1): Run {
  return {
    ...makeRun({ id, project: 'project', flowType: 'dev', status: 'done', slotId: null }),
    prPublications: [{ pr: { host: 'github.com', repo: 'owner/repo', number }, publishedAt }],
  };
}
function enrollment(store: PRMonitorStore, runs: Run[]) {
  return new PRPublicationEnrollment(
    store,
    { enrolled: async (id, ownerId) => store.get(id, ownerId) },
    () => true,
    () => runs,
    async () => 'owner/repo',
  );
}
async function fixture(t: test.TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'pr-publication-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'monitors.json');
  return { file, store: await PRMonitorStore.load(file) };
}

test('publication monitoring is opt-in and does not import historical publications or discovered PRs', async (t) => {
  const { store } = await fixture(t);
  const old = published('old', '2020-01-01T00:00:00.000Z');
  const discovery = makeRun({ id: 'review', flowType: 'review-pr', prNumber: 2 });
  const runs = [old, discovery];
  const service = enrollment(store, runs);
  await service.reconcile();
  assert.equal(store.list('owner').length, 0);
  const policy = await store.saveProjectPolicy('owner', 'project', true, config);
  runs.push(published('new', policy.activatedAt, 3));
  await service.reconcile();
  assert.equal(store.list('owner').length, 1);
  assert.equal(store.list('owner')[0].config.pr.number, 3);
  assert.deepEqual(store.list('owner')[0].originatingRunIds, ['new']);
  assert.equal(store.list('owner')[0].config.policy.mode, 'notify-only');
});

test('project edits do not re-enroll prior publications or upgrade existing per-PR policy', async (t) => {
  const { store } = await fixture(t);
  const policy = await store.saveProjectPolicy('owner', 'project', true, config);
  const runs = [published('run', policy.activatedAt)];
  const service = enrollment(store, runs);
  await service.reconcile();
  await store.saveProjectPolicy(
    'owner',
    'project',
    true,
    {
      ...config,
      policy: {
        mode: 'automatic-repair',
        execution: {
          slotPolicy: { kind: 'exact', slotId: 'slot' },
          models: [{ runner: 'codex', model: 'gpt-6-astra' }],
        },
      },
    },
    policy.revision,
  );
  await service.reconcile();
  assert.equal(store.list('owner').length, 1);
  assert.equal(store.list('owner')[0].config.policy.mode, 'notify-only');
  assert.equal(store.snapshot().publicationEnrollments?.length, 1);
});

test('failed atomic enrollment publishes neither a monitor nor a receipt and restart retries once', async (t) => {
  const { file, store } = await fixture(t);
  const policy = await store.saveProjectPolicy('owner', 'project', true, config);
  const runs = [published('run', policy.activatedAt)];
  await rename(file, `${file}.saved`);
  await mkdir(file);
  const interrupted = enrollment(store, runs);
  await interrupted.reconcile();
  assert(interrupted.errors('owner').project);
  assert.deepEqual(interrupted.errors('someone-else'), {});
  assert.equal(store.list('owner').length, 0);
  assert.equal(store.snapshot().publicationEnrollments?.length ?? 0, 0);
  await rm(file, { recursive: true });
  await rename(`${file}.saved`, file);
  const recovered = await PRMonitorStore.load(file);
  await enrollment(recovered, runs).reconcile();
  assert.equal(recovered.list('owner').length, 1);
  assert.equal(recovered.snapshot().publicationEnrollments?.length, 1);
});

test('project opt-in does not enroll publications from another project sharing the repository', async (t) => {
  const { store } = await fixture(t);
  const policy = await store.saveProjectPolicy('owner', 'project', true, config);
  await enrollment(store, [
    { ...published('other', policy.activatedAt), project: 'other-project' },
  ]).reconcile();
  assert.equal(store.list('owner').length, 0);
});

test('a queued disable or downgrade wins before the enrollment transaction starts', async (t) => {
  const { store } = await fixture(t);
  const policy = await store.saveProjectPolicy('owner', 'project', true, config);
  const run = published('run', policy.activatedAt);
  const disable = store.saveProjectPolicy('owner', 'project', false, config, policy.revision);
  const subscribe = store.enrollPublication(
    'owner',
    'project',
    policy.revision,
    run,
    run.prPublications![0],
    () => true,
  );
  await disable;
  assert.equal(await subscribe, undefined);
  assert.equal(store.list('owner').length, 0);
});

test('publication records are idempotent and excluded from review/artifact-only flows', async (t) => {
  const producer = createRun({
    flowType: 'dev',
    project: 'project',
    ticketOrPr: 'PUBLICATION-RECORD',
  });
  const reviewer = createRun({
    flowType: 'review-pr',
    project: 'project',
    ticketOrPr: 'owner/repo#701',
  });
  const artifact = createRun({
    flowType: 'dev',
    project: 'project',
    ticketOrPr: 'PUBLICATION-ARTIFACT',
    completionPolicy: 'artifact-only',
  });
  t.after(async () => {
    for (const run of [producer, reviewer, artifact]) {
      updateRun(run.id, { status: 'done' });
      await deleteRun(run.id);
    }
  });
  recordRunPRPublication(producer.id, 'owner/repo', 702);
  recordRunPRPublication(producer.id, 'Owner/Repo', 702);
  recordRunPRPublication(reviewer.id, 'owner/repo', 701);
  recordRunPRPublication(artifact.id, 'owner/repo', 703);
  assert.equal(getRun(producer.id)?.prPublications?.length, 1);
  assert.equal(getRun(reviewer.id)?.prPublications, undefined);
  assert.equal(getRun(artifact.id)?.prPublications, undefined);
});
