import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import type { PRMonitorObservation, PRTeamConfig } from '@farmslot/protocol';

import { PRMonitoringService } from '../pr-monitoring/service.js';
import { PRMonitorStore } from '../pr-monitoring/store.js';
import { PRRuleService } from '../pr-rules/service.js';
import { PRRuleStore } from '../pr-rules/store.js';

import { prPushSources } from './sources.js';

const observation: PRMonitorObservation = {
  checkedAt: new Date().toISOString(),
  headSha: 'head-a',
  title: 'Example PR',
  author: 'author',
  state: 'open',
  draft: false,
  mergeability: 'mergeable',
  reviewDecision: 'changes-requested',
  signals: [
    {
      key: 'review-1',
      revision: 'revision-1',
      kind: 'review',
      summary: 'Changes requested',
      url: 'https://github.com/example/repo/pull/1#review-1',
    },
  ],
};

test('team incident audiences retain their own acknowledgement and lose access when the account binding changes', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'pr-push-audience-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const active = new Set(['owner', 'recipient', 'unrelated']);
  const authorized = (id: string) => active.has(id);
  const monitorStore = await PRMonitorStore.load(join(directory, 'monitors.json'));
  const ruleStore = await PRRuleStore.load(join(directory, 'rules.json'));
  const monitors = new PRMonitoringService(
    monitorStore,
    authorized,
    () => {},
    async () => observation,
  );
  const rules = new PRRuleService(ruleStore, authorized, () => {});
  const config: PRTeamConfig = {
    name: 'Example team',
    account: { host: 'github.com', login: 'reader' },
    sources: [{ kind: 'repository', repo: 'example/repo' }],
    repositories: [],
    githubTeams: [],
    predicate: { kind: 'compare', field: 'state', operator: 'equals', value: 'open' },
    notificationPrincipalIds: ['recipient'],
  };
  const team = await ruleStore.saveTeam('owner', config);
  let monitor = await monitorStore.subscribe('owner', {
    pr: { host: 'github.com', repo: 'example/repo', number: 1 },
    account: config.account,
    teamId: team.id,
    policy: { mode: 'notify-only' },
    watchedChecks: [],
    pollIntervalMs: 300_000,
    cooldownMs: 300_000,
    automaticAttemptLimit: 2,
  });
  monitor = (await monitorStore.observe(monitor.id, 'owner', monitor.revision, { observation }))!;
  const read = (id: string) => prPushSources(id, monitors, rules, authorized);
  assert.equal(read('recipient').length, 1);
  assert.equal(read('unrelated').length, 0);
  const shared = read('recipient')[0];
  assert.equal(shared.current, true);
  assert(
    !('account' in shared) && !('config' in shared),
    'Audience sharing cannot reveal policy or credentials',
  );
  await monitorStore.acknowledge(monitor.id, 'owner', monitor.revision, monitor.incidents[0].id);
  assert(read('owner')[0].acknowledgedAt);
  assert.equal(
    read('recipient')[0].acknowledgedAt,
    undefined,
    'Owner acknowledgement must not acknowledge for another recipient',
  );
  assert.equal(
    read('recipient')[0].current,
    true,
    'Acknowledgement is separate from GitHub resolution',
  );
  await ruleStore.saveTeam(
    'owner',
    { ...config, account: { ...config.account, login: 'different-reader' } },
    team.id,
    team.revision,
  );
  assert.equal(
    read('recipient').length,
    0,
    'Changing credential context must withdraw shared incident access',
  );
  assert.equal(read('owner').length, 1);
  active.delete('owner');
  assert.equal(read('owner').length, 0);
  assert.equal(read('recipient').length, 0);
});
