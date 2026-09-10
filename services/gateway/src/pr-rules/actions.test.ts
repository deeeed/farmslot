import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import type {
  PRMonitorConfig,
  PRRuleAction,
  PRRulePreview,
  PRTeamProfile,
  PRTriggerRule,
} from '@farmslot/protocol';

import { PRMonitorStore } from '../pr-monitoring/store.js';

import { PRRuleService } from './service.js';
import { PRRuleStore } from './store.js';

async function fixture(t: test.TestContext, actions: PRRuleAction[], backfill = true, limit = 10) {
  const dir = await mkdtemp(join(tmpdir(), 'pr-rule-actions-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'rules.json');
  const monitorFile = join(dir, 'monitors.json');
  const store = await PRRuleStore.load(file);
  const monitors = await PRMonitorStore.load(monitorFile);
  const team = await store.saveTeam('owner', {
    name: 'Team',
    account: { host: 'github.com', login: 'reader' },
    sources: [{ kind: 'repository', repo: 'owner/repo' }],
    predicate: { kind: 'compare', field: 'state', operator: 'equals', value: 'open' },
    repositories: [
      { repo: 'owner/repo', project: 'project', reviewProfile: 'standard', excludedLabels: [] },
    ],
    githubTeams: [],
    notificationPrincipalIds: ['recipient'],
  });
  const saved = await store.saveRule('owner', {
    name: 'Rule',
    teamId: team.id,
    predicate: team.config.predicate,
    actions,
    pollIntervalMs: 300_000,
    maxAdmissionsPerScan: limit,
    rereviewOnHeadChange: true,
  });
  const rule = await store.setEnabled('owner', saved.id, saved.revision, true, backfill);
  const active = new Set(['owner', 'recipient', 'unrelated']);
  const authorized = (id: string) => active.has(id);
  const published: string[] = [];
  const service = new PRRuleService(
    store,
    authorized,
    (id) => published.push(id),
    undefined,
    undefined,
    {
      store: monitors,
      enrolled: async (id, owner) => monitors.get(id, owner),
    },
  );
  return {
    dir,
    file,
    monitorFile,
    store,
    monitors,
    team,
    rule,
    active,
    authorized,
    service,
    published,
  };
}

test('adding and removing supplemental approval policy never backfills unchanged PRs on enabled rules', async (t) => {
  const f = await fixture(t, [{ kind: 'notify' }, { kind: 'review', autoStart: false }], false);
  await f.store.applyPreview('owner', preview(f.team, f.rule));
  assert.equal(f.store.snapshot().actions?.length ?? 0, 0);
  assert.equal(f.store.snapshot().intents.length, 0);
  const withPolicy = await f.store.saveTeam(
    'owner',
    {
      ...f.team.config,
      repositories: f.team.config.repositories.map((policy) => ({ ...policy, approvalTarget: 1 })),
    },
    f.team.id,
    f.team.revision,
  );
  const observed = preview(withPolicy, f.rule);
  observed.items[0].subject.reviewPolicyFacts = {
    approvalCount: 1,
    providerReviewDecision: 'APPROVED',
  };
  await f.store.applyPreview('owner', observed);
  assert.equal(f.store.snapshot().actions?.length ?? 0, 0);
  assert.equal(f.store.snapshot().intents.length, 0);
  const removed = await f.store.saveTeam('owner', f.team.config, f.team.id, withPolicy.revision);
  await f.store.applyPreview('owner', preview(removed, f.rule));
  assert.equal(f.store.snapshot().actions?.length ?? 0, 0);
  assert.equal(f.store.snapshot().intents.length, 0);
  const changed = preview(removed, f.rule, 'actual-new-head');
  changed.items[0].subject.reviewPolicyFacts = {
    lastActivityAt: '2026-09-10T00:00:00Z',
    providerReviewDecision: 'REVIEW_REQUIRED',
  };
  await f.store.applyPreview('owner', changed);
  assert.equal(
    f.store.snapshot().intents.length,
    1,
    'A genuine head change still produces normal rule work',
  );
});

test('Notify and Add-monitor admissions persist and reload supplemental provider observations', async (t) => {
  const f = await fixture(t, [
    { kind: 'notify' },
    { kind: 'monitor', policy: { mode: 'notify-only' } },
  ]);
  const scanned = preview(f.team, f.rule);
  const supplemental = {
    approvalCount: 2,
    providerReviewDecision: 'CHANGES_REQUESTED',
    lastActivityAt: '2026-09-10T00:00:00Z',
  };
  scanned.items[0].subject.reviewPolicyFacts = supplemental;
  await f.store.applyPreview('owner', scanned);
  const reloaded = await PRRuleStore.load(f.file);
  const actions = reloaded.snapshot().actions!;
  assert.deepEqual(actions.map((action) => action.kind).sort(), ['monitor', 'notify']);
  assert(
    actions.every(
      (action) => JSON.stringify(action.subject.reviewPolicyFacts) === JSON.stringify(supplemental),
    ),
  );
});

function preview(
  team: PRTeamProfile,
  rule: PRTriggerRule,
  headSha = 'head-a',
  count = 1,
): PRRulePreview {
  return {
    teamId: team.id,
    teamRevision: team.revision,
    ruleId: rule.id,
    ruleRevision: rule.revision,
    checkedAt: new Date().toISOString(),
    complete: true,
    sourceErrors: [],
    ignoredItems: 0,
    items: Array.from({ length: count }, (_, index) => ({
      subject: {
        pr: { host: 'github.com', repo: 'owner/repo', number: index + 1 },
        headSha,
        title: 'A PR',
        observedAt: new Date().toISOString(),
        facts: {
          state: { state: 'known', value: 'open' },
          draft: { state: 'known', value: false },
        },
      },
      match: { state: 'match', reasons: ['Team criteria matched'] },
      project: team.config.repositories[0].project,
      reviewProfile: 'standard',
      configurationErrors: [],
    })),
  };
}

const notify: PRRuleAction = { kind: 'notify' };
const monitor: PRRuleAction = { kind: 'monitor', policy: { mode: 'notify-only' } };

test('notifications baseline historical matches, persist once, and filter recipients and acknowledgements', async (t) => {
  const f = await fixture(t, [notify], false);
  await f.store.applyPreview('owner', preview(f.team, f.rule));
  assert.equal(f.store.snapshot().actions?.length ?? 0, 0);
  const changed = preview(f.team, f.rule, 'head-b');
  await Promise.all([
    f.store.applyPreview('owner', changed),
    f.store.applyPreview('owner', changed),
  ]);
  assert.equal(f.store.snapshot().actions?.length, 1);
  assert.equal(f.store.snapshot().intents.length, 0);
  const note = f.service.list('recipient').notifications![0];
  assert(note.current);
  assert.equal(
    f.service.list('recipient').actions?.length,
    0,
    'Sharing attention does not share rule policy or private source facts',
  );
  assert.equal(f.service.list('unrelated').notifications?.length, 0);
  await assert.rejects(f.service.acknowledgeAction('unrelated', note.id), /unavailable/);
  await f.service.acknowledgeAction('recipient', note.id);
  assert(f.service.list('recipient').notifications![0].acknowledgedAt);
  assert.equal(f.service.list('owner').notifications![0].acknowledgedAt, undefined);
  const reloaded = await PRRuleStore.load(f.file);
  await reloaded.applyPreview('owner', changed);
  assert.equal(reloaded.snapshot().actions?.length, 1);
  assert(reloaded.snapshot().actions![0].acknowledgedBy.recipient);
  f.active.delete('recipient');
  assert.equal(f.service.list('recipient').notifications?.length, 0);
  f.active.add('recipient');
  await f.service.saveTeam(
    'owner',
    { ...f.team.config, notificationPrincipalIds: [] },
    f.team.id,
    f.team.revision,
  );
  assert.equal(f.service.list('recipient').notifications?.length, 0);
  assert(
    f.published.includes('recipient'),
    'The removed audience receives an authoritative refresh',
  );
});

test('notification and monitor actions share the subject admission budget without creating review work', async (t) => {
  const f = await fixture(t, [notify, monitor], true, 1);
  await f.store.applyPreview('owner', preview(f.team, f.rule, 'head-a', 2));
  assert.equal(f.store.snapshot().actions?.length, 2);
  assert.match(f.store.rule(f.rule.id, 'owner').scan.admissionWarning ?? '', /limit/);
  assert.equal(f.store.snapshot().intents.length, 0);
  await f.service.deliverActions();
  assert.equal(f.monitors.list('owner').length, 1);
  assert(f.store.snapshot().actions!.every((item) => item.status === 'applied'));
  const again = await f.store.setEnabled('owner', f.rule.id, f.rule.revision, true, true);
  await f.store.applyPreview('owner', preview(f.team, again, 'head-a', 2));
  await f.service.deliverActions();
  assert.equal(f.store.snapshot().actions?.length, 4);
  assert.equal(f.monitors.list('owner').length, 2);
});

test('monitor enrollment preserves a stopped notify-only subscription despite automatic-repair rule policy', async (t) => {
  const f = await fixture(t, [
    {
      kind: 'monitor',
      policy: {
        mode: 'automatic-repair',
        execution: {
          slotPolicy: { kind: 'exact', slotId: 'slot' },
          models: [{ runner: 'runner', model: 'model' }],
        },
      },
    },
  ]);
  const config: PRMonitorConfig = {
    pr: { host: 'github.com', repo: 'owner/repo', number: 1 },
    account: f.team.config.account,
    teamId: f.team.id,
    policy: { mode: 'notify-only' },
    pollIntervalMs: 60_000,
    automaticAttemptLimit: 1,
    cooldownMs: 60_000,
    watchedChecks: [],
  };
  const existing = await f.monitors.subscribe('owner', config);
  await f.monitors.setLifecycle(existing.id, 'owner', existing.revision, 'stopped');
  await f.store.applyPreview('owner', preview(f.team, f.rule));
  await f.service.deliverActions();
  const result = f.monitors.get(existing.id, 'owner');
  assert.equal(result.config.policy.mode, 'notify-only');
  assert.equal(result.lifecycle, 'stopped');
  assert.equal(f.store.snapshot().actions![0].monitorId, existing.id);
  assert.equal(f.monitors.list('owner').length, 1);
});

test('restart after monitor persistence but before receipt completion reuses the original subscription', async (t) => {
  const f = await fixture(t, [monitor]);
  await f.store.applyPreview('owner', preview(f.team, f.rule));
  const original = f.monitors.enrollRule.bind(f.monitors);
  f.monitors.enrollRule = async (...args) => {
    const result = await original(...args);
    await rename(f.file, `${f.file}.saved`);
    await mkdir(f.file);
    return result;
  };
  await assert.rejects(f.service.deliverActions(), /EISDIR|ENOTEMPTY|directory/);
  assert.equal(f.monitors.list('owner').length, 1);
  await rm(f.file, { recursive: true });
  await rename(`${f.file}.saved`, f.file);
  const store = await PRRuleStore.load(f.file);
  const monitors = await PRMonitorStore.load(f.monitorFile);
  const restarted = new PRRuleService(store, f.authorized, () => {}, undefined, undefined, {
    store: monitors,
    enrolled: async (id, owner) => monitors.get(id, owner),
  });
  await restarted.deliverActions();
  assert.equal(monitors.list('owner').length, 1);
  assert.equal(store.snapshot().actions![0].monitorId, monitors.list('owner')[0].id);
  assert.equal(store.snapshot().actions![0].status, 'applied');
});

test('disabling a rule before the monitor transaction withdraws unstarted enrollment', async (t) => {
  const f = await fixture(t, [monitor]);
  await f.store.applyPreview('owner', preview(f.team, f.rule));
  const original = f.monitors.enrollRule.bind(f.monitors);
  f.monitors.enrollRule = async (...args) => {
    await f.store.setEnabled('owner', f.rule.id, f.rule.revision, false, false);
    return original(...args);
  };
  await f.service.deliverActions();
  assert.equal(f.monitors.list('owner').length, 0);
  assert.equal(f.store.snapshot().actions![0].status, 'withdrawn');
});

test('a revalidated profile cannot authorize the captured older enrollment configuration', async (t) => {
  const f = await fixture(t, [monitor]);
  await f.store.applyPreview('owner', preview(f.team, f.rule));
  const original = f.monitors.enrollRule.bind(f.monitors);
  f.monitors.enrollRule = async (...args) => {
    const team = await f.store.saveTeam(
      'owner',
      {
        ...f.team.config,
        repositories: [{ ...f.team.config.repositories[0], project: 'new-project' }],
      },
      f.team.id,
      f.team.revision,
    );
    await f.store.applyPreview('owner', preview(team, f.rule));
    return original(...args);
  };
  await f.service.deliverActions();
  assert.equal(f.monitors.list('owner').length, 0);
  f.monitors.enrollRule = original;
  await f.service.deliverActions();
  assert.equal(f.monitors.list('owner')[0].config.project, 'new-project');
});

test('adding an action to admitted reviews requires a future revision or explicit backfill', async (t) => {
  const f = await fixture(t, [{ kind: 'review', autoStart: false }]);
  await f.store.applyPreview('owner', preview(f.team, f.rule));
  const changed = await f.store.saveRule(
    'owner',
    { ...f.rule.config, actions: [...f.rule.config.actions, notify] },
    f.rule.id,
    f.rule.revision,
  );
  await f.store.applyPreview('owner', preview(f.team, changed));
  assert.equal(f.store.snapshot().actions?.length ?? 0, 0);
  const backfill = await f.store.setEnabled('owner', changed.id, changed.revision, true, true);
  await f.store.applyPreview('owner', preview(f.team, backfill));
  assert.equal(f.store.snapshot().actions?.length, 1);
});

test('lost authority and incomplete observations cannot deliver pending actions', async (t) => {
  const f = await fixture(t, [notify, monitor]);
  const p = preview(f.team, f.rule);
  let allowed = true;
  const pending = f.store.applyPreview('owner', p, () => allowed);
  allowed = false;
  assert.equal(await pending, false);
  assert.equal(f.store.snapshot().actions?.length ?? 0, 0);
  await f.store.applyPreview('owner', p);
  await f.store.applyPreview('owner', {
    ...p,
    complete: false,
    sourceErrors: ['No provider access'],
  });
  await f.service.deliverActions();
  assert.equal(f.monitors.list('owner').length, 0);
  assert.equal(f.service.list('owner').notifications![0].current, false);
  f.active.delete('owner');
  assert.equal(f.service.list('recipient').notifications?.length, 0);
});

test('source expansion baselines newly discovered historical PRs until an actual change or backfill', async (t) => {
  const f = await fixture(t, [notify], false);
  await f.store.applyPreview('owner', preview(f.team, f.rule));
  const team = await f.store.saveTeam(
    'owner',
    {
      ...f.team.config,
      sources: [...f.team.config.sources, { kind: 'repository', repo: 'owner/other' }],
    },
    f.team.id,
    f.team.revision,
  );
  const expanded = preview(team, f.rule, 'head-a', 2);
  expanded.items[1].subject.pr.repo = 'owner/other';
  await f.store.applyPreview('owner', expanded);
  await f.store.applyPreview('owner', expanded);
  assert.equal(f.store.snapshot().actions?.length ?? 0, 0);
  expanded.items[1].subject.headSha = 'head-b';
  await f.store.applyPreview('owner', expanded);
  assert.equal(f.store.snapshot().actions?.length, 1);
  assert.equal(f.store.snapshot().actions![0].subject.pr.repo, 'owner/other');
});

test('newly collected predicate facts preserve prior receipts without announcing historical matches again', async (t) => {
  const f = await fixture(t, [notify, monitor]);
  await f.store.applyPreview('owner', preview(f.team, f.rule));
  await f.service.deliverActions();
  const changed = await f.store.saveRule(
    'owner',
    {
      ...f.rule.config,
      predicate: { kind: 'compare', field: 'changed-paths', operator: 'glob', value: ['**/*.ts'] },
    },
    f.rule.id,
    f.rule.revision,
  );
  const p = preview(f.team, changed);
  p.items[0].subject.facts['changed-paths'] = { state: 'known', value: ['src/index.ts'] };
  await f.store.applyPreview('owner', p);
  await f.store.applyPreview('owner', p);
  await f.service.deliverActions();
  assert.equal(f.store.snapshot().actions?.length, 2);
  assert.equal(f.monitors.list('owner').length, 1);
  assert.equal(f.service.list('owner').notifications?.filter((note) => note.current).length, 1);
});

test('changing source account does not repeat completed notifications or enroll another interest without backfill', async (t) => {
  const f = await fixture(t, [notify, monitor]);
  await f.store.applyPreview('owner', preview(f.team, f.rule));
  await f.service.deliverActions();
  const team = await f.store.saveTeam(
    'owner',
    { ...f.team.config, account: { host: 'github.com', login: 'another-reader' } },
    f.team.id,
    f.team.revision,
  );
  await f.store.applyPreview('owner', preview(team, f.rule));
  await f.service.deliverActions();
  assert.equal(f.store.snapshot().actions?.length, 2);
  assert.equal(f.monitors.list('owner').length, 1);
  const backfill = await f.store.setEnabled('owner', f.rule.id, f.rule.revision, true, true);
  await f.store.applyPreview('owner', preview(team, backfill));
  await f.service.deliverActions();
  assert.equal(f.store.snapshot().actions?.length, 4);
  assert.equal(f.monitors.list('owner').length, 2);
});

test('lowering limits revalidates all already-admitted pending monitor work', async (t) => {
  const f = await fixture(t, [monitor], true, 2);
  await f.store.applyPreview('owner', preview(f.team, f.rule, 'head-a', 2));
  const rule = await f.store.saveRule(
    'owner',
    { ...f.rule.config, maxAdmissionsPerScan: 1 },
    f.rule.id,
    f.rule.revision,
  );
  await f.store.applyPreview('owner', preview(f.team, rule, 'head-a', 2));
  assert.equal(
    f.store.snapshot().actions?.filter((action) => action.status === 'pending').length,
    2,
  );
  await f.service.deliverActions();
  assert.equal(f.monitors.list('owner').length, 2);
});

test('explicit backfill immediately after an account edit overrides revalidation-only receipt reuse', async (t) => {
  const f = await fixture(t, [notify, monitor]);
  await f.store.applyPreview('owner', preview(f.team, f.rule));
  await f.service.deliverActions();
  const team = await f.store.saveTeam(
    'owner',
    { ...f.team.config, account: { host: 'github.com', login: 'another-reader' } },
    f.team.id,
    f.team.revision,
  );
  const rule = await f.store.setEnabled('owner', f.rule.id, f.rule.revision, true, true);
  await f.store.applyPreview('owner', preview(team, rule));
  await f.service.deliverActions();
  assert.equal(f.store.snapshot().actions?.length, 4);
  assert.equal(f.monitors.list('owner').length, 2);
});

test('budget attention survives unchanged scans and restart until skipped matches are resolved', async (t) => {
  const f = await fixture(t, [notify], true, 1);
  const p = preview(f.team, f.rule, 'head-a', 2);
  await f.store.applyPreview('owner', p);
  const recovered = await PRRuleStore.load(f.file);
  await recovered.applyPreview('owner', p);
  assert.match(recovered.rule(f.rule.id, 'owner').scan.admissionWarning ?? '', /limit/);
  assert.equal(recovered.snapshot().actions?.length, 1);
  p.items[1].match = { state: 'no-match', reasons: [] };
  await recovered.applyPreview('owner', p);
  assert.equal(recovered.rule(f.rule.id, 'owner').scan.admissionWarning, undefined);
});

test('cached notification admission stays private until fresh target facts confirm the same revision', async (t) => {
  const f = await fixture(t, [{ kind: 'notify' }]);
  const cached = preview(f.team, f.rule);
  cached.sourceProgress = {
    id: 'checkpoint',
    startedAt: cached.checkedAt,
    pages: 2,
    items: 1,
    pendingConnections: 0,
    requestsThisAttempt: 1,
    resumed: true,
  };
  await f.store.applyPreview('owner', cached);
  assert.equal(f.store.snapshot().actions?.[0].status, 'pending');
  const service = new PRRuleService(
    f.store,
    f.authorized,
    () => {},
    undefined,
    undefined,
    undefined,
    async () => ({
      subjects: cached.items.map((item) => item.subject),
      complete: true,
      errors: [],
      ignoredItems: 0,
    }),
  );
  assert.equal(service.list('recipient').notifications?.length, 0);
  await service.deliverActions();
  assert.equal(service.list('recipient').notifications?.length, 1);
  assert.equal(f.store.snapshot().actions?.[0].status, 'applied');
});

test('changed fresh facts withdraw cached monitor admission without creating a subscription', async (t) => {
  const f = await fixture(t, [{ kind: 'monitor', policy: { mode: 'notify-only' } }]);
  const cached = preview(f.team, f.rule);
  cached.sourceProgress = {
    id: 'checkpoint',
    startedAt: cached.checkedAt,
    pages: 2,
    items: 1,
    pendingConnections: 0,
    requestsThisAttempt: 1,
    resumed: true,
  };
  await f.store.applyPreview('owner', cached);
  const service = new PRRuleService(
    f.store,
    f.authorized,
    () => {},
    undefined,
    undefined,
    { store: f.monitors, enrolled: async (id, owner) => f.monitors.get(id, owner) },
    async () => ({
      subjects: cached.items.map((item) => ({ ...item.subject, headSha: 'new-head' })),
      complete: true,
      errors: [],
      ignoredItems: 0,
    }),
  );
  await service.deliverActions();
  assert.equal(f.monitors.snapshot().monitors.length, 0);
  assert.equal(f.store.snapshot().actions?.[0].status, 'withdrawn');
  assert.match(f.store.snapshot().actions?.[0].error ?? '', /facts changed/);
});

test('retry eligibility lets healthy actions advance beyond a failing validation batch', async (t) => {
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const f = await fixture(t, [{ kind: 'notify' }], true, 30);
  const cached = preview(f.team, f.rule, 'head-a', 26);
  cached.sourceProgress = {
    id: 'checkpoint',
    startedAt: cached.checkedAt,
    pages: 26,
    items: 26,
    pendingConnections: 0,
    requestsThisAttempt: 1,
    resumed: true,
  };
  await f.store.applyPreview('owner', cached);
  let reads = 0;
  const service = new PRRuleService(
    f.store,
    f.authorized,
    () => {},
    undefined,
    undefined,
    undefined,
    async (_team, _rule, pr) => {
      reads++;
      if (pr.number < 26) {
        now += 5_000;
        throw new Error('Temporary source access failure');
      }
      return {
        subjects: cached.items
          .filter((item) => item.subject.pr.number === pr.number)
          .map((item) => item.subject),
        complete: true,
        errors: [],
        ignoredItems: 0,
      };
    },
  );
  await service.deliverActions();
  assert.equal(reads, 25);
  assert.equal(service.list('owner').notifications?.length, 0);
  await service.deliverActions();
  assert(
    (service.list('owner').notifications ?? []).some((note) => note.pr.number === 26),
    'Never-attempted healthy action must precede slow failures whose retry times have passed',
  );
  assert.equal(service.list('owner').notifications?.[0].pr.number, 26);
  assert(
    f.store
      .snapshot()
      .actions?.filter((action) => action.error)
      .every((action) => action.nextValidationAt),
  );
});
