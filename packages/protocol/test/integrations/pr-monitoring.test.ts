import assert from 'node:assert/strict';
import test from 'node:test';

import type { PRExecutionProfile, PRMonitorConfig } from '../../src/contracts/pr-monitoring.js';
import {
  assertPRExecutionProfile,
  assertPRMonitorConfig,
  intersectPRExecutionProfiles,
  monitoredPRKey,
} from '../../src/integrations/pr-monitoring.js';

const profile: PRExecutionProfile = {
  slotPolicy: { kind: 'pool', allowedSlots: ['slot-a', 'slot-b'] },
  models: [
    { runner: 'runner-a', model: 'model-a', effort: 'high', allowedSlots: ['slot-a'] },
    { runner: 'runner-b', model: 'model-b', effort: 'medium' },
  ],
};

test('PR identities distinguish hosts and repositories while normalizing case', () => {
  const pr = { host: 'GitHub.com', repo: 'Owner/Repo', number: 123 };
  assert.equal(monitoredPRKey(pr), 'github.com/owner/repo#123');
  assert.notEqual(monitoredPRKey(pr), monitoredPRKey({ ...pr, repo: 'Owner/Other' }));
  assert.notEqual(monitoredPRKey(pr), monitoredPRKey({ ...pr, host: 'github.example.com' }));
  for (const invalid of [0, -1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => monitoredPRKey({ ...pr, number: invalid }));
  }
  for (const repo of ['../repo', 'owner/../repo', 'owner/repo?x=1', 'owner/repo#123']) {
    assert.throws(() => monitoredPRKey({ ...pr, repo }));
  }
});

test('execution intersections preserve preference and cannot expand slot/model/effort authority', () => {
  const other: PRExecutionProfile = {
    slotPolicy: { kind: 'exact', slotId: 'slot-b' },
    models: [{ runner: 'runner-b', model: 'model-b', effort: 'medium' }],
  };
  assert.deepEqual(intersectPRExecutionProfiles([profile, other]), [
    { slotId: 'slot-b', runner: 'runner-b', model: 'model-b', effort: 'medium' },
  ]);
  assert.deepEqual(
    intersectPRExecutionProfiles([
      profile,
      {
        ...other,
        models: [{ ...other.models[0], effort: 'high' }],
      },
    ]),
    [],
  );
  assert.deepEqual(intersectPRExecutionProfiles([]), []);
  assert.throws(
    () =>
      assertPRExecutionProfile({
        ...profile,
        models: [{ runner: 'runner-a', model: 'model-a', allowedSlots: ['unlisted'] }],
      }),
    /within/,
  );
  assert.throws(
    () => assertPRExecutionProfile({ ...profile, slotPolicy: { kind: 'pool', allowedSlots: [] } }),
    /1 to 100/,
  );
  assert.throws(
    () => assertPRExecutionProfile({ ...profile, slotPolicy: { kind: 'spread' } }),
    /exact or pool/,
  );
});

test('monitor configuration requires explicit policy, account and bounded polling', () => {
  const config: PRMonitorConfig = {
    pr: { host: 'github.com', repo: 'owner/repo', number: 1 },
    account: { host: 'github.com', login: 'operator' },
    policy: { mode: 'notify-only' },
    pollIntervalMs: 300_000,
    watchedChecks: [],
    automaticAttemptLimit: 2,
    cooldownMs: 300_000,
  };
  assert.doesNotThrow(() => assertPRMonitorConfig(config));
  assert.throws(
    () =>
      assertPRMonitorConfig({
        ...config,
        account: { ...config.account, host: 'other.example.com' },
      }),
    /must match/,
  );
  assert.throws(
    () =>
      assertPRMonitorConfig({
        ...config,
        policy: { mode: 'automatic-repair', execution: profile },
      }),
    /project/,
  );
  assert.doesNotThrow(() =>
    assertPRMonitorConfig({
      ...config,
      project: 'project',
      policy: { mode: 'automatic-repair', execution: profile },
    }),
  );
  assert.throws(() => assertPRMonitorConfig({ ...config, pollIntervalMs: 0 }), /integer/);
  assert.throws(() => assertPRMonitorConfig({ ...config, shell: 'command' }), /not supported/);
  assert.throws(
    () => assertPRMonitorConfig({ ...config, policy: { mode: 'notify-only', execution: profile } }),
    /not supported/,
  );
});
