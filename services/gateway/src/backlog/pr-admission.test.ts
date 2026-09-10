import assert from 'node:assert/strict';
import test from 'node:test';

import type { PRWorkReference, RunCreateParams } from '@farmslot/protocol';

import { makeRun } from '../run-engine/test-fixtures.js';
import { createRun, deleteRun, updateRun } from '../runs/store.js';

import {
  assertNoAutomatedPRConflict,
  assertPRReviewWorktreeHead,
  runOwnsPR,
} from './pr-admission.js';

const reference: PRWorkReference = {
  kind: 'review',
  id: 'review:intent',
  sourceId: 'intent',
  pr: { host: 'github.com', repo: 'owner/repo', number: 42 },
  headSha: 'head-a',
};

test('PR execution ownership covers canonical refs and published links without number-only collisions', () => {
  const run = makeRun({ flowType: 'review-pr', ticketOrPr: 'Owner/Repo#42', status: 'monitoring' });
  assert.equal(runOwnsPR(run, reference.pr), true);
  assert.equal(runOwnsPR(run, { ...reference.pr, repo: 'owner/other' }), false);
  assert.equal(runOwnsPR({ ...run, status: 'done' }, reference.pr), false);
  assert.equal(
    runOwnsPR(
      {
        ...run,
        ticketOrPr: 'TASK-1',
        links: [{ url: 'https://github.com/owner/repo/pull/42', label: 'PR' }],
      },
      reference.pr,
    ),
    true,
  );
});

test('manual creation cannot overtake automated ownership but unrelated PRs remain available', () => {
  const run = { ...makeRun({ project: 'project', status: 'monitoring' }), prWork: reference };
  const params: RunCreateParams = {
    flowType: 'pr-complete',
    project: 'project',
    ticketOrPr: 'owner/repo#42',
  };
  assert.throws(() => assertNoAutomatedPRConflict(params, [run]), /owned by run/);
  assert.doesNotThrow(() =>
    assertNoAutomatedPRConflict({ ...params, ticketOrPr: 'owner/other#42' }, [run]),
  );
  assert.doesNotThrow(() => assertNoAutomatedPRConflict(params, [{ ...run, status: 'done' }]));
  assert.doesNotThrow(() => assertNoAutomatedPRConflict(params, [{ ...run, prWork: undefined }]));
});

test('review worker dispatch rejects a moved or unknown prepared HEAD', () => {
  const run = { ...makeRun(), prWork: reference };
  assert.doesNotThrow(() => assertPRReviewWorktreeHead(run, 'head-a'));
  assert.throws(() => assertPRReviewWorktreeHead(run, 'head-b'), /head changed/);
  assert.throws(() => assertPRReviewWorktreeHead(run, null), /head changed/);
  assert.doesNotThrow(() => assertPRReviewWorktreeHead({ ...run, prWork: undefined }, null));
});

test('project-mapped PR numbers cover missing links without overriding canonical repository identity', () => {
  const run = makeRun({
    project: 'project',
    ticketOrPr: 'TASK-1',
    prNumber: 42,
    status: 'monitoring',
  });
  assert.equal(runOwnsPR(run, reference.pr, 'project'), true);
  assert.equal(runOwnsPR(run, reference.pr, 'different-project'), false);
  assert.equal(
    runOwnsPR(
      { ...run, flowType: 'review-pr', ticketOrPr: 'owner/other#42' },
      reference.pr,
      'project',
    ),
    false,
  );
});

test('terminal run reactivation is rejected while another automated run owns the PR', async (t) => {
  const old = createRun({
    flowType: 'review-pr',
    project: 'project',
    ticketOrPr: 'owner/repo#99123',
  });
  updateRun(old.id, { status: 'done' });
  const current = createRun({
    flowType: 'review-pr',
    project: 'project',
    ticketOrPr: 'owner/repo#99123',
  });
  updateRun(current.id, { prWork: { ...reference, pr: { ...reference.pr, number: 99123 } } });
  t.after(async () => {
    updateRun(current.id, { status: 'done' });
    await deleteRun(current.id);
    await deleteRun(old.id);
  });
  assert.throws(() => updateRun(old.id, { status: 'slot-finding' }), /owned by run/);
  assert.equal(old.status, 'done');
});

test('issue-backed runs own their produced PR rather than their issue number', () => {
  const run = makeRun({
    flowType: 'dev',
    project: 'project',
    ticketOrPr: 'owner/repo#10',
    prNumber: 42,
    links: [{ label: 'PR', url: 'https://github.com/owner/repo/pull/42' }],
  });
  assert.equal(runOwnsPR(run, reference.pr, 'project'), true);
  assert.equal(runOwnsPR(run, { ...reference.pr, number: 10 }, 'project'), false);
  const owner = { ...makeRun({ project: 'project' }), prWork: reference };
  assert.throws(
    () =>
      assertNoAutomatedPRConflict(
        { flowType: 'dev', project: 'project', ticketOrPr: 'owner/repo#10', prNumber: 42 },
        [owner],
      ),
    /owned by run/,
  );
});

test('links-only history cannot reactivate or attach to another automated PR owner', async (t) => {
  const previous = createRun({
    flowType: 'dev',
    project: 'project',
    ticketOrPr: 'TASK-LINKS-ONLY',
  });
  updateRun(previous.id, {
    status: 'done',
    links: [{ label: 'PR', url: 'https://github.com/owner/repo/pull/99124' }],
  });
  const owner = createRun({
    flowType: 'review-pr',
    project: 'project',
    ticketOrPr: 'owner/repo#99124',
  });
  updateRun(owner.id, { prWork: { ...reference, pr: { ...reference.pr, number: 99124 } } });
  const active = createRun({
    flowType: 'dev',
    project: 'project',
    ticketOrPr: 'TASK-LINK-ATTACHMENT',
  });
  t.after(async () => {
    for (const run of [owner, previous, active]) {
      updateRun(run.id, { status: 'done' });
      await deleteRun(run.id);
    }
  });
  assert.throws(() => updateRun(previous.id, { status: 'slot-finding' }), /owned by run/);
  assert.throws(() => updateRun(active.id, { links: previous.links }), /owned by run/);
  assert.equal(previous.status, 'done');
  assert.equal(active.links, undefined);
});
