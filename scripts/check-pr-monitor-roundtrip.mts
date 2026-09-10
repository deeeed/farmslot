#!/usr/bin/env tsx
// Real gateway setup/assertions for desktop and native edits of a monitor with comma-bearing check names.
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { GatewayClient } from '../packages/cli/src/gateway-client.js';
import { loadCheckoutEnv } from '../packages/cli/src/onboarding/env-file.js';
import {
  parseGitHubPullUrl,
  type PRMonitor,
  type PRWatchListResult,
} from '../packages/protocol/src/index.js';

loadCheckoutEnv(fileURLToPath(new URL('../', import.meta.url)));
const tag = process.env.ROUNDTRIP_TAG;
const parsed = parseGitHubPullUrl(process.env.ROUNDTRIP_PR_URL);
const phase = process.argv[2];
assert(
  tag && parsed && ['setup', 'desktop', 'native', 'paused', 'cleanup'].includes(phase),
  'Set ROUNDTRIP_TAG and ROUNDTRIP_PR_URL',
);
const client = new GatewayClient({
  url: process.env.GW_URL ?? 'ws://127.0.0.1:7777',
  timeout: 30_000,
});
const connection = await client.connect();
try {
  let monitors = (await connection.call<PRWatchListResult>('prWatch.list')).monitors.filter(
    (monitor) => monitor.config.teamId === tag,
  );
  if (phase === 'setup') {
    assert.equal(monitors.length, 0, 'Use a unique tag; do not overwrite operator subscriptions');
    const { monitor } = await connection.call<{ monitor: PRMonitor }>('prWatch.subscribe', {
      config: {
        pr: { host: 'github.com', repo: parsed.repo, number: parsed.number },
        account: { host: 'github.com', login: process.env.INTAKE_GITHUB_LOGIN ?? '' },
        teamId: tag,
        policy: { mode: 'notify-only' },
        pollIntervalMs: 300_000,
        watchedChecks: ['test (ubuntu-latest, node-20)', 'lint'],
        automaticAttemptLimit: 2,
        cooldownMs: 600_000,
      },
    });
    monitors = [monitor];
  }
  assert.equal(monitors.length, 1);
  let monitor = monitors[0];
  assert.equal(monitor.config.pr.repo.toLowerCase(), parsed.repo.toLowerCase());
  assert.equal(monitor.config.pr.number, parsed.number);
  assert.equal(monitor.config.account.login, process.env.INTAKE_GITHUB_LOGIN);
  assert.equal(monitor.config.teamId, tag);
  assert.equal(monitor.config.policy.mode, 'notify-only');
  assert.deepEqual(
    monitor.config.watchedChecks,
    ['test (ubuntu-latest, node-20)', 'lint'],
    'Editing interval must preserve whole check names',
  );
  if (phase === 'desktop') assert.equal(monitor.config.pollIntervalMs, 600_000);
  if (phase === 'native') assert.equal(monitor.config.pollIntervalMs, 900_000);
  if (phase === 'paused') assert.equal(monitor.lifecycle, 'paused');
  if (phase === 'cleanup') {
    for (let attempt = 0; monitor.lifecycle !== 'stopped'; attempt++) {
      try {
        monitor = (
          await connection.call<{ monitor: PRMonitor }>('prWatch.lifecycle', {
            id: monitor.id,
            revision: monitor.revision,
            lifecycle: 'stopped',
          })
        ).monitor;
      } catch (error) {
        if (attempt >= 4 || !/changed|revision/i.test(String(error))) throw error;
        monitor = (await connection.call<PRWatchListResult>('prWatch.list')).monitors.find(
          (item) => item.id === monitor.id,
        )!;
        assert(monitor);
      }
    }
  }
  console.log(
    JSON.stringify({ passed: true, phase, monitorId: monitor.id, lifecycle: monitor.lifecycle }),
  );
} finally {
  connection.close();
}
