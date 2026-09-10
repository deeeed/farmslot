#!/usr/bin/env tsx
// Run from the checkout root with MONITOR_PR_URL and MONITOR_GITHUB_LOGIN.
// MONITOR_PROJECT + MONITOR_SLOT additionally prove repair queueing on a disabled slot.
// Leaves its validation subscription stopped with notify-only policy.
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

import type {
  PRMonitor,
  PRWatchListResult,
  PRWatchResult,
  FleetStatus,
  QueueItem,
  PRMonitorConfig,
} from '../packages/protocol/src/index.js';
import { monitoredPRKey, parseGitHubPullUrl } from '../packages/protocol/src/index.js';
import { GatewayClient } from '../packages/cli/src/gateway-client.js';
import { loadCheckoutEnv } from '../packages/cli/src/onboarding/env-file.js';

loadCheckoutEnv(fileURLToPath(new URL('../', import.meta.url)));
const pr = parseGitHubPullUrl(process.env.MONITOR_PR_URL);
const login = process.env.MONITOR_GITHUB_LOGIN;
const project = process.env.MONITOR_PROJECT;
const slotId = process.env.MONITOR_SLOT;
assert(
  Boolean(project) === Boolean(slotId),
  'MONITOR_PROJECT and MONITOR_SLOT must be supplied together',
);
assert(
  pr && login,
  'Set MONITOR_PR_URL to an open github.com PR and MONITOR_GITHUB_LOGIN to a gateway keyring account',
);
const config: PRMonitorConfig = {
  pr: { host: 'github.com', repo: pr.repo, number: pr.number },
  account: { host: 'github.com', login },
  policy: { mode: 'notify-only' as const },
  pollIntervalMs: 300_000,
  watchedChecks: [],
  automaticAttemptLimit: 2,
  cooldownMs: 300_000,
};
const client = new GatewayClient({
  url: process.env.GW_URL ?? 'ws://127.0.0.1:7777',
  timeout: 60_000,
});
const first = await client.connect();
const second = await client.connect().catch((error) => {
  first.close();
  throw error;
});
let monitor: PRMonitor | undefined;
let proof: Record<string, boolean> | undefined;
const events: PRMonitor[] = [];
second.onEvent((event) => {
  if (event.event === 'prWatch.updated') events.push((event.payload as PRWatchResult).monitor);
});
try {
  if (slotId) {
    const { fleet } = await first.call<{ fleet: FleetStatus }>('fleet.status');
    const slot = fleet.slots.find((item) => item.slot === slotId && item.project === project);
    assert(
      slot && !slot.enabled,
      'Repair validation requires a disabled slot so no worker can launch',
    );
  }
  const before = await first.call<PRWatchListResult>('prWatch.list');
  const existing = before.monitors.find(
    (item) =>
      monitoredPRKey(item.config.pr) === monitoredPRKey(config.pr) &&
      item.config.account.login.toLowerCase() === login.toLowerCase() &&
      !item.config.teamId,
  );
  assert(
    !existing || existing.lifecycle === 'stopped',
    'Choose a PR without an active subscription; validation must not alter existing work',
  );
  const subscribed = await first.call<PRWatchResult>('prWatch.subscribe', { config });
  monitor = subscribed.monitor;
  if (monitor.lifecycle === 'stopped') {
    monitor = (
      await first.call<PRWatchResult>('prWatch.lifecycle', {
        id: monitor.id,
        revision: monitor.revision,
        lifecycle: 'active',
      })
    ).monitor;
    monitor = (await first.call<PRWatchResult>('prWatch.refresh', { id: monitor.id })).monitor;
  }
  assert.equal(monitor.observationError, undefined);
  assert.equal(monitor.observation?.state, 'open');
  assert(monitor.observation?.headSha);
  const duplicate = await first.call<PRWatchResult>('prWatch.subscribe', { config });
  assert.equal(duplicate.monitor.id, monitor.id);
  monitor = duplicate.monitor;
  const staleRevision = monitor.revision;
  monitor = (
    await first.call<PRWatchResult>('prWatch.lifecycle', {
      id: monitor.id,
      revision: monitor.revision,
      lifecycle: 'paused',
    })
  ).monitor;
  assert.equal(monitor.nextCheckAt, undefined);
  await assert.rejects(
    first.call('prWatch.lifecycle', {
      id: monitor.id,
      revision: staleRevision,
      lifecycle: 'active',
    }),
    /changed/,
  );
  const remote = await second.call<PRWatchResult>('prWatch.get', { id: monitor.id });
  assert.equal(remote.monitor.lifecycle, 'paused');
  assert(
    events.some((item) => item.id === monitor?.id && item.lifecycle === 'paused'),
    'Second client must receive the authoritative pause broadcast',
  );
  const reconnected = await client.call<PRWatchResult>('prWatch.get', { id: monitor.id });
  assert.equal(reconnected.monitor.revision, monitor.revision);
  const notifyQueue = await first.call<{ items: QueueItem[] }>('dispatch.queue.list');
  assert(
    !notifyQueue.items.some((item) => item.prWork?.sourceId === monitor?.id),
    'Notify-only must not enqueue repair work; historical incident links may remain',
  );
  if (project && slotId) {
    monitor = (
      await first.call<PRWatchResult>('prWatch.configure', {
        id: monitor.id,
        revision: monitor.revision,
        config: {
          ...config,
          project,
          policy: {
            mode: 'automatic-repair',
            execution: {
              slotPolicy: { kind: 'exact', slotId },
              models: [{ runner: 'codex', model: 'gpt-6-astra', effort: 'high' }],
            },
          },
        },
      })
    ).monitor;
    monitor = (
      await first.call<PRWatchResult>('prWatch.lifecycle', {
        id: monitor.id,
        revision: monitor.revision,
        lifecycle: 'active',
      })
    ).monitor;
    monitor = (await first.call<PRWatchResult>('prWatch.refresh', { id: monitor.id })).monitor;
    assert.equal(monitor.observationError, undefined);
    assert.equal(
      monitor.observation?.repairAccess?.allowed,
      true,
      'Choose an accessible same-repository PR',
    );
    assert(
      monitor.incidents.some((incident) => !incident.resolvedAt),
      'Choose a PR with actionable incidents',
    );
    let queued: QueueItem | undefined;
    const deadline = Date.now() + 30_000;
    while (!queued && Date.now() < deadline) {
      const { items } = await first.call<{ items: QueueItem[] }>('dispatch.queue.list');
      queued = items.find((item) => item.prWork?.sourceId === monitor?.id);
      if (!queued) await new Promise((resolve) => setTimeout(resolve, 250));
    }
    assert(queued, 'Automatic repair must enter the existing dispatch queue');
    assert.equal(queued.status, 'queued');
    assert.equal(queued.flowType, 'pr-complete');
    assert.deepEqual(queued.allowedSlots, [slotId]);
    assert.equal(queued.model, 'gpt-6-astra');
    assert.equal(queued.effort, 'high');
    assert(queued.prWork?.incidentIds?.length);
    monitor = (await first.call<PRWatchResult>('prWatch.get', { id: monitor.id })).monitor;
    assert(monitor.incidents.every((incident) => incident.attemptCount === 0 && !incident.runId));
    monitor = (
      await first.call<PRWatchResult>('prWatch.configure', {
        id: monitor.id,
        revision: monitor.revision,
        config,
      })
    ).monitor;
    await waitForWithdrawal();
  }
  proof = {
    passed: true,
    observed: true,
    duplicateEnrollment: true,
    crossClientPause: true,
    staleMutationRejected: true,
    reconnect: true,
    ...(slotId ? { repairQueued: true, selectedExecution: true, policyWithdrawal: true } : {}),
  };
} finally {
  try {
    if (monitor) {
      await changeLatest('prWatch.lifecycle', { lifecycle: 'stopped' });
      if (slotId) {
        await waitForWithdrawal();
        await changeLatest('prWatch.configure', { config });
      }
    }
  } finally {
    first.close();
    second.close();
  }
}
console.log(JSON.stringify(proof));

async function changeLatest(method: string, params: Record<string, unknown>): Promise<void> {
  assert(monitor);
  for (let attempt = 0; attempt < 4; attempt++) {
    const current = await first.call<PRWatchResult>('prWatch.get', { id: monitor.id });
    try {
      await first.call(method, { ...params, id: monitor.id, revision: current.monitor.revision });
      return;
    } catch (error) {
      // A background queue withdrawal can advance the monitor journal during cleanup.
      // Refresh only this version conflict; do not hide transport or authorization failures.
      if (attempt === 3 || !(error instanceof Error) || !error.message.includes('Monitor changed'))
        throw error;
    }
  }
}

async function waitForWithdrawal(): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const { items } = await first.call<{ items: QueueItem[] }>('dispatch.queue.list');
    if (!items.some((item) => item.prWork?.sourceId === monitor?.id)) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  assert.fail('Disabled repair policy must withdraw queued work');
}
