import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import type { PRMonitorConfig, PRMonitorObservation } from '@farmslot/protocol';

import { PRMonitorStore } from './store.js';

const config: PRMonitorConfig = {
  pr: { host: 'github.com', repo: 'owner/repo', number: 123 },
  account: { host: 'github.com', login: 'reader' },
  policy: { mode: 'notify-only' },
  pollIntervalMs: 300_000,
  watchedChecks: [],
  automaticAttemptLimit: 2,
  cooldownMs: 300_000,
};

async function fixture(t: test.TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'pr-monitor-store-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'monitors.json');
  return { file, store: await PRMonitorStore.load(file) };
}

test('concurrent enrollment is idempotent and duplicate adds cannot upgrade policy', async (t) => {
  const { file, store } = await fixture(t);
  const subscriptions = await Promise.all(
    Array.from({ length: 10 }, () => store.subscribe('owner', config)),
  );
  assert.equal(new Set(subscriptions.map((item) => item.id)).size, 1);
  const again = await store.subscribe(
    'owner',
    {
      ...config,
      project: 'project',
      policy: {
        mode: 'automatic-repair',
        execution: {
          slotPolicy: { kind: 'exact', slotId: 'slot-a' },
          models: [{ runner: 'runner', model: 'model' }],
        },
      },
    },
    'run-1',
  );
  assert.equal(again.config.policy.mode, 'notify-only');
  assert.deepEqual(again.originatingRunIds, ['run-1']);
  const reloaded = await PRMonitorStore.load(file);
  assert.deepEqual(reloaded.list('owner'), store.list('owner'));
});

test('repository, team, principal and source-account interests remain independent', async (t) => {
  const { store } = await fixture(t);
  const original = await store.subscribe('owner', config);
  const other = await store.subscribe('other-owner', config);
  await store.subscribe('owner', { ...config, teamId: 'team-a' });
  await store.subscribe('owner', { ...config, teamId: 'team-b' });
  await store.subscribe('owner', { ...config, pr: { ...config.pr, repo: 'owner/other' } });
  await store.subscribe('owner', {
    ...config,
    account: { ...config.account, login: 'other-reader' },
  });
  assert.equal(store.list('owner').length, 5);
  assert.equal(store.list('other-owner').length, 1);
  assert.throws(() => store.get(other.id, 'owner'), /not found/);
  await assert.rejects(
    store.setLifecycle(other.id, 'owner', other.revision, 'stopped'),
    /not found/,
  );
  await store.setLifecycle(original.id, 'owner', original.revision, 'stopped');
  assert.equal(store.get(other.id, 'other-owner').lifecycle, 'active');
  assert.equal(store.list('owner').filter((item) => item.lifecycle === 'active').length, 4);
});

test('stale mutations reject and reads do not expose mutable store state', async (t) => {
  const { store } = await fixture(t);
  const monitor = await store.subscribe('owner', config);
  const paused = await store.setLifecycle(monitor.id, 'owner', monitor.revision, 'paused');
  assert.equal(paused.nextCheckAt, undefined);
  await assert.rejects(store.configure(monitor.id, 'owner', monitor.revision, config), /changed/);
  paused.config.policy = {
    mode: 'automatic-repair',
    execution: { slotPolicy: { kind: 'pool', allowedSlots: [] }, models: [] },
  };
  assert.equal(store.get(monitor.id, 'owner').config.policy.mode, 'notify-only');
  await assert.rejects(
    store.configure(monitor.id, 'owner', paused.revision, { ...config, teamId: 'other' }),
    /cannot be changed/,
  );
});

test('persistence failure rejects without publishing state and permits a later retry', async (t) => {
  const { file, store } = await fixture(t);
  await mkdir(file);
  await assert.rejects(store.subscribe('owner', config));
  assert.equal(store.list('owner').length, 0);
  await rm(file, { recursive: true });
  await store.subscribe('owner', config);
  assert.equal((await PRMonitorStore.load(file)).list('owner').length, 1);
});

test('malformed, unsupported and duplicate persisted records fail loading rather than reset', async (t) => {
  const { file, store } = await fixture(t);
  await store.subscribe('owner', config);
  const valid = JSON.parse(await readFile(file, 'utf8'));
  for (const value of [
    { ...valid, version: 2 },
    { ...valid, monitors: [...valid.monitors, ...valid.monitors] },
    { ...valid, monitors: [{ ...valid.monitors[0], lifecycle: 'healthy' }] },
    { ...valid, monitors: [{ ...valid.monitors[0], incidents: [{}] }] },
  ]) {
    await writeFile(file, JSON.stringify(value));
    await assert.rejects(PRMonitorStore.load(file));
  }
  await writeFile(file, '{broken');
  await assert.rejects(PRMonitorStore.load(file));
});

test('observations survive restart, failed reads preserve facts and stale reads cannot undo a pause', async (t) => {
  const { file, store } = await fixture(t);
  const monitor = await store.subscribe('owner', config);
  const observation: PRMonitorObservation = {
    checkedAt: '2026-09-09T12:00:00.000Z',
    headSha: 'head-a',
    title: 'PR',
    author: 'author',
    state: 'open',
    draft: false,
    mergeability: 'conflicting',
    reviewDecision: 'approved',
    signals: [
      {
        key: 'conflict',
        revision: 'base-head',
        kind: 'conflict',
        summary: 'Conflict',
        url: 'https://github.com/owner/repo/pull/123',
      },
    ],
  };
  const fresh = await store.observe(monitor.id, 'owner', monitor.revision, { observation });
  assert(fresh);
  const acknowledged = await store.acknowledge(
    monitor.id,
    'owner',
    fresh.revision,
    fresh.incidents[0].id,
  );
  assert.equal(acknowledged.incidents[0].resolvedAt, undefined);
  const failed = await store.observe(monitor.id, 'owner', acknowledged.revision, {
    error: 'Provider unavailable',
    checkedAt: '2026-09-09T12:05:00.000Z',
  });
  assert(failed);
  assert.deepEqual(failed.observation, observation);
  assert.equal(failed.incidents[0].resolvedAt, undefined);
  await store.setLifecycle(monitor.id, 'owner', failed.revision, 'paused');
  assert.equal(await store.observe(monitor.id, 'owner', failed.revision, { observation }), null);
  assert.equal((await PRMonitorStore.load(file)).get(monitor.id, 'owner').lifecycle, 'paused');
});
