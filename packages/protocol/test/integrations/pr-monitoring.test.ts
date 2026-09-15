import assert from 'node:assert/strict';
import test from 'node:test';

import type {
  PRExecutionProfile,
  PRMonitorConfig,
  PRWorkspaceExecutionProfile,
} from '../../src/contracts/pr-monitoring.js';
import {
  assertPRExecutionProfile,
  assertPRMonitorConfig,
  assertPRMonitorPolicy,
  assertPRSlotExecutionProfile,
  intersectPRExecutionProfiles,
  isPRWorkspaceExecutionChoice,
  isPRWorkspaceExecutionProfile,
  monitoredPRKey,
  prExecutionChoices,
} from '../../src/integrations/pr-monitoring.js';
import { assertPRTriggerRuleConfig } from '../../src/integrations/pr-rule-config.js';

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

const workspaceProfile: PRWorkspaceExecutionProfile = {
  workspacePolicy: { kind: 'pool', allowedMachines: ['node-a', 'node-b'] },
  models: [
    { runner: 'runner-a', model: 'model-a', effort: 'high', allowedMachines: ['node-b'] },
    { runner: 'runner-b', model: 'model-b' },
  ],
};

test('workspace choices preserve machine and model preferences without slot placeholders', () => {
  assert.deepEqual(prExecutionChoices(workspaceProfile), [
    { machine: 'node-b', runner: 'runner-a', model: 'model-a', effort: 'high' },
    { machine: 'node-a', runner: 'runner-b', model: 'model-b', effort: undefined },
    { machine: 'node-b', runner: 'runner-b', model: 'model-b', effort: undefined },
  ]);
  assert.ok(isPRWorkspaceExecutionProfile(workspaceProfile));
  assert.ok(!isPRWorkspaceExecutionProfile(profile));
  for (const choice of prExecutionChoices(workspaceProfile)) {
    assert.ok(isPRWorkspaceExecutionChoice(choice));
    assert.ok(!('slotId' in choice));
  }
  for (const choice of prExecutionChoices(profile)) {
    assert.ok(!isPRWorkspaceExecutionChoice(choice));
    assert.ok(!('machine' in choice));
  }
});

test('workspace intersections constrain exact/pool machines, runner, model and effort', () => {
  const exact: PRWorkspaceExecutionProfile = {
    workspacePolicy: { kind: 'exact', machine: 'node-b' },
    models: [{ runner: 'runner-a', model: 'model-a', effort: 'high' }],
  };
  assert.deepEqual(intersectPRExecutionProfiles([workspaceProfile, exact]), [
    { machine: 'node-b', runner: 'runner-a', model: 'model-a', effort: 'high' },
  ]);
  assert.deepEqual(
    intersectPRExecutionProfiles([
      workspaceProfile,
      { ...exact, workspacePolicy: { kind: 'exact', machine: 'node-a' } },
    ]),
    [],
  );
  for (const changed of [{ runner: 'other' }, { model: 'other' }, { effort: undefined }]) {
    assert.deepEqual(
      intersectPRExecutionProfiles([
        workspaceProfile,
        { ...exact, models: [{ ...exact.models[0], ...changed }] },
      ]),
      [],
    );
  }
  const slot: PRExecutionProfile = {
    slotPolicy: { kind: 'exact', slotId: 'node-b' },
    models: exact.models,
  };
  assert.deepEqual(intersectPRExecutionProfiles([exact, slot]), []);
  assert.deepEqual(intersectPRExecutionProfiles([slot, exact]), []);
});

test('execution policies reject mixed target authority and invalid machine constraints', () => {
  for (const invalid of [
    { models: workspaceProfile.models },
    { ...workspaceProfile, slotPolicy: profile.slotPolicy },
    { ...workspaceProfile, slotPolicy: undefined },
  ]) {
    assert.throws(() => assertPRExecutionProfile(invalid), /exactly one/);
  }
  for (const workspacePolicy of [
    { kind: 'pool', allowedMachines: [] },
    { kind: 'pool', allowedMachines: ['node-a', 'node-a'] },
    { kind: 'pool', allowedMachines: [' node-a'] },
    { kind: 'exact', machine: '' },
    { kind: 'exact', slotId: 'node-a' },
    { kind: 'spread' },
  ]) {
    assert.throws(() => assertPRExecutionProfile({ ...workspaceProfile, workspacePolicy }));
  }
  for (const allowedMachines of [[], ['node-c'], ['node-a', 'node-a']]) {
    assert.throws(() =>
      assertPRExecutionProfile({
        ...workspaceProfile,
        models: [{ runner: 'runner-a', model: 'model-a', allowedMachines }],
      }),
    );
  }
  assert.throws(
    () => assertPRExecutionProfile({ ...workspaceProfile, models: profile.models }),
    /allowedSlots.*not supported/,
  );
  assert.throws(
    () => assertPRExecutionProfile({ ...profile, models: workspaceProfile.models }),
    /allowedMachines.*not supported/,
  );
  assert.throws(
    () =>
      assertPRExecutionProfile({
        workspacePolicy: { kind: 'exact', machine: 'node-a' },
        models: workspaceProfile.models,
      }),
    /within/,
  );
});

test('workspace review authority never authorizes automatic repair', () => {
  assert.throws(() => assertPRSlotExecutionProfile(workspaceProfile), /must use a slot policy/);
  assert.throws(
    () => assertPRMonitorPolicy({ mode: 'automatic-repair', execution: workspaceProfile }),
    /must use a slot policy/,
  );
  assert.doesNotThrow(() =>
    assertPRMonitorPolicy({
      mode: 'automatic-repair',
      execution: JSON.parse(JSON.stringify(profile)),
    }),
  );
});

test('workspace transport and native profile remain explicit intersected authority', () => {
  const nativeProfile = {
    executionNodeId: 'node-b',
    runner: 'runner-a',
    profileId: 'reviewer',
    accountContextId: '00000000-0000-0000-0000-000000000001',
  };
  const native: PRWorkspaceExecutionProfile = {
    workspacePolicy: { kind: 'exact', machine: 'node-b' },
    models: [{ runner: 'runner-a', model: 'model-a', effort: 'high' }],
    transport: 'native',
    nativeProfile,
  };
  assert.deepEqual(prExecutionChoices(native), [
    {
      machine: 'node-b',
      runner: 'runner-a',
      model: 'model-a',
      effort: 'high',
      transport: 'native',
      nativeProfile,
    },
  ]);
  assert.deepEqual(
    intersectPRExecutionProfiles([native, { ...native, nativeProfile: { ...nativeProfile } }]),
    prExecutionChoices(native),
  );
  for (const change of [
    { transport: undefined, nativeProfile: undefined },
    { nativeProfile: undefined },
    { nativeProfile: { ...nativeProfile, profileId: 'other' } },
    {
      nativeProfile: { ...nativeProfile, accountContextId: '00000000-0000-0000-0000-000000000002' },
    },
  ]) {
    assert.deepEqual(intersectPRExecutionProfiles([native, { ...native, ...change }]), []);
  }
  assert.throws(
    () => assertPRExecutionProfile({ ...native, transport: undefined }),
    /requires native/,
  );
  assert.throws(() => assertPRExecutionProfile({ ...native, transport: 'other' }), /transport/);
  assert.throws(
    () =>
      assertPRExecutionProfile({ ...native, nativeProfile: { ...nativeProfile, runner: 'other' } }),
    /match every/,
  );
  assert.throws(
    () => assertPRExecutionProfile({ ...profile, transport: 'native' }),
    /not supported/,
  );
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

test('rule monitor actions require slot authority even when review actions allow workspaces', () => {
  const rule = {
    name: 'review and repair',
    teamId: 'team',
    predicate: { kind: 'compare', field: 'repository', operator: 'equals', value: 'owner/repo' },
    actions: [
      { kind: 'review', autoStart: true, execution: workspaceProfile },
      { kind: 'monitor', policy: { mode: 'automatic-repair', execution: profile } },
    ],
    pollIntervalMs: 60_000,
    maxAdmissionsPerScan: 1,
    rereviewOnHeadChange: true,
  };
  assert.doesNotThrow(() => assertPRTriggerRuleConfig(rule));
  assert.throws(
    () =>
      assertPRTriggerRuleConfig({
        ...rule,
        actions: [
          { kind: 'monitor', policy: { mode: 'automatic-repair', execution: workspaceProfile } },
        ],
      }),
    /must use a slot policy/,
  );
});
