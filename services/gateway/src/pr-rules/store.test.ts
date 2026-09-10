import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import type {
  PRExecutionProfile,
  PRRulePreview,
  PRTeamConfig,
  PRTeamProfile,
  PRTriggerRule,
} from '@farmslot/protocol';

import { PRRuleStore } from './store.js';

const execution: PRExecutionProfile = {
  slotPolicy: { kind: 'exact', slotId: 'slot-a' },
  models: [{ runner: 'runner', model: 'model', effort: 'high' }],
};
const teamConfig: PRTeamConfig = {
  name: 'Team',
  account: { host: 'github.com', login: 'reader' },
  sources: [{ kind: 'repository', repo: 'owner/repo' }],
  predicate: { kind: 'compare', field: 'state', operator: 'equals', value: 'open' },
  repositories: [
    { repo: 'owner/repo', project: 'project', reviewProfile: 'standard', excludedLabels: [] },
  ],
  execution,
  githubTeams: [],
  notificationPrincipalIds: [],
};

test('overlapping review policies with different continuity or QA depth hold one shared intent', async (t) => {
  const { store } = await fixture(t);
  const first = await ruleFor(store, 'owner', true);
  const second = await ruleFor(store, 'owner', true);
  await store.applyPreview('owner', preview(first.team, first.rule));
  const changed = preview(second.team, second.rule);
  changed.items[0].review = { sessionIntent: 'reset', scope: 'full', validationDepth: 'full-live' };
  await store.applyPreview('owner', changed);
  assert.equal(store.snapshot().intents.length, 1);
  assert.equal(store.snapshot().intents[0].status, 'needs-configuration');
  assert.match(store.snapshot().intents[0].waitingReason ?? '', /continuity or validation depth/);
});

async function fixture(t: test.TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'pr-rule-store-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'rules.json');
  return { file, store: await PRRuleStore.load(file) };
}
async function ruleFor(store: PRRuleStore, ownerId: string, backfill = false) {
  const team = await store.saveTeam(ownerId, teamConfig);
  const rule = await store.saveRule(ownerId, {
    name: 'Review',
    teamId: team.id,
    predicate: teamConfig.predicate,
    actions: [{ kind: 'review', autoStart: false }],
    pollIntervalMs: 300_000,
    maxAdmissionsPerScan: 10,
    rereviewOnHeadChange: false,
  });
  assert.equal(rule.enabled, false);
  return { team, rule: await store.setEnabled(ownerId, rule.id, rule.revision, true, backfill) };
}
function preview(team: PRTeamProfile, rule: PRTriggerRule, headSha = 'head-a'): PRRulePreview {
  return {
    teamId: team.id,
    teamRevision: team.revision,
    ruleId: rule.id,
    ruleRevision: rule.revision,
    checkedAt: new Date().toISOString(),
    complete: true,
    sourceErrors: [],
    ignoredItems: 0,
    items: [
      {
        subject: {
          pr: { host: 'github.com', repo: 'owner/repo', number: 1 },
          headSha,
          title: 'PR',
          observedAt: new Date().toISOString(),
          facts: {
            state: { state: 'known', value: 'open' },
            draft: { state: 'known', value: false },
          },
        },
        match: { state: 'match', reasons: ['Configured team matched'] },
        project: 'project',
        reviewProfile: 'standard',
        execution,
        configurationErrors: [],
      },
    ],
  };
}

test('activation baselines existing PRs; later changes admit once and survive restart', async (t) => {
  const { store, file } = await fixture(t);
  const { team, rule } = await ruleFor(store, 'owner');
  await store.applyPreview('owner', preview(team, rule));
  assert.equal(store.list('owner').intents.length, 0);
  const changed = preview(team, rule, 'head-b');
  await Promise.all([store.applyPreview('owner', changed), store.applyPreview('owner', changed)]);
  assert.equal(store.list('owner').intents.length, 1);
  assert.equal(store.list('owner').intents[0].status, 'held');
  const reloaded = await PRRuleStore.load(file);
  await reloaded.applyPreview('owner', changed);
  assert.equal(reloaded.list('owner').intents.length, 1);
});

test('overlapping teams deduplicate reviews, intersect constraints, and filter private provenance', async (t) => {
  const { store } = await fixture(t);
  const one = await ruleFor(store, 'owner-a', true);
  const two = await ruleFor(store, 'owner-b', true);
  await store.applyPreview('owner-a', preview(one.team, one.rule));
  const incompatible = preview(two.team, two.rule);
  incompatible.items[0].execution = {
    ...execution,
    slotPolicy: { kind: 'exact', slotId: 'slot-b' },
  };
  await store.applyPreview('owner-b', incompatible);
  assert.equal(store.snapshot().intents.length, 1);
  assert.equal(store.snapshot().intents[0].contributions.length, 2);
  assert.equal(store.list('owner-a').intents[0].contributions.length, 1);
  assert.equal(store.list('owner-a').intents[0].status, 'needs-configuration');
  await store.setEnabled('owner-b', two.rule.id, two.rule.revision, false, false);
  assert.equal(store.list('owner-a').intents[0].status, 'held');
  assert.throws(() => store.rule(two.rule.id, 'owner-a'), /not found/);
});

test('profile edits invalidate pending authority and stale previews cannot restore it', async (t) => {
  const { store } = await fixture(t);
  const { team, rule } = await ruleFor(store, 'owner', true);
  const old = preview(team, rule);
  await store.applyPreview('owner', old);
  await store.saveTeam('owner', { ...teamConfig, name: 'Renamed' }, team.id, team.revision);
  assert.equal(store.list('owner').intents[0].status, 'withdrawn');
  assert.equal(await store.applyPreview('owner', old), false);
  assert.equal(store.list('owner').intents[0].status, 'withdrawn');
});

test('latest heads replace unstarted reviews even when repeat completed reviews are disabled', async (t) => {
  const { store } = await fixture(t);
  const { team, rule } = await ruleFor(store, 'owner', true);
  await store.applyPreview('owner', preview(team, rule));
  await store.applyPreview('owner', preview(team, rule, 'head-b'));
  const intents = store.list('owner').intents;
  assert.equal(intents.find((item) => item.headSha === 'head-a')?.status, 'withdrawn');
  assert.equal(intents.find((item) => item.headSha === 'head-b')?.status, 'held');
});

test('source failure preserves prior evidence and missing execution mapping stays actionable', async (t) => {
  const { store } = await fixture(t);
  const { team, rule } = await ruleFor(store, 'owner', true);
  const input = preview(team, rule);
  delete input.items[0].project;
  input.items[0].configurationErrors = ['No project mapping'];
  await store.applyPreview('owner', input);
  assert.equal(store.list('owner').intents[0].status, 'needs-configuration');
  await store.applyPreview('owner', {
    ...input,
    complete: false,
    sourceErrors: ['Project access lost'],
    items: [],
  });
  assert.equal(store.list('owner').intents[0].status, 'needs-configuration');
  assert.match(store.rule(rule.id, 'owner').scan.error ?? '', /access lost/);
});

test('re-enabling without backfill does not revive withdrawn historical work on later scans', async (t) => {
  const { store } = await fixture(t);
  const { team, rule } = await ruleFor(store, 'owner', true);
  await store.applyPreview('owner', preview(team, rule));
  const disabled = await store.setEnabled('owner', rule.id, rule.revision, false, false);
  const enabled = await store.setEnabled('owner', rule.id, disabled.revision, true, false);
  await store.applyPreview('owner', preview(team, enabled));
  await store.applyPreview('owner', preview(team, enabled));
  assert.equal(store.list('owner').intents[0].status, 'withdrawn');
  await store.applyPreview('owner', preview(team, enabled, 'head-b'));
  assert.equal(
    store.list('owner').intents.find((item) => item.headSha === 'head-b')?.status,
    'held',
  );
});

test('backfill counts reactivated historical intents toward the per-scan admission limit', async (t) => {
  const { store } = await fixture(t);
  const initial = await ruleFor(store, 'owner', true);
  let rule = await store.saveRule(
    'owner',
    { ...initial.rule.config, maxAdmissionsPerScan: 1 },
    initial.rule.id,
    initial.rule.revision,
  );
  const scan = preview(initial.team, rule);
  scan.items.push({
    ...scan.items[0],
    subject: { ...scan.items[0].subject, pr: { ...scan.items[0].subject.pr, number: 2 } },
  });
  await store.applyPreview('owner', scan);
  assert.equal(store.list('owner').intents.filter((item) => item.status === 'held').length, 1);
  rule = await store.setEnabled('owner', rule.id, rule.revision, false, false);
  rule = await store.setEnabled('owner', rule.id, rule.revision, true, true);
  await store.applyPreview('owner', { ...scan, ruleRevision: rule.revision });
  assert.equal(store.list('owner').intents.filter((item) => item.status === 'held').length, 1);
});

test('configuration revalidation preserves already-admitted pending work above a new admission limit', async (t) => {
  const { store } = await fixture(t);
  const { team, rule } = await ruleFor(store, 'owner', true);
  const scan = preview(team, rule);
  scan.items.push({
    ...scan.items[0],
    subject: { ...scan.items[0].subject, pr: { ...scan.items[0].subject.pr, number: 2 } },
  });
  await store.applyPreview('owner', scan);
  const updated = await store.saveRule(
    'owner',
    { ...rule.config, maxAdmissionsPerScan: 1 },
    rule.id,
    rule.revision,
  );
  await store.applyPreview('owner', { ...scan, ruleRevision: updated.revision });
  assert.equal(store.list('owner').intents.filter((item) => item.status === 'held').length, 2);
});

test('targeted head and eligibility refresh updates only the admitted PR without rewriting full-scan coverage', async (t) => {
  const { store } = await fixture(t);
  const { team, rule } = await ruleFor(store, 'owner', true);
  const initial = preview(team, rule);
  const other = structuredClone(initial.items[0]);
  other.subject.pr.number = 2;
  initial.items.push(other);
  await store.applyPreview('owner', initial);
  const before = structuredClone(store.rule(rule.id, 'owner').scan);
  const fresh = preview(team, rule, 'head-b');
  await store.applyPreview('owner', fresh, () => true, 'github.com/owner/repo#1');
  const after = store.snapshot().intents;
  assert.equal(after.find((intent) => intent.pr.number === 2)?.contributions[0].eligible, true);
  assert.equal(
    after.find((intent) => intent.pr.number === 1 && intent.headSha === 'head-a')?.status,
    'withdrawn',
  );
  assert.equal(
    after.find((intent) => intent.pr.number === 1 && intent.headSha === 'head-b')?.contributions[0]
      .eligible,
    true,
  );
  assert.deepEqual(
    store.rule(rule.id, 'owner').scan,
    before,
    'One PR cannot certify or consume a full source traversal',
  );
  await store.applyPreview('owner', { ...fresh, items: [] }, () => true, 'github.com/owner/repo#1');
  assert.equal(
    store.snapshot().intents.find((intent) => intent.pr.number === 1 && intent.headSha === 'head-b')
      ?.status,
    'withdrawn',
  );
  assert.equal(
    store.snapshot().intents.find((intent) => intent.pr.number === 2)?.contributions[0].eligible,
    true,
  );
});

test('later matching and nonmatching scans preserve completed and failed review records', async (t) => {
  for (const status of ['completed', 'failed'] as const) {
    const { store } = await fixture(t);
    const { team, rule } = await ruleFor(store, 'owner', true);
    const input = preview(team, rule, `head-${status}`);
    await store.applyPreview('owner', input);
    const intent = store.snapshot().intents.find((i) => i.headSha === `head-${status}`)!;
    await store.updateDispatch(intent.id, { status, reviewedSha: intent.headSha });
    const before = store.intent(intent.id);
    input.checkedAt = new Date(Date.now() + 1000).toISOString();
    input.items[0].match.reasons = ['New scan reasons'];
    await store.applyPreview('owner', input);
    assert.deepEqual(store.intent(intent.id), before);
    await store.applyPreview('owner', { ...input, items: [] });
    assert.deepEqual(store.intent(intent.id), before);
    await store.saveTeam('owner', { ...team.config, name: 'Updated team' }, team.id, team.revision);
    assert.deepEqual(store.intent(intent.id), before);
    const changed = await store.saveRule(
      'owner',
      { ...rule.config, name: 'Updated rule' },
      rule.id,
      rule.revision,
    );
    assert.deepEqual(store.intent(intent.id), before);
    await store.setEnabled('owner', changed.id, changed.revision, false, false);
    assert.deepEqual(store.intent(intent.id), before);
  }
});
