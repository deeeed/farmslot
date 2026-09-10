import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import type { PRReviewRequest, PRRulePreviewItem, PRTeamProfile } from '@farmslot/protocol';

import { PRRuleStore } from './store.js';

const pr = { host: 'github.com', repo: 'owner/repo', number: 42 };
const execution = {
  slotPolicy: { kind: 'exact' as const, slotId: 'review-slot' },
  models: [{ runner: 'codex', model: 'gpt-6-astra', effort: 'high' }],
};
async function teamFor(store: PRRuleStore, owner = 'owner'): Promise<PRTeamProfile> {
  return store.saveTeam(owner, {
    name: 'Review team',
    account: { host: 'github.com', login: 'reader' },
    sources: [{ kind: 'repository', repo: pr.repo }],
    predicate: { kind: 'compare', field: 'draft', operator: 'equals', value: false },
    repositories: [
      { repo: pr.repo, project: 'project', reviewProfile: 'standard', excludedLabels: [] },
    ],
    execution,
    githubTeams: [],
    notificationPrincipalIds: [],
  });
}
async function fixture(t: test.TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'pr-intake-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'rules.json');
  const store = await PRRuleStore.load(file);
  const team = await teamFor(store);
  const request: PRReviewRequest = {
    teamId: team.id,
    pr,
    autoStart: false,
    idempotencyKey: 'request-one',
    source: { client: 'external-integration', reference: 'request-42', requester: 'a teammate' },
    review: { sessionIntent: 'resume', scope: 'incremental', validationDepth: 'full-live' },
  };
  const item: PRRulePreviewItem = {
    subject: {
      pr,
      headSha: 'head-a',
      title: 'Review',
      observedAt: new Date().toISOString(),
      facts: {
        state: { state: 'known', value: 'open' },
        draft: { state: 'known', value: false },
      },
    },
    match: { state: 'match', reasons: ['Matches team policy'] },
    project: 'project',
    reviewProfile: 'standard',
    execution,
    review: request.review,
    configurationErrors: [],
  };
  return { file, store, team, request, item };
}

test('idempotent intake survives restart and rejects changed payloads without trusting source identities', async (t) => {
  const { store, file, team, request, item } = await fixture(t);
  const first = await store.submit('owner', request);
  const duplicate = await store.submit('owner', { ...request, pr: { ...pr, repo: 'Owner/Repo' } });
  assert.equal(duplicate.id, first.id);
  await assert.rejects(
    store.submit('owner', { ...request, autoStart: true }),
    /different review request/,
  );
  await assert.rejects(store.submit('not-owner', request), /Team profile not found/);
  const applied = await store.applySubmission('owner', first.id, first.revision, team.revision, {
    item,
  });
  const restarted = await PRRuleStore.load(file);
  assert.equal((await restarted.submit('owner', request)).id, first.id);
  assert.equal(restarted.submission(first.id, 'owner').intentId, applied.intentId);
  assert.equal(restarted.intent(applied.intentId!)?.status, 'held');
  assert.equal(restarted.intent(applied.intentId!)?.contributions[0].ownerId, 'owner');
  assert.equal(
    restarted.intent(applied.intentId!)?.contributions[0].review?.validationDepth,
    'full-live',
  );
  assert.throws(() => restarted.submission(first.id, 'not-owner'), /not found/);
});

test('direct and discovered requests share one intent while disabling a rule preserves direct authorization', async (t) => {
  const { store, team, request, item } = await fixture(t);
  let rule = await store.saveRule('owner', {
    name: 'Discovery',
    teamId: team.id,
    predicate: team.config.predicate,
    actions: [{ kind: 'review', autoStart: false }],
    pollIntervalMs: 60_000,
    maxAdmissionsPerScan: 10,
    rereviewOnHeadChange: true,
  });
  rule = await store.setEnabled('owner', rule.id, rule.revision, true, true);
  await store.applyPreview('owner', {
    ruleId: rule.id,
    ruleRevision: rule.revision,
    teamId: team.id,
    teamRevision: team.revision,
    checkedAt: new Date().toISOString(),
    complete: true,
    sourceErrors: [],
    ignoredItems: 0,
    items: [item],
  });
  const submission = await store.submit('owner', request);
  await store.applySubmission('owner', submission.id, submission.revision, team.revision, { item });
  assert.equal(store.snapshot().intents.length, 1);
  assert.equal(store.snapshot().intents[0].contributions.length, 2);
  await store.setEnabled('owner', rule.id, rule.revision, false, false);
  const intent = store.snapshot().intents[0];
  assert.equal(intent.status, 'held');
  assert.deepEqual(
    intent.contributions.filter((source) => source.eligible).map((source) => source.submissionId),
    [submission.id],
  );
  await store.decideReview(intent.id, 'owner', 'accept');
  assert(store.intent(intent.id)?.contributions.find((source) => source.submissionId)?.acceptedAt);
});

test('fresh heads replace only unstarted direct intake and preserve deferral across provider reads', async (t) => {
  const { store, team, request, item } = await fixture(t);
  let submission = await store.submit('owner', request);
  submission = await store.applySubmission(
    'owner',
    submission.id,
    submission.revision,
    team.revision,
    { item },
  );
  const oldIntent = submission.intentId!;
  await store.decideReview(oldIntent, 'owner', 'defer');
  submission = await store.applySubmission(
    'owner',
    submission.id,
    submission.revision,
    team.revision,
    {
      item: { ...item, subject: { ...item.subject, headSha: 'head-b' } },
    },
  );
  assert.notEqual(submission.intentId, oldIntent);
  assert.equal(store.intent(oldIntent)?.status, 'withdrawn');
  assert(store.intent(submission.intentId!)?.contributions[0].deferredAt);
  await store.updateDispatch(submission.intentId!, { status: 'running', runId: 'linked-run' });
  const frozen = await store.applySubmission(
    'owner',
    submission.id,
    submission.revision,
    team.revision,
    { item },
  );
  assert.equal(frozen.intentId, submission.intentId);
  assert.equal(frozen.revision, submission.revision);
});

test('provider failure withdraws stale admission and a profile change rejects the old observation', async (t) => {
  const { store, team, request, item } = await fixture(t);
  let submission = await store.submit('owner', request);
  submission = await store.applySubmission(
    'owner',
    submission.id,
    submission.revision,
    team.revision,
    { item },
  );
  submission = await store.applySubmission(
    'owner',
    submission.id,
    submission.revision,
    team.revision,
    { error: 'Provider unavailable' },
  );
  assert.equal(store.intent(submission.intentId!)?.status, 'withdrawn');
  assert.equal(submission.error, 'Provider unavailable');
  const updated = await store.saveTeam(
    'owner',
    { ...team.config, name: 'Changed policy' },
    team.id,
    team.revision,
  );
  await assert.rejects(
    store.applySubmission('owner', submission.id, submission.revision, team.revision, { item }),
    /policy changed/,
  );
  submission = await store.applySubmission(
    'owner',
    submission.id,
    submission.revision,
    updated.revision,
    { item },
  );
  assert.equal(submission.error, undefined);
  assert.equal(store.intent(submission.intentId!)?.status, 'held');
});

test('owners have independent replay keys and private provenance on deduplicated work', async (t) => {
  const { store, team, request, item } = await fixture(t);
  const otherTeam = await teamFor(store, 'other-owner');
  const first = await store.submit('owner', request);
  const other = await store.submit('other-owner', { ...request, teamId: otherTeam.id });
  await store.applySubmission('owner', first.id, first.revision, team.revision, { item });
  await store.applySubmission('other-owner', other.id, other.revision, otherTeam.revision, {
    item,
  });
  assert.equal(store.snapshot().intents.length, 1);
  assert.equal(store.list('owner').intents[0].contributions.length, 1);
  assert.deepEqual(
    store.list('owner').submissions?.map((entry) => entry.id),
    [first.id],
  );
});

test('new requests after execution starts create follow-up rounds instead of inheriting an incompatible result', async (t) => {
  const { store, team, request, item } = await fixture(t);
  const initial = await store.submit('owner', {
    ...request,
    review: { sessionIntent: 'resume', scope: 'incremental', validationDepth: 'static-code' },
  });
  const first = await store.applySubmission('owner', initial.id, initial.revision, team.revision, {
    item: { ...item, review: initial.request.review },
  });
  await store.updateDispatch(first.intentId!, { status: 'completed', runId: 'static-review-run' });
  const qaRequest = { ...request, idempotencyKey: 'live-qa-request' };
  let qa = await store.submit('owner', qaRequest);
  qa = await store.applySubmission('owner', qa.id, qa.revision, team.revision, { item });
  assert.notEqual(qa.intentId, first.intentId);
  assert.equal(store.intent(qa.intentId!)?.round, 2);
  assert.equal(store.intent(qa.intentId!)?.status, 'held');
  assert.equal(store.intent(qa.intentId!)?.runId, undefined);
  assert.equal(store.intent(first.intentId!)?.contributions.length, 1);
  assert.equal((await store.submit('owner', qaRequest)).intentId, qa.intentId);
  await store.updateDispatch(qa.intentId!, { status: 'running', runId: 'qa-run' });
  let fresh = await store.submit('owner', {
    ...request,
    idempotencyKey: 'fresh-review',
    review: { sessionIntent: 'reset', scope: 'full', validationDepth: 'full-live' },
  });
  fresh = await store.applySubmission('owner', fresh.id, fresh.revision, team.revision, {
    item: { ...item, review: fresh.request.review },
  });
  assert.equal(store.intent(fresh.intentId!)?.round, 3);
  assert.equal(store.intent(fresh.intentId!)?.status, 'held');
});

test('a delayed concurrent request joins the execution that started after submission, including after restart', async (t) => {
  const { store, file, team, request, item } = await fixture(t);
  const otherTeam = await teamFor(store, 'other-owner');
  const first = await store.submit('owner', request);
  const delayed = await store.submit('other-owner', {
    ...request,
    teamId: otherTeam.id,
    idempotencyKey: 'concurrent-request',
  });
  const linked = await store.applySubmission('owner', first.id, first.revision, team.revision, {
    item,
  });
  await store.updateDispatch(linked.intentId!, { status: 'running', runId: 'existing-run' });
  const restarted = await PRRuleStore.load(file);
  const result = await restarted.applySubmission(
    'other-owner',
    delayed.id,
    delayed.revision,
    otherTeam.revision,
    { item },
  );
  assert.equal(
    result.intentId,
    linked.intentId,
    'Provider latency must not create a follow-up round',
  );
  assert.equal(restarted.snapshot().intents.length, 1);
  assert.equal(restarted.intent(result.intentId!)?.runId, 'existing-run');
  assert.equal(restarted.intent(result.intentId!)?.status, 'running');

  const followup = await restarted.submit('owner', { ...request, idempotencyKey: 'after-start' });
  const next = await restarted.applySubmission(
    'owner',
    followup.id,
    followup.revision,
    team.revision,
    { item },
  );
  assert.notEqual(
    next.intentId,
    linked.intentId,
    'Explicit requests submitted after start still create a new round',
  );
});

test('cancelling intake fences in-flight observations and retains replay identity', async (t) => {
  const { store, team, request, item } = await fixture(t);
  let submission = await store.submit('owner', request);
  submission = await store.applySubmission(
    'owner',
    submission.id,
    submission.revision,
    team.revision,
    { item },
  );
  const cancellation = store.cancelSubmission('owner', submission.id, submission.revision);
  assert.equal(
    store.admissionPending,
    true,
    'Pending cancellation must fence run admission before persistence',
  );
  const cancelled = await cancellation;
  assert.equal(store.admissionPending, false);
  assert(cancelled.cancelledAt);
  assert.equal(store.intent(submission.intentId!)?.status, 'withdrawn');
  const late = await store.applySubmission(
    'owner',
    submission.id,
    submission.revision,
    team.revision,
    { item },
  );
  assert.equal(late.cancelledAt, cancelled.cancelledAt);
  assert.equal((await store.submit('owner', request)).cancelledAt, cancelled.cancelledAt);
});

test('late run creation blocks cancellation before publishing a false cancelled receipt', async (t) => {
  const { store, team, request, item } = await fixture(t);
  let submission = await store.submit('owner', request);
  submission = await store.applySubmission(
    'owner',
    submission.id,
    submission.revision,
    team.revision,
    { item },
  );
  await assert.rejects(
    store.cancelSubmission('owner', submission.id, submission.revision, () => {
      throw new Error('Review execution is already starting');
    }),
    /already starting/,
  );
  assert.equal(store.submission(submission.id, 'owner').cancelledAt, undefined);
  assert.equal(store.admissionPending, false);
});

test('an identical retry returns its durable receipt after the team changes provider hosts', async (t) => {
  const { store, team, request } = await fixture(t);
  const first = await store.submit('owner', request);
  await store.saveTeam(
    'owner',
    { ...team.config, account: { ...team.config.account, host: 'github.example.com' } },
    team.id,
    team.revision,
  );
  assert.equal((await store.submit('owner', request)).id, first.id);
  await assert.rejects(
    store.submit('owner', { ...request, idempotencyKey: 'new-request' }),
    /host must match/,
  );
});
