import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import type { ReviewPublicationReceipt, Run } from '@farmslot/protocol';

import { createRun, deleteRun, getRunWithArchived, updateRun } from '../runs/store.js';

import { PRRuleService } from './service.js';
import { PRRuleStore } from './store.js';

const pr = { host: 'github.com', repo: 'owner/repo', number: 7 };
const account = { host: 'github.com', login: 'publisher' };

/** A finished static review whose operator pressed Publish: the gate is recorded, nothing posted. */
function finishedReviewAwaitingPublication(t: test.TestContext): Run {
  const created = createRun({ flowType: 'review-pr', project: 'farmslot-farm', ticketOrPr: 'owner/repo#7' });
  t.after(() => deleteRun(created.id));
  return updateRun(created.id, {
    status: 'done',
    completedAt: new Date().toISOString(),
    reviewPublication: {
      gate: {
        decisionId: 'decision-1',
        publication: {
          ownerId: 'owner',
          pr,
          requested: true,
          policy: { enabled: true, source: 'request', teamId: 'team-1', account },
        },
      },
      checkedAt: new Date().toISOString(),
    },
  });
}

async function serviceFor(t: test.TestContext, authorized: boolean) {
  const directory = await mkdtemp(join(tmpdir(), 'review-publication-reconcile-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = await PRRuleStore.load(join(directory, 'rules.json'));
  const service = new PRRuleService(store, () => authorized, () => {});
  const published: string[] = [];
  service.publishReview = async (_ownerId: string, runId: string) => {
    published.push(runId);
    const receipt: ReviewPublicationReceipt = {
      version: 1,
      state: 'published',
      runId,
      ownerId: 'owner',
      account,
      pr,
      headSha: 'a'.repeat(40),
      contentSha256: 'c'.repeat(64),
      marker: '<!-- farmslot-review:test -->',
      event: 'COMMENT',
      attemptedAt: new Date().toISOString(),
      url: 'https://github.com/owner/repo/pull/7#pullrequestreview-1',
    };
    return receipt;
  };
  return { service, published };
}

test('a completed review publishes at once, without waiting for the PR-rules sweep', async (t) => {
  const run = finishedReviewAwaitingPublication(t);
  const { service, published } = await serviceFor(t, true);
  await service.publishCompletedReview(run.id);
  assert.deepEqual(published, [run.id]);
});

test('a sweep that cannot publish for an unauthorized owner records why on the run', async (t) => {
  const run = finishedReviewAwaitingPublication(t);
  const { service, published } = await serviceFor(t, false);
  await service.tick();
  assert.deepEqual(published, []);
  assert.match(
    (await getRunWithArchived(run.id))?.reviewPublication?.error ?? '',
    /Publication owner owner has no automation authority/,
  );
});
