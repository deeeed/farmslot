import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test, type TestContext } from 'node:test';

import type { PRRuleSubject } from '@farmslot/protocol';

const root = mkdtempSync(path.join(tmpdir(), 'pr-qa-farm-defaults-'));
for (const directory of ['scripts', 'services/gateway', 'pool', 'projects/farm', 'repo'])
  mkdirSync(path.join(root, directory), { recursive: true });
writeFileSync(path.join(root, 'CLAUDE.md'), '# Isolated QA intake fixture\n');
writeFileSync(path.join(root, 'scripts/dev.sh'), '#!/bin/sh\n');
writeFileSync(path.join(root, 'services/gateway/package.json'), '{}');
const execution = {
  slotPolicy: { kind: 'exact' as const, slotId: 'runtime' },
  models: [{ runner: 'codex', model: 'gpt-6-astra', effort: 'high' }],
};
const config = {
  name: 'farm',
  repo_url: 'https://github.com/example/app.git',
  ci: { repo: 'example/app' },
  workflow_defaults: { qa: { execution } },
  qa: {
    default_profile: 'changes',
    profiles: [
      {
        id: 'changes',
        title: 'Changed behavior',
        template_id: 'validation/shared',
        inputs: { scope: 'pr' },
      },
      {
        id: 'release',
        title: 'Release',
        template_id: 'validation/shared',
        inputs: { scope: 'release' },
      },
    ],
  },
};
const projectPath = path.join(root, 'projects/farm/project.json');
writeFileSync(projectPath, JSON.stringify(config));
writeFileSync(
  path.join(root, 'pool/runtime.json'),
  JSON.stringify({
    machine: 'runtime-host',
    project: 'farm',
    host: 'localhost',
    platform: 'cli',
    slots: [
      {
        id: 'runtime',
        enabled: true,
        repo: path.join(root, 'repo'),
        session: 'fixture-runtime',
        resources: {},
      },
    ],
  }),
);
writeFileSync(
  path.join(root, '.farm-status.json'),
  JSON.stringify({
    checked_at: new Date().toISOString(),
    slots: [
      {
        slot: 'runtime',
        machine: 'runtime-host',
        project: 'farm',
        platform: 'cli',
        lifecycle: 'ready',
        agent: 'idle',
      },
    ],
  }),
);
Object.assign(process.env, {
  FARMSLOT_ROOT: root,
  FARMSLOT_HOME: path.join(root, 'home'),
  FARMSLOT_PROJECTS_DIR: path.join(root, 'projects'),
  FARMSLOT_POOL_DIR: path.join(root, 'pool'),
  NODE_TEST_CONTEXT: '1',
  FARMSLOT_TEST_STATUS_FILE: path.join(root, '.farm-status.json'),
});
after(() => rmSync(root, { recursive: true, force: true }));
const { PRRuleService } = await import('./service.js');
const { PRRuleStore } = await import('./store.js');
const { reviewIntentAuthorized } = await import('./intents.js');

const subject: PRRuleSubject = {
  pr: { host: 'github.com', repo: 'example/app', number: 42 },
  headSha: 'head',
  title: 'Approved target',
  observedAt: new Date().toISOString(),
  facts: { state: { state: 'known', value: 'open' }, draft: { state: 'known', value: false } },
  reviewObservation: {
    observedAt: new Date().toISOString(),
    headSha: 'head',
    state: 'open',
    draft: false,
    decision: 'APPROVED',
    reviewer: 'reviewer',
    requested: false,
    review: { state: 'COMMENTED', commit: 'head', submittedAt: null },
  },
};
const scan = { subjects: [subject], complete: true, errors: [], ignoredItems: 0 };
const review = {
  sessionIntent: 'resume' as const,
  scope: 'full' as const,
  workflow: 'qa' as const,
};

async function fixture(t: TestContext) {
  const store = await PRRuleStore.load(path.join(root, `rules-${Math.random()}.json`));
  const service = new PRRuleService(
    store,
    () => true,
    () => {},
    async () => scan,
    async () => scan,
  );
  t.after(() => service.stop());
  const predicate = {
    kind: 'compare' as const,
    field: 'state' as const,
    operator: 'equals' as const,
    value: 'open',
  };
  const team = await service.saveTeam('owner', {
    name: 'Team',
    account: { host: 'github.com', login: 'reviewer' },
    sources: [{ kind: 'repository', repo: 'example/app' }],
    predicate,
    repositories: [
      { repo: 'example/app', project: 'farm', reviewProfile: 'standard', excludedLabels: [] },
    ],
    review,
    githubTeams: [],
    notificationPrincipalIds: [],
  });
  const rule = await service.saveRule('owner', {
    name: 'QA',
    teamId: team.id,
    predicate,
    actions: [{ kind: 'review', autoStart: false }],
    pollIntervalMs: 300_000,
    maxAdmissionsPerScan: 10,
    rereviewOnHeadChange: true,
  });
  return { store, service, team, rule };
}

test('rule previews resolve farm QA placement, profile and inputs before validation', async (t) => {
  const { store, service, rule } = await fixture(t);
  const before = store.snapshot();
  const result = await service.preview('owner', rule.id);
  assert.deepEqual(result.items[0].execution, execution);
  assert.equal(result.items[0].review?.qaProfileId, 'changes');
  assert.deepEqual(result.items[0].review?.qaInputs, { scope: 'pr' });
  assert.deepEqual(result.items[0].configurationErrors, []);
  assert.notEqual(
    result.items[0].reviewPurpose?.configured,
    result.items[0].reviewPurpose?.resolved,
  );
  assert.deepEqual(store.snapshot(), before);
});

test('approved PR QA submissions deduplicate resolved defaults and refresh pending profile changes', async (t) => {
  const { store, service, team } = await fixture(t);
  const request = {
    teamId: team.id,
    pr: subject.pr,
    autoStart: false,
    source: { client: 'test' },
    review,
  };
  const first = await store.submit('owner', { ...request, idempotencyKey: 'implicit' });
  const implicit = await service.refreshSubmission('owner', first.id);
  const second = await store.submit('owner', {
    ...request,
    idempotencyKey: 'explicit',
    review: { ...review, qaProfileId: 'changes', qaInputs: { scope: 'pr' } },
  });
  const explicit = await service.refreshSubmission('owner', second.id);
  assert.equal(explicit.intentId, implicit.intentId);
  const accepted = await store.decideReview(implicit.intentId!, 'owner', 'accept');
  assert.equal(reviewIntentAuthorized(accepted), true);
  writeFileSync(
    projectPath,
    JSON.stringify({ ...config, qa: { ...config.qa, default_profile: 'release' } }),
  );
  try {
    const refreshed = await service.refreshSubmission('owner', first.id);
    assert.equal(refreshed.id, first.id);
    assert.notEqual(refreshed.intentId, implicit.intentId);
    const intent = store.intent(refreshed.intentId!)!;
    assert.equal(
      intent.contributions.find((item) => item.submissionId === first.id)?.review?.qaProfileId,
      'release',
    );
    assert.equal(
      store
        .intent(explicit.intentId!)
        ?.contributions.find((item) => item.submissionId === second.id)?.review?.qaProfileId,
      'changes',
    );
    assert.equal(intent.status, 'held');
  } finally {
    writeFileSync(projectPath, JSON.stringify(config));
  }
});
