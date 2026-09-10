import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import type { PRMonitorConfig, PRMonitorObservation } from '@farmslot/protocol';

import { PRMonitoringService } from './service.js';
import { PRMonitorStore } from './store.js';

const config: PRMonitorConfig = {
  pr: { host: 'github.com', repo: 'owner/repo', number: 1 },
  account: { host: 'github.com', login: 'reader' },
  policy: { mode: 'notify-only' },
  pollIntervalMs: 300_000,
  watchedChecks: [],
  automaticAttemptLimit: 2,
  cooldownMs: 300_000,
};
function observation(): PRMonitorObservation {
  return {
    checkedAt: new Date().toISOString(),
    headSha: 'head-a',
    title: 'PR',
    author: 'external-author',
    state: 'open',
    draft: false,
    mergeability: 'mergeable',
    reviewDecision: 'changes-requested',
    signals: [
      {
        kind: 'review',
        key: 'review-1',
        revision: 'revision-1',
        summary: 'Changes requested',
        url: 'https://github.com/owner/repo/pull/1',
      },
    ],
  };
}

async function fixture(t: test.TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'pr-monitor-service-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'monitors.json');
  return { file, store: await PRMonitorStore.load(file) };
}

test('a clientless sweep discovers feedback after reloading a completed run subscription', async (t) => {
  const { file, store } = await fixture(t);
  const monitor = await store.subscribe('owner', config, 'completed-run');
  const reloaded = await PRMonitorStore.load(file);
  const broadcasts: string[] = [];
  let reads = 0;
  const service = new PRMonitoringService(
    reloaded,
    () => true,
    (owner) => broadcasts.push(owner),
    async () => {
      reads += 1;
      return observation();
    },
  );
  await Promise.all([service.tick(), service.tick()]);
  const current = reloaded.get(monitor.id, 'owner');
  assert.equal(reads, 1);
  assert.equal(current.incidents.length, 1);
  assert.deepEqual(current.originatingRunIds, ['completed-run']);
  assert.deepEqual(broadcasts, ['owner']);
  assert.equal(current.incidents[0].queueItemId, undefined);
});

test('concurrent clients share one refresh; a pause wins over an in-flight response', async (t) => {
  const { store } = await fixture(t);
  const monitor = await store.subscribe('owner', config);
  let resolveRead!: (value: PRMonitorObservation) => void;
  let reads = 0;
  const response = new Promise<PRMonitorObservation>((resolve) => {
    resolveRead = resolve;
  });
  const service = new PRMonitoringService(
    store,
    () => true,
    () => {},
    async () => {
      reads += 1;
      return response;
    },
  );
  const first = service.refresh(monitor.id, 'owner');
  const second = service.refresh(monitor.id, 'owner');
  await service.lifecycle(monitor.id, 'owner', monitor.revision, 'paused');
  resolveRead(observation());
  await Promise.all([first, second]);
  assert.equal(reads, 1);
  assert.equal(store.get(monitor.id, 'owner').lifecycle, 'paused');
  assert.equal(store.get(monitor.id, 'owner').observation, undefined);
});

test('provider failure preserves actionable facts and revocation prevents further reads', async (t) => {
  const { store } = await fixture(t);
  let authorized = true;
  let unavailable = false;
  let reads = 0;
  const service = new PRMonitoringService(
    store,
    () => authorized,
    () => {},
    async () => {
      reads += 1;
      if (unavailable) throw new Error('Provider unavailable');
      return observation();
    },
  );
  const monitor = await service.subscribe('owner', config);
  unavailable = true;
  const failed = await service.refresh(monitor.id, 'owner');
  assert.equal(failed.incidents[0].resolvedAt, undefined);
  assert.equal(failed.observationError, 'Provider unavailable');
  authorized = false;
  const denied = await service.refresh(monitor.id, 'owner');
  assert.equal(reads, 2);
  assert.match(denied.observationError ?? '', /authority/);
  await assert.rejects(service.subscribe('owner', config), /authority/);
  assert.throws(() => service.refresh(monitor.id, 'different-owner'), /not found/);
});

test('repair-journal updates do not discard an in-flight provider observation', async (t) => {
  const { store } = await fixture(t);
  let monitor = await store.subscribe('owner', {
    ...config,
    project: 'project',
    policy: {
      mode: 'automatic-repair',
      execution: {
        slotPolicy: { kind: 'exact', slotId: 'slot' },
        models: [{ runner: 'codex', model: 'gpt-6-astra' }],
      },
    },
  });
  monitor = (await store.observe(monitor.id, 'owner', monitor.revision, {
    observation: observation(),
  }))!;
  let release!: (value: PRMonitorObservation) => void;
  const response = new Promise<PRMonitorObservation>((resolve) => {
    release = resolve;
  });
  const service = new PRMonitoringService(
    store,
    () => true,
    () => {},
    async () => response,
  );
  const pending = service.refresh(monitor.id, 'owner');
  await store.ensureRepair(monitor.id, 'owner');
  release({ ...observation(), headSha: 'head-b' });
  await pending;
  assert.equal(store.get(monitor.id, 'owner').observation?.headSha, 'head-b');
  assert.equal(store.get(monitor.id, 'owner').repairs?.length, 1);
});
