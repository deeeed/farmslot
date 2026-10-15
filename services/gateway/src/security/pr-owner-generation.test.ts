import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import type { PRMonitorConfig, PRTeamConfig } from '@farmslot/protocol';

import { PRMonitoringService } from '../pr-monitoring/service.js';
import { PRMonitorStore } from '../pr-monitoring/store.js';
import { PRPushService } from '../pr-push/service.js';
import { PRPushStore } from '../pr-push/store.js';
import { PRRuleService } from '../pr-rules/service.js';
import { PRRuleStore } from '../pr-rules/store.js';

import { principalOwnerGeneration, runWithPrincipalOwner } from './work-originator.js';

const owner = 'reused-person';
const replacement = { ownerId: owner, ownerGeneration: 1 };
const authorized = (id: string, generation = principalOwnerGeneration(id)) =>
  id === owner && generation === 1;
const config: PRMonitorConfig = {
  pr: { host: 'github.com', repo: 'example/project', number: 1 },
  account: { host: 'github.com', login: 'reader' },
  policy: { mode: 'notify-only' },
  pollIntervalMs: 60_000,
  watchedChecks: [],
  automaticAttemptLimit: 1,
  cooldownMs: 60_000,
};
const teamConfig: PRTeamConfig = {
  name: 'Review team',
  account: config.account,
  sources: [{ kind: 'repository', repo: config.pr.repo }],
  predicate: { kind: 'compare', field: 'state', operator: 'equals', value: 'open' },
  repositories: [],
  githubTeams: [],
  notificationPrincipalIds: [],
};
async function scratch(t: test.TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'pr-owner-generation-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('fresh monitor and project policy survive reload without adopting generation-zero subscriptions', async (t) => {
  const dir = await scratch(t);
  const file = join(dir, 'monitors.json');
  const store = await PRMonitorStore.load(file);
  const old = await store.subscribe(owner, config);
  const policy = { ...config };
  await store.saveProjectPolicy(owner, 'project', true, policy);
  let reads = 0;
  const service = new PRMonitoringService(
    store,
    authorized,
    () => {},
    async () => {
      reads++;
      assert.equal(principalOwnerGeneration(owner), 1);
      return {
        checkedAt: new Date().toISOString(),
        headSha: 'head',
        title: 'PR',
        author: 'reader',
        state: 'open',
        draft: false,
        mergeability: 'mergeable',
        reviewDecision: 'unknown',
        signals: [],
      };
    },
    () => [],
  );
  const fresh = await runWithPrincipalOwner(replacement, async () => {
    assert.deepEqual(store.list(owner), []);
    assert.throws(() => store.get(old.id, owner), /not found/);
    const result = await service.subscribe(owner, config);
    const saved = await store.saveProjectPolicy(owner, 'project', true, policy);
    assert.equal(saved.ownerGeneration, 1);
    assert.equal(store.projectPolicies(owner).length, 1);
    return result;
  });
  assert.equal(fresh.ownerGeneration, 1);
  assert.notEqual(fresh.id, old.id);
  reads = 0;
  // The unrelated waking caller must not decide the subscription's identity.
  await runWithPrincipalOwner({ ownerId: owner, ownerGeneration: 2 }, () =>
    service.tick(Date.now() + 60_001),
  );
  assert.equal(reads, 1);
  assert.equal(store.snapshot().monitors.find((m) => m.id === old.id)?.observation, undefined);
  const restored = await PRMonitorStore.load(file);
  runWithPrincipalOwner(replacement, () => {
    assert.deepEqual(
      restored.list(owner).map((m) => m.id),
      [fresh.id],
    );
    assert.equal(restored.projectPolicies(owner)[0].ownerGeneration, 1);
  });
});

test('fresh rule background actions inherit generation and cannot edit the old team or rule', async (t) => {
  const dir = await scratch(t);
  const file = join(dir, 'rules.json');
  const store = await PRRuleStore.load(file);
  const oldTeam = await store.saveTeam(owner, teamConfig);
  const ruleConfig = {
    name: 'Notify',
    teamId: oldTeam.id,
    predicate: teamConfig.predicate,
    actions: [{ kind: 'notify' as const }],
    pollIntervalMs: 60_000,
    maxAdmissionsPerScan: 1,
    rereviewOnHeadChange: false,
  };
  const oldRule = await store.saveRule(owner, ruleConfig);
  await store.setEnabled(owner, oldRule.id, oldRule.revision, true, true);
  let reads = 0;
  const service = new PRRuleService(
    store,
    authorized,
    () => {},
    async () => {
      reads++;
      assert.equal(principalOwnerGeneration(owner), 1);
      return {
        subjects: [
          {
            pr: config.pr,
            headSha: 'head',
            title: 'PR',
            observedAt: new Date().toISOString(),
            facts: {
              state: { state: 'known', value: 'open' },
              draft: { state: 'known', value: false },
            },
          },
        ],
        complete: true,
        errors: [],
        ignoredItems: 0,
      };
    },
  );
  const fresh = await runWithPrincipalOwner(replacement, async () => {
    assert.equal(service.list(owner).teams.length, 0);
    await assert.rejects(
      service.saveTeam(owner, teamConfig, oldTeam.id, oldTeam.revision),
      /unavailable/,
    );
    const team = await service.saveTeam(owner, teamConfig);
    assert.equal(team.ownerGeneration, 1);
    const rule = await service.saveRule(owner, { ...ruleConfig, teamId: team.id });
    await store.setEnabled(owner, rule.id, rule.revision, true, true);
    return rule;
  });
  await runWithPrincipalOwner({ ownerId: owner, ownerGeneration: 2 }, () => service.tick());
  assert.equal(reads, 1);
  assert.equal(store.snapshot().actions?.[0].ownerGeneration, 1);
  assert.equal(store.snapshot().rules.find((r) => r.id === oldRule.id)?.scan.checkedAt, undefined);
  const restored = await PRRuleStore.load(file);
  runWithPrincipalOwner(replacement, () => {
    assert.deepEqual(
      restored.list(owner).rules.map((r) => r.id),
      [fresh.id],
    );
    assert.equal(service.list(owner).notifications?.length, 1);
  });
});

test('push registration, acknowledgements and delayed delivery stay with the device generation', async (t) => {
  const dir = await scratch(t);
  const store = await PRPushStore.load(join(dir, 'push.json'));
  const registration = {
    installationId: 'phone',
    profileId: 'gateway',
    platform: 'ios' as const,
    token: 'ExpoPushToken[old]',
    enabled: true,
    sound: true,
  };
  const old = await store.register(owner, registration, () => true);
  await store.acknowledge(owner, 'source', () => true);
  let sent = 0;
  const service = new PRPushService(
    store,
    authorized,
    () => {
      assert.equal(principalOwnerGeneration(owner), 1);
      return [
        {
          id: 'source',
          kind: 'rule',
          title: 'Review',
          body: 'Changes',
          route: '/pr-automation',
          createdAt: new Date().toISOString(),
          current: true,
        },
      ];
    },
    {
      send: async (device) => {
        sent++;
        assert.equal(device.ownerGeneration, 1);
        return { status: 'delivered' };
      },
      receipt: async () => ({ status: 'delivered' }),
    },
  );
  await runWithPrincipalOwner(replacement, async () => {
    assert.deepEqual(service.list(owner).devices, []);
    assert.equal(service.attention(owner)[0].acknowledgedAt, undefined);
    const fresh = await service.register(owner, { ...registration, token: 'ExpoPushToken[fresh]' });
    assert.notEqual(fresh.id, old.id);
    assert.equal(service.list(owner).devices.length, 1);
  });
  await runWithPrincipalOwner({ ownerId: owner, ownerGeneration: 2 }, () => service.tick());
  assert.equal(sent, 1);
  runWithPrincipalOwner(replacement, () => {
    assert.equal(service.list(owner).deliveries[0].state, 'delivered');
  });
});
