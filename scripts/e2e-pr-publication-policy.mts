#!/usr/bin/env tsx
// Local gateway proof of opt-in policy boundaries; does not publish a PR.
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

import { GatewayClient } from '../packages/cli/src/gateway-client.js';
import { loadCheckoutEnv } from '../packages/cli/src/onboarding/env-file.js';
import type {
  PRProjectMonitorPolicy,
  PRWatchListResult,
  PRWatchProjectPolicySetResult,
} from '../packages/protocol/src/index.js';

loadCheckoutEnv(fileURLToPath(new URL('../', import.meta.url)));
const project = process.env.MONITOR_PROJECT;
const login = process.env.MONITOR_GITHUB_LOGIN;
assert(project && login, 'Set MONITOR_PROJECT and MONITOR_GITHUB_LOGIN');
const client = new GatewayClient({
  url: process.env.GW_URL ?? 'ws://127.0.0.1:7777',
  timeout: 15_000,
});
const connection = await client.connect();
const observer = await client.connect().catch((error) => {
  connection.close();
  throw error;
});
const events: PRProjectMonitorPolicy[] = [];
observer.onEvent((event) => {
  if (event.event === 'prWatch.policy.updated')
    events.push((event.payload as PRWatchProjectPolicySetResult).policy);
});
let policy: PRProjectMonitorPolicy | undefined;
let original: PRProjectMonitorPolicy | undefined;
try {
  const before = await connection.call<PRWatchListResult>('prWatch.list');
  original = before.projectPolicies?.find((item) => item.project === project);
  assert(!original?.enabled, 'Choose a project without enabled publication monitoring');
  const config: PRProjectMonitorPolicy['config'] = {
    account: { host: 'github.com', login },
    policy: { mode: 'notify-only' },
    pollIntervalMs: 300_000,
    watchedChecks: [],
    automaticAttemptLimit: 2,
    cooldownMs: 300_000,
  };
  ({ policy } = await connection.call<PRWatchProjectPolicySetResult>('prWatch.projectPolicy.set', {
    project,
    enabled: true,
    revision: original?.revision,
    config,
  }));
  const activation = policy.activatedAt;
  ({ policy } = await connection.call<PRWatchProjectPolicySetResult>('prWatch.projectPolicy.set', {
    project,
    enabled: true,
    revision: policy.revision,
    config: { ...config, pollIntervalMs: 600_000 },
  }));
  assert.equal(
    policy.activatedAt,
    activation,
    'Editing enabled policy must retain its publication boundary',
  );
  await assert.rejects(
    connection.call('prWatch.projectPolicy.set', {
      project,
      enabled: false,
      revision: policy.revision - 1,
      config,
    }),
    /changed/,
  );
  ({ policy } = await connection.call<PRWatchProjectPolicySetResult>('prWatch.projectPolicy.set', {
    project,
    enabled: false,
    revision: policy.revision,
    config,
  }));
  const remote = await observer.call<PRWatchListResult>('prWatch.list');
  assert.equal(remote.projectPolicies?.find((item) => item.project === project)?.enabled, false);
  assert(
    events.some((item) => item.project === project && !item.enabled),
    'Second client must receive disabled policy',
  );
  const reconnected = await client.call<PRWatchListResult>('prWatch.list');
  assert.equal(
    reconnected.projectPolicies?.find((item) => item.project === project)?.revision,
    policy.revision,
  );
  console.log(
    JSON.stringify({
      passed: true,
      optIn: true,
      activationBoundary: true,
      staleEditRejected: true,
      crossClientDisable: true,
      reconnect: true,
    }),
  );
} finally {
  try {
    if (policy) {
      const current = (
        await connection.call<PRWatchListResult>('prWatch.list')
      ).projectPolicies?.find((item) => item.project === project);
      assert(current, 'Validation policy must remain readable for cleanup');
      await connection.call('prWatch.projectPolicy.set', {
        project,
        enabled: false,
        revision: current.revision,
        config: original?.config ?? current.config,
      });
    }
  } finally {
    connection.close();
    observer.close();
  }
}
