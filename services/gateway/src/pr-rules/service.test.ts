import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import type { PRRuleSubject } from '@farmslot/protocol';

import { PRRuleService } from './service.js';
import { PRRuleStore } from './store.js';

test('preview is read-only, scans deduplicate, and provider outages are recorded without admission', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'pr-rule-service-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = await PRRuleStore.load(join(directory, 'rules.json'));
  let reads = 0;
  let unavailable = false;
  const service = new PRRuleService(
    store,
    () => true,
    () => {},
    async () => {
      reads += 1;
      if (unavailable) throw new Error('Project access lost');
      return { subjects: [], complete: true, errors: [], ignoredItems: 0 };
    },
  );
  const predicate = {
    kind: 'compare' as const,
    field: 'state' as const,
    operator: 'equals' as const,
    value: 'open',
  };
  const team = await service.saveTeam('owner', {
    name: 'Team',
    account: { host: 'github.com', login: 'reader' },
    sources: [{ kind: 'repository', repo: 'owner/repo' }],
    predicate,
    repositories: [],
    githubTeams: [],
    notificationPrincipalIds: [],
  });
  let rule = await service.saveRule('owner', {
    name: 'Review',
    teamId: team.id,
    predicate,
    actions: [{ kind: 'review', autoStart: false }],
    pollIntervalMs: 300_000,
    maxAdmissionsPerScan: 1,
    rereviewOnHeadChange: true,
  });
  const before = store.snapshot();
  await service.preview('owner', rule.id);
  assert.deepEqual(store.snapshot(), before);
  rule = await store.setEnabled('owner', rule.id, rule.revision, true, false);
  reads = 0;
  await Promise.all([service.scan('owner', rule.id), service.scan('owner', rule.id)]);
  assert.equal(reads, 1);
  unavailable = true;
  await service.scan('owner', rule.id);
  assert.match(store.rule(rule.id, 'owner').scan.error ?? '', /Project access lost/);
  assert.equal(store.snapshot().intents.length, 0);
  unavailable = false;
  await service.scan('owner', rule.id);
  assert.equal(store.rule(rule.id, 'owner').scan.error, undefined);
});

async function revisionFixture(t: test.TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'pr-rule-revisions-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = await PRRuleStore.load(join(directory, 'rules.json'));
  const predicate = {
    kind: 'compare' as const,
    field: 'state' as const,
    operator: 'equals' as const,
    value: 'open',
  };
  const team = await store.saveTeam('owner', {
    name: 'Team',
    account: { host: 'github.com', login: 'reader' },
    sources: [{ kind: 'repository', repo: 'owner/repo' }],
    predicate,
    repositories: [],
    githubTeams: [],
    notificationPrincipalIds: [],
  });
  const rule = await store.saveRule('owner', {
    name: 'Rule',
    teamId: team.id,
    predicate,
    actions: [{ kind: 'notify' }],
    pollIntervalMs: 60_000,
    maxAdmissionsPerScan: 1,
    rereviewOnHeadChange: false,
  });
  const subject: PRRuleSubject = {
    pr: { host: 'github.com', repo: 'owner/repo', number: 1 },
    headSha: 'head',
    title: 'PR',
    observedAt: new Date().toISOString(),
    facts: { state: { state: 'known', value: 'open' } },
  };
  return { store, team, rule, subject };
}

test('webhooks schedule explicit repository sources without legacy fallback or provider reads', async (t) => {
  const { store, rule, subject } = await revisionFixture(t);
  await store.setEnabled('owner', rule.id, rule.revision, true, false);
  const service = new PRRuleService(
    store,
    () => true,
    () => {},
    undefined,
    undefined,
    undefined,
    async () => {
      throw new Error('Unexpected provider read for a repository source');
    },
  );
  assert.equal(await service.routeWebhook(subject.pr), 'rules');
  assert(store.rule(rule.id, 'owner').scan.nextScanAt);
  assert.equal(store.snapshot().intents.length, 0);
  assert.equal(await service.routeWebhook({ ...subject.pr, repo: 'owner/legacy' }), 'legacy');
  const revoked = new PRRuleService(
    store,
    () => false,
    () => {},
  );
  assert.equal(
    await revoked.routeWebhook({ ...subject.pr, repo: 'owner/legacy' }),
    'legacy',
    'Revocation for another repository cannot block unrelated legacy events',
  );
  assert.equal(await revoked.routeWebhook(subject.pr), 'unknown');
});

test('Project webhook ownership uses membership and view scope, independently of repository mappings and rule predicates', async (t) => {
  const { store, team, rule, subject } = await revisionFixture(t);
  await store.saveTeam(
    'owner',
    {
      ...team.config,
      sources: [{ kind: 'github-project', projectId: 'PVT_project', label: 'Project' }],
      repositories: [
        { repo: 'owner/mapped-nonmember', reviewProfile: 'standard', excludedLabels: [] },
      ],
    },
    team.id,
    team.revision,
  );
  await store.setEnabled('owner', rule.id, rule.revision, true, false);
  let calls = 0;
  const service = new PRRuleService(
    store,
    () => true,
    () => {},
    undefined,
    undefined,
    undefined,
    async (targetTeam, targetRule, pr) => {
      calls++;
      assert.deepEqual(targetTeam.config.predicate, { kind: 'all', items: [] });
      assert.deepEqual(targetRule.config.predicate, { kind: 'all', items: [] });
      assert.equal(targetTeam.config.sources[0].kind, 'github-project');
      return {
        complete: true,
        subjects: pr.repo === subject.pr.repo ? [subject] : [],
        errors: [],
        ignoredItems: 0,
      };
    },
  );
  assert.equal(
    await service.routeWebhook(subject.pr),
    'rules',
    'Unmapped Project member is owned by its rule source',
  );
  assert(store.rule(rule.id, 'owner').scan.nextScanAt);
  assert.equal(
    await service.routeWebhook({ ...subject.pr, repo: 'owner/mapped-nonmember' }),
    'legacy',
  );
  assert.equal(calls, 2);
  assert.equal(store.snapshot().intents.length, 0);
});

test('Project webhook uncertainty and policy edits during lookup cannot fall through to legacy or schedule stale rules', async (t) => {
  const { store, team, rule, subject } = await revisionFixture(t);
  await store.saveTeam(
    'owner',
    {
      ...team.config,
      sources: [{ kind: 'github-project', projectId: 'PVT_project', label: 'Project' }],
    },
    team.id,
    team.revision,
  );
  let current = await store.setEnabled('owner', rule.id, rule.revision, true, false);
  let mode = 'incomplete';
  const service = new PRRuleService(
    store,
    () => true,
    () => {},
    undefined,
    undefined,
    undefined,
    async () => {
      if (mode === 'error') throw new Error('Project access lost');
      if (mode === 'edit')
        current = await store.setEnabled('owner', current.id, current.revision, false, false);
      return { complete: mode !== 'incomplete', subjects: [subject], errors: [], ignoredItems: 0 };
    },
  );
  assert.equal(await service.routeWebhook(subject.pr), 'unknown');
  mode = 'error';
  assert.equal(await service.routeWebhook(subject.pr), 'unknown');
  assert.match(service.schedulerError ?? '', /Project access lost/);
  mode = 'edit';
  assert.equal(await service.routeWebhook(subject.pr), 'unknown');
  assert.equal(store.rule(rule.id, 'owner').enabled, false);
  assert.equal(store.snapshot().intents.length, 0);
});

test('activation cannot reuse a scan from an older rule revision', async (t) => {
  const { store, team, rule, subject } = await revisionFixture(t);
  let finishOld!: () => void;
  const oldRead = new Promise<void>((resolve) => {
    finishOld = resolve;
  });
  let startedOld!: () => void;
  const started = new Promise<void>((resolve) => {
    startedOld = resolve;
  });
  const service = new PRRuleService(
    store,
    () => true,
    () => {},
    async (_team, current) => {
      if (current.revision === rule.revision) {
        startedOld();
        await oldRead;
      }
      return { subjects: [subject], complete: true, errors: [], ignoredItems: 0 };
    },
  );
  const pending = service.scan('owner', rule.id);
  await started;
  const changed = await store.saveRule(
    'owner',
    { ...rule.config, name: 'Updated' },
    rule.id,
    rule.revision,
  );
  try {
    const enabled = await service.enable('owner', changed.id, changed.revision, true, true);
    assert(enabled.enabled);
    assert.equal(
      store.snapshot().actions?.length,
      1,
      'Backfill must complete under the new revision without waiting for the obsolete scan',
    );
  } finally {
    finishOld();
    await pending;
  }
  assert.equal(store.snapshot().actions?.length, 1);
  assert.equal(store.snapshot().actions![0].teamRevision, team.revision);
});

test('a team edit during preview rejects activation without granting new authority', async (t) => {
  const { store, team, rule, subject } = await revisionFixture(t);
  const service = new PRRuleService(
    store,
    () => true,
    () => {},
    async () => {
      await store.saveTeam(
        'owner',
        { ...team.config, name: 'Changed during read' },
        team.id,
        team.revision,
      );
      return { subjects: [subject], complete: true, errors: [], ignoredItems: 0 };
    },
  );
  await assert.rejects(
    service.enable('owner', rule.id, rule.revision, true, true),
    /Team profile changed during activation/,
  );
  assert.equal(store.rule(rule.id, 'owner').enabled, false);
  assert.equal(store.snapshot().actions?.length ?? 0, 0);
});

test('activation baselines its completed preview so PRs discovered after enablement remain future matches', async (t) => {
  const { store, rule, subject } = await revisionFixture(t);
  let reads = 0;
  const service = new PRRuleService(
    store,
    () => true,
    () => {},
    async () => {
      reads++;
      return reads === 1
        ? { subjects: [subject], complete: true, errors: [], ignoredItems: 0 }
        : reads === 2
          ? { subjects: [], complete: false, errors: ['scan paused'], ignoredItems: 0 }
          : {
              subjects: [subject, { ...subject, pr: { ...subject.pr, number: 2 } }],
              complete: true,
              errors: [],
              ignoredItems: 0,
            };
    },
  );
  const enabled = await service.enable('owner', rule.id, rule.revision, true, false);
  assert.equal(enabled.enabled, true);
  assert.equal(enabled.scan.baselinePending, false);
  await service.scan('owner', rule.id);
  const notes = service.list('owner').notifications ?? [];
  assert.equal(notes.length, 1);
  assert.equal(
    notes[0].pr.number,
    2,
    'The post-activation PR cannot be silently added to the historical baseline',
  );
});

test('unreadable Project targets preserve legacy routing and uncertain rules do not starve known sources', async (t) => {
  const { GitHubPRUnavailableError } = await import('../integrations/github-errors.js');
  const { store, team, rule, subject } = await revisionFixture(t);
  await store.saveTeam(
    'owner',
    {
      ...team.config,
      sources: [{ kind: 'github-project', projectId: 'PVT_project', label: 'Project' }],
    },
    team.id,
    team.revision,
  );
  await store.setEnabled('owner', rule.id, rule.revision, true, false);
  let unavailable = true;
  const service = new PRRuleService(
    store,
    () => true,
    () => {},
    undefined,
    undefined,
    undefined,
    async () => {
      if (unavailable) throw new GitHubPRUnavailableError();
      throw new Error('Project membership lookup failed');
    },
  );
  assert.equal(await service.routeWebhook(subject.pr), 'legacy');
  const repoTeam = await store.saveTeam('owner', { ...team.config, name: 'Repository source' });
  let repoRule = await store.saveRule('owner', { ...rule.config, teamId: repoTeam.id });
  repoRule = await store.setEnabled('owner', repoRule.id, repoRule.revision, true, false);
  assert.equal(await service.routeWebhook(subject.pr), 'rules');
  const before = store.snapshot();
  unavailable = false;
  assert.equal(await service.routeWebhook(subject.pr), 'unknown');
  assert(store.rule(repoRule.id, 'owner').scan.nextScanAt);
  assert.equal(store.snapshot().intents.length, 0);
  assert.equal(
    store.rule(rule.id, 'owner').revision,
    before.rules.find((r) => r.id === rule.id)!.revision,
  );
});

test('accept refreshes GitHub review state before rejecting duplicate work or allowing a re-request', async (t) => {
  const { store, rule, subject } = await revisionFixture(t);
  const reviewRule = await store.saveRule(
    'owner',
    { ...rule.config, actions: [{ kind: 'review', autoStart: false }] },
    rule.id,
    rule.revision,
  );
  await store.setEnabled('owner', reviewRule.id, reviewRule.revision, true, true);
  subject.facts.draft = { state: 'known', value: false };
  subject.reviewObservation = {
    observedAt: new Date().toISOString(),
    headSha: 'head',
    state: 'open',
    draft: false,
    decision: 'REVIEW_REQUIRED',
    reviewer: 'reader',
    requested: false,
    review: null,
  };
  let reads = 0;
  const service = new PRRuleService(
    store,
    () => true,
    () => {},
    undefined,
    undefined,
    undefined,
    async () => {
      reads++;
      return { complete: true, subjects: [subject], errors: [], ignoredItems: 0 };
    },
  );
  await store.applyPreview('owner', await service.preview('owner', reviewRule.id, subject.pr));
  const intent = store.list('owner').intents[0];
  assert(intent);
  subject.reviewObservation.review = { state: 'APPROVED', commit: 'head', submittedAt: null };
  await assert.rejects(service.decideReview('owner', intent.id, 'accept'), /already reviewed/);
  assert.equal(reads, 2);
  assert.equal(store.intent(intent.id)?.contributions[0].acceptedAt, undefined);
  subject.reviewObservation.requested = true;
  await service.decideReview('owner', intent.id, 'accept');
  assert.equal(reads, 3);
  assert(store.intent(intent.id)?.contributions[0].acceptedAt);
  await assert.rejects(service.decideReview('other-owner', intent.id, 'accept'), /not found/);
  assert.equal(reads, 3, 'An unauthorized principal never reads the PR through another account');
});
