import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import type { ResourceKey } from '@farmslot/protocol/client-cache';

import { readWithResourceState, resourceRevisions } from '../resources/revisions.js';

import {
  archiveRun,
  buildRunRecord,
  commitRunGraphAttachment,
  commitRunPublication,
  createRun,
  deleteArchivedRun,
  deleteRun,
  discardUndurableRun,
  getRun,
  getRunWithArchived,
  listRuns,
  persistRunNow,
  updateQaFollowUp,
  updateReviewPublication,
  updateRun,
  updateRunStep,
} from './store.js';

test('building a provisional run does not advance committed collection revisions', () => {
  const before = resourceRevisions.revision({ family: 'runs', scope: 'farm' });
  const run = buildRunRecord({ flowType: 'dev', project: 'demo', ticketOrPr: randomUUID() });
  assert.equal(getRun(run.id), undefined);
  assert.equal(resourceRevisions.revision({ family: 'runs', scope: 'farm' }), before);
});

test('actual run writes invalidate old and new filtered membership after facts are readable', async (t) => {
  const before = resourceRevisions.revision({ family: 'runs', scope: 'farm' });
  const run = createRun({ flowType: 'dev', project: 'demo', ticketOrPr: randomUUID() });
  t.after(async () => {
    if (!getRun(run.id)) return;
    await persistRunNow(run);
    await discardUndurableRun(run.id);
  });
  assert.equal(resourceRevisions.revision({ family: 'runs', scope: 'farm' }), before + 1);
  const originalFamily = run.familyId;
  const targetFamily = randomUUID();
  const key = { family: 'run', runId: run.id } as const;
  const revision = resourceRevisions.revision(key);
  const response = await readWithResourceState([key], async () => {
    updateRun(run.id, { familyId: targetFamily });
    return getRun(run.id);
  });
  assert.equal(response.resourceState.dependencies[0].revision, revision);
  assert.equal(response.payload?.familyId, targetFamily);
  assert.equal(resourceRevisions.revision(key), revision + 1);
  assert.equal(resourceRevisions.revision({ family: 'family', familyId: originalFamily }), 2);
  assert.equal(resourceRevisions.revision({ family: 'family', familyId: targetFamily }), 1);
  assert(!listRuns({ familyId: originalFamily }).runs.some((entry) => entry.id === run.id));
  assert(listRuns({ familyId: targetFamily }).runs.some((entry) => entry.id === run.id));
});

test('step writes advance run observations, while a refused step write does not', async (t) => {
  const run = createRun({ flowType: 'dev', project: 'demo', ticketOrPr: randomUUID() });
  t.after(async () => {
    await persistRunNow(run);
    await discardUndurableRun(run.id);
  });
  updateRun(run.id, { steps: [{ name: 'proof', status: 'pending' }] });
  const key = { family: 'run', runId: run.id } as const;
  const before = resourceRevisions.revision(key);
  updateRunStep(run.id, 'proof', { status: 'done', detail: 'real stored progress' });
  assert.equal(getRun(run.id)?.steps[0].status, 'done');
  assert.equal(resourceRevisions.revision(key), before + 1);
  assert.throws(() => updateRunStep(run.id, 'missing', { status: 'done' }), /Step not found/);
  assert.equal(resourceRevisions.revision(key), before + 1);
});

test('archive and permanent deletion advance their distinct readable states', async (t) => {
  const run = createRun({ flowType: 'dev', project: 'demo', ticketOrPr: randomUUID() });
  t.after(async () => {
    if (getRun(run.id)) {
      await persistRunNow(run);
      await discardUndurableRun(run.id);
    }
    await deleteArchivedRun(run.id);
  });
  updateRun(run.id, { status: 'done' });
  await persistRunNow(run);
  const key = { family: 'run', runId: run.id } as const;
  const before = resourceRevisions.revision(key);
  assert.equal(await archiveRun(run.id), true);
  assert.equal(getRun(run.id), undefined);
  assert((await getRunWithArchived(run.id))?.archivedAt);
  assert.equal(resourceRevisions.revision(key), before + 1);
  assert.equal(await deleteArchivedRun(run.id), true);
  assert.equal(await getRunWithArchived(run.id), undefined);
  assert.equal(resourceRevisions.revision(key), before + 2);
});

test('deleting a live retained run invalidates its detail and list membership', async (t) => {
  const run = createRun({ flowType: 'dev', project: 'demo', ticketOrPr: randomUUID() });
  t.after(async () => {
    if (!getRun(run.id)) return;
    await persistRunNow(run);
    await discardUndurableRun(run.id);
  });
  updateRun(run.id, { status: 'done' });
  await persistRunNow(run);
  const key = { family: 'run', runId: run.id } as const;
  const before = resourceRevisions.revision(key);
  assert.equal(await deleteRun(run.id), true);
  assert.equal(getRun(run.id), undefined);
  assert(!listRuns().runs.some((entry) => entry.id === run.id));
  assert.equal(resourceRevisions.revision(key), before + 1);
});

for (const archived of [false, true]) {
  test(`durable publication, graph and review writes notify their ${archived ? 'archived' : 'live'} projections`, async (t) => {
    const run = createRun({ flowType: 'dev', project: 'demo', ticketOrPr: randomUUID() });
    t.after(async () => {
      if (getRun(run.id)) {
        await persistRunNow(run);
        await discardUndurableRun(run.id);
      }
      await deleteArchivedRun(run.id);
    });
    updateRun(run.id, { status: 'done' });
    await persistRunNow(run);
    if (archived) await archiveRun(run.id);
    const keys: ResourceKey[] = [
      { family: 'run', runId: run.id },
      { family: 'runs', scope: 'farm' },
      { family: 'family', familyId: run.familyId },
      { family: 'decisions', scope: 'farm' },
      ...(['gate', 'package', 'review', 'artifacts'] as const).map((family) => ({
        family,
        runId: run.id,
      })),
    ];
    const before = keys.map((key) => resourceRevisions.revision(key));
    const checkAdvance = (writes: number) =>
      keys.forEach((key, index) =>
        assert.equal(resourceRevisions.revision(key), before[index] + writes, JSON.stringify(key)),
      );
    await commitRunPublication(run.id, () => ({ prNumber: 17, links: [], prPublications: [] }));
    assert.equal((await getRunWithArchived(run.id))?.prNumber, 17);
    checkAdvance(1);
    const workGraphId = randomUUID();
    await commitRunGraphAttachment(run.id, { workGraphId }, () => {});
    assert.equal((await getRunWithArchived(run.id))?.workGraphId, workGraphId);
    checkAdvance(2);
    await updateReviewPublication(run.id, { error: 'Awaiting current authority' });
    assert.equal(
      (await getRunWithArchived(run.id))?.reviewPublication?.error,
      'Awaiting current authority',
    );
    checkAdvance(3);
    await assert.rejects(
      commitRunGraphAttachment(run.id, { workGraphId: randomUUID() }, () => {
        throw new Error('Authority changed before commit');
      }),
      /Authority changed before commit/,
    );
    assert.equal((await getRunWithArchived(run.id))?.workGraphId, workGraphId);
    checkAdvance(3);
    assert.equal(getRun(run.id) === undefined, archived);
  });

  test(`automatic QA follow-up changes notify ${archived ? 'archived' : 'live'} review readers once`, async (t) => {
    const run = createRun(
      { flowType: 'review-pr', project: 'demo', ticketOrPr: 'example/app#71' },
      {
        qaAfterReview: {
          version: 1,
          capturedAt: new Date().toISOString(),
          selection: { profile: { id: 'smoke', title: 'Smoke', template_id: 'qa' }, inputs: {} },
          review: { mode: 'cold' },
          state: 'pending',
        },
      },
    );
    t.after(async () => {
      if (getRun(run.id)) {
        await persistRunNow(run);
        await discardUndurableRun(run.id);
      }
      await deleteArchivedRun(run.id);
    });
    updateRun(run.id, { status: 'done' });
    await persistRunNow(run);
    if (archived) await archiveRun(run.id);
    const key = { family: 'review', runId: run.id } as const;
    const before = resourceRevisions.revision(key);
    assert.equal(
      await updateQaFollowUp(run.id, { state: 'blocked', error: 'Profile changed' }),
      true,
    );
    assert.equal((await getRunWithArchived(run.id))?.qaAfterReview?.error, 'Profile changed');
    assert.equal(resourceRevisions.revision(key), before + 1);
    assert.equal(
      await updateQaFollowUp(run.id, { state: 'blocked', error: 'Profile changed' }),
      false,
    );
    assert.equal(resourceRevisions.revision(key), before + 1);
    assert.equal(getRun(run.id) === undefined, archived);
  });
}
