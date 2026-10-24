import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import type {
  PRMonitorConfig,
  PRProjectMonitorPolicy,
  PRPushAttention,
  PRPushRegisterParams,
  PRTeamConfig,
} from '@farmslot/protocol';

import { publishPRAutomationResources } from './pr-automation-changes.js';
import { GatewayResourceRevisions, resourceRevisions } from './revisions.js';

await import('../runtime/mock-pty.test-support.js');
const { PRRepairDispatcher } = await import('../pr-monitoring/dispatch.js');
const { PRMonitoringService } = await import('../pr-monitoring/service.js');
const { PRPublicationEnrollment } = await import('../pr-monitoring/publication.js');
const { PRMonitorStore } = await import('../pr-monitoring/store.js');
const { PRPushService } = await import('../pr-push/service.js');
const { PRPushStore } = await import('../pr-push/store.js');
const { PRReviewDispatcher } = await import('../pr-rules/dispatch.js');
const { PRRuleService } = await import('../pr-rules/service.js');
const { PRRuleStore } = await import('../pr-rules/store.js');

const key = { family: 'pr-automation', scope: 'farm' } as const;
const monitorConfig: PRMonitorConfig = {
  pr: { host: 'github.com', repo: 'owner/repo', number: 123 },
  account: { host: 'github.com', login: 'reader' },
  policy: { mode: 'notify-only' },
  pollIntervalMs: 300_000,
  watchedChecks: [],
  automaticAttemptLimit: 2,
  cooldownMs: 300_000,
};
const teamConfig: PRTeamConfig = {
  name: 'Team',
  account: { host: 'github.com', login: 'reader' },
  sources: [{ kind: 'repository', repo: 'owner/repo' }],
  predicate: { kind: 'compare', field: 'state', operator: 'equals', value: 'open' },
  repositories: [
    { repo: 'owner/repo', project: 'project', reviewProfile: 'standard', excludedLabels: [] },
  ],
  execution: {
    slotPolicy: { kind: 'exact', slotId: 'slot-a' },
    models: [{ mode: 'cold', runner: 'runner', model: 'model', effort: 'high' }],
  },
  githubTeams: [],
  notificationPrincipalIds: [],
};
const registration: PRPushRegisterParams = {
  installationId: 'phone',
  profileId: 'gateway',
  token: 'ExpoPushToken[private-test-token]',
  platform: 'ios',
  enabled: true,
  sound: true,
};

async function directory(t: test.TestContext): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'pr-resource-writers-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function advances(write: () => Promise<unknown>): Promise<void> {
  const before = resourceRevisions.revision(key);
  await write();
  assert.equal(resourceRevisions.revision(key), before + 1);
}

test('PR notifications contain only the authorized canonical farm key', (t) => {
  const revisions = new GatewayResourceRevisions();
  t.after(() => revisions.dispose());
  const seen: unknown[] = [];
  const advance = revisions.advance.bind(revisions);
  t.mock.method(
    revisions,
    'advance',
    (...[changedKey, kind]: Parameters<GatewayResourceRevisions['advance']>) => {
      seen.push(changedKey);
      advance(changedKey, kind);
    },
  );
  publishPRAutomationResources(revisions);
  assert.deepEqual(seen, [key]);
  assert.equal(revisions.revision(key), 1);
});

test('all PR store notifications observe committed disk bytes and the new readable memory', async (t) => {
  const dir = await directory(t);
  const monitorFile = join(dir, 'monitors.json');
  const ruleFile = join(dir, 'rules.json');
  const pushFile = join(dir, 'push.json');
  const monitors = await PRMonitorStore.load(monitorFile);
  const rules = await PRRuleStore.load(ruleFile);
  const push = await PRPushStore.load(pushFile);
  let currentFile = monitorFile;
  let currentSnapshot: () => unknown = () => monitors.snapshot();
  const advance = resourceRevisions.advance.bind(resourceRevisions);
  t.mock.method(
    resourceRevisions,
    'advance',
    (...[changedKey, kind]: Parameters<GatewayResourceRevisions['advance']>) => {
      if (changedKey.family === 'pr-automation')
        assert.deepEqual(JSON.parse(readFileSync(currentFile, 'utf8')), currentSnapshot());
      advance(changedKey, kind);
    },
  );
  await advances(() => monitors.subscribe('private-owner', monitorConfig));
  const monitor = monitors.list('private-owner')[0];
  await advances(() =>
    monitors.setLifecycle(monitor.id, 'private-owner', monitor.revision, 'paused'),
  );
  assert.equal(monitors.get(monitor.id, 'private-owner').lifecycle, 'paused');
  currentFile = ruleFile;
  currentSnapshot = () => rules.snapshot();
  await advances(() => rules.saveTeam('private-owner', teamConfig));
  assert.equal(rules.list('private-owner').teams[0].config.name, 'Team');
  currentFile = pushFile;
  currentSnapshot = () => push.snapshot();
  await advances(() => push.register('private-owner', registration, () => true));
  await advances(() => push.disable('private-owner', registration.installationId));
  assert.equal(push.snapshot().devices[0].enabled, false);
});

test('failed commits retain old memory and revisions, and a later successful write still publishes', async (t) => {
  const dir = await directory(t);
  const monitorFile = join(dir, 'monitors.json');
  const ruleFile = join(dir, 'rules.json');
  const pushFile = join(dir, 'push.json');
  const monitors = await PRMonitorStore.load(monitorFile);
  const rules = await PRRuleStore.load(ruleFile);
  const push = await PRPushStore.load(pushFile);
  for (const file of [monitorFile, ruleFile, pushFile]) await mkdir(file);
  const before = resourceRevisions.revision(key);
  await assert.rejects(monitors.subscribe('owner', monitorConfig));
  await assert.rejects(rules.saveTeam('owner', teamConfig));
  await assert.rejects(push.register('owner', registration, () => true));
  assert.deepEqual(monitors.list('owner'), []);
  assert.deepEqual(rules.list('owner').teams, []);
  assert.deepEqual(push.snapshot().devices, []);
  assert.equal(resourceRevisions.revision(key), before);
  for (const file of [monitorFile, ruleFile, pushFile]) await rm(file, { recursive: true });
  await advances(() => monitors.subscribe('owner', monitorConfig));
  await advances(() => rules.saveTeam('owner', teamConfig));
  await advances(() => push.register('owner', registration, () => true));
});

test('refused writes and unchanged transactions do not invalidate a ready read', async (t) => {
  const dir = await directory(t);
  const monitors = await PRMonitorStore.load(join(dir, 'monitors.json'));
  const rules = await PRRuleStore.load(join(dir, 'rules.json'));
  const push = await PRPushStore.load(join(dir, 'push.json'));
  await monitors.subscribe('owner', monitorConfig);
  await push.register('owner', registration, () => true);
  const before = resourceRevisions.revision(key);
  await monitors.subscribe('owner', monitorConfig);
  assert.equal(await rules.scheduleWebhookRefresh(rules.snapshot(), [], () => true, []), true);
  await push.disable('owner', 'missing-installation');
  await assert.rejects(
    push.register('foreign-owner', registration, () => false),
    /revoked/,
  );
  assert.equal(resourceRevisions.revision(key), before);
});

test('publication enrollment failures and recovery invalidate exactly when the readable error changes', async (t) => {
  const dir = await directory(t);
  const store = await PRMonitorStore.load(join(dir, 'monitors.json'));
  const policy: PRProjectMonitorPolicy['config'] = {
    account: monitorConfig.account,
    policy: monitorConfig.policy,
    pollIntervalMs: monitorConfig.pollIntervalMs,
    watchedChecks: monitorConfig.watchedChecks,
    automaticAttemptLimit: monitorConfig.automaticAttemptLimit,
    cooldownMs: monitorConfig.cooldownMs,
  };
  await store.saveProjectPolicy('owner', 'project', true, policy);
  let repository: string | undefined;
  const enrollment = new PRPublicationEnrollment(
    store,
    { enrolled: async (id, owner) => store.get(id, owner) },
    () => true,
    () => [],
    async () => repository,
  );
  await advances(() => enrollment.reconcile());
  assert.match(enrollment.errors('owner').project, /no configured PR repository/);
  assert.deepEqual(enrollment.errors('foreign-owner'), {});
  const failedRevision = resourceRevisions.revision(key);
  await enrollment.reconcile();
  assert.equal(resourceRevisions.revision(key), failedRevision);
  repository = 'owner/repo';
  await advances(() => enrollment.reconcile());
  assert.deepEqual(enrollment.errors('owner'), {});
});

test('derived push attention publishes even without a legacy event callback, and idle sweeps do not', async (t) => {
  const dir = await directory(t);
  const store = await PRPushStore.load(join(dir, 'push.json'));
  const source: PRPushAttention = {
    id: 'rule:one',
    kind: 'rule',
    title: 'PR',
    body: 'Review required',
    route: '/pr-automation?notificationId=one',
    createdAt: '2026-09-09T00:00:00.000Z',
    current: true,
  };
  let sources = [source];
  const service = new PRPushService(
    store,
    () => true,
    () => sources,
    undefined,
    undefined,
    () => ['owner'],
  );
  await advances(() => service.tick());
  assert.equal(service.list('owner').attention.length, 1);
  const before = resourceRevisions.revision(key);
  await service.tick();
  assert.equal(resourceRevisions.revision(key), before);
  sources = [];
  await advances(() => service.tick());
  assert.deepEqual(service.list('owner').attention, []);
});

async function settleUntil(condition: () => boolean): Promise<void> {
  // Only the owning promise handlers run here; no clock or background service is needed.
  for (let turn = 0; turn < 100 && !condition(); turn++) await Promise.resolve();
  assert(condition(), 'The owning completion handler must expose the new status');
}

test('all three scheduler status faults and recoveries publish once per readable transition', async (t) => {
  const dir = await directory(t);
  const monitors = await PRMonitorStore.load(join(dir, 'monitors.json'));
  const rules = await PRRuleStore.load(join(dir, 'rules.json'));
  const push = await PRPushStore.load(join(dir, 'push.json'));
  const services = [
    new PRMonitoringService(
      monitors,
      () => true,
      () => {},
    ),
    new PRRuleService(
      rules,
      () => true,
      () => {},
    ),
    new PRPushService(
      push,
      () => true,
      () => [],
    ),
  ];
  for (const service of services) {
    t.after(() => service.stop());
    let failure: Error | undefined = new Error('Private scheduler write failed');
    const tick = t.mock.method(service, 'tick', async () => {
      if (failure) throw failure;
    });
    const before = resourceRevisions.revision(key);
    service.start();
    await settleUntil(() => service.schedulerError === failure?.message);
    service.stop();
    assert.equal(resourceRevisions.revision(key), before + 1);
    service.start();
    await settleUntil(() => tick.mock.calls.length >= 2);
    await Promise.resolve();
    service.stop();
    assert.equal(resourceRevisions.revision(key), before + 1, 'Repeated equal errors stay quiet');
    failure = undefined;
    service.start();
    await settleUntil(() => service.schedulerError === undefined);
    service.stop();
    assert.equal(resourceRevisions.revision(key), before + 2);
  }
});

test('both dispatchers invalidate faults and recovery without another store mutation', async (t) => {
  const dir = await directory(t);
  const monitors = await PRMonitorStore.load(join(dir, 'monitors.json'));
  const rules = await PRRuleStore.load(join(dir, 'rules.json'));
  const dispatchers = [
    new PRRepairDispatcher(
      monitors,
      { refresh: async (id, owner) => monitors.get(id, owner) },
      () => true,
      () => {},
    ),
    new PRReviewDispatcher(
      rules,
      {
        refreshTarget: async () => {
          throw new Error('Not reached by the mocked reconcile');
        },
        refreshSubmission: async () => {
          throw new Error('Not reached by the mocked reconcile');
        },
      },
      () => true,
      () => {},
    ),
  ];
  for (const dispatcher of dispatchers) {
    let failure: Error | undefined = new Error('Private dispatcher write failed');
    t.mock.method(dispatcher, 'reconcile', async () => {
      if (failure) throw failure;
    });
    const before = resourceRevisions.revision(key);
    dispatcher.wake();
    await settleUntil(() => dispatcher.error === failure?.message);
    assert.equal(resourceRevisions.revision(key), before + 1);
    dispatcher.wake();
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(resourceRevisions.revision(key), before + 1);
    failure = undefined;
    dispatcher.wake();
    await settleUntil(() => dispatcher.error === undefined);
    assert.equal(resourceRevisions.revision(key), before + 2);
  }
});

test('external PR rule reload is serialized, publishes readable changes, and refuses malformed/deleted files', async (t) => {
  const dir = await directory(t);
  const file = join(dir, 'rules.json');
  const store = await PRRuleStore.load(file);
  const team = await store.saveTeam('owner', teamConfig);
  const changed = store.snapshot();
  changed.teams[0].revision += 1;
  changed.teams[0].config.name = 'Externally migrated team';
  await writeFile(file, JSON.stringify(changed));
  await advances(async () => {
    assert.equal(await store.reloadFromFile(), true);
  });
  assert.deepEqual(store.snapshot(), changed);
  assert.equal(store.team(team.id, 'owner').config.name, 'Externally migrated team');
  const before = resourceRevisions.revision(key);
  assert.equal(await store.reloadFromFile(), false);
  assert.equal(resourceRevisions.revision(key), before);
  for (const value of ['{broken', JSON.stringify({ ...changed, version: 999 })]) {
    const revision = resourceRevisions.revision(key);
    await writeFile(file, value);
    await assert.rejects(store.reloadFromFile());
    assert.throws(() => store.list('owner'), { code: 'SOURCE_UNAVAILABLE' });
    assert.throws(() => store.snapshot(), { code: 'SOURCE_UNAVAILABLE' });
    await assert.rejects(store.saveTeam('owner', teamConfig), { code: 'SOURCE_UNAVAILABLE' });
    assert.equal(
      resourceRevisions.revision(key),
      revision + 1,
      'The failed-source read gate invalidates ready queries',
    );
    assert.equal(store.admissionPending, false);
    await writeFile(file, JSON.stringify(changed));
    assert.equal(
      await store.reloadFromFile(),
      true,
      'Recovery invalidates the source error even for equal bytes',
    );
    assert.deepEqual(store.snapshot(), changed);
  }
  await rm(file);
  await assert.rejects(store.reloadFromFile(), { code: 'ENOENT' });
  assert.throws(() => store.team(team.id, 'owner'), { code: 'SOURCE_UNAVAILABLE' });
  await writeFile(file, JSON.stringify(changed));
  await store.reloadFromFile();
  // The queued owning write commits first. Reload then reads that commit, not old bytes.
  const revision = resourceRevisions.revision(key);
  const write = store.saveTeam('owner', { ...teamConfig, name: 'Queued owning write' });
  const reload = store.reloadFromFile();
  assert.equal(store.admissionPending, true);
  await write;
  assert.equal(await reload, false);
  assert.equal(store.admissionPending, false);
  assert.equal(resourceRevisions.revision(key), revision + 1);
  assert(store.list('owner').teams.some((entry) => entry.config.name === 'Queued owning write'));
});
