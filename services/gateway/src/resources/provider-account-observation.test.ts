import assert from 'node:assert/strict';
import test from 'node:test';

import type { ProviderRunnerAccountStatus } from '@farmslot/protocol';

import {
  PROVIDER_ACCOUNTS_LEGACY_INTEREST_MS,
  PROVIDER_ACCOUNTS_READY_MS,
  PROVIDER_ACCOUNTS_TTL_MS,
  ProviderAccountObservation,
  type ProviderSeatRunnerSample,
  type ProviderSeatSample,
} from './provider-account-observation.js';

const managed = { legacyInterest: false };

function seat(
  runner: string,
  quota: number,
  overrides: Partial<ProviderSeatRunnerSample> = {},
): ProviderSeatRunnerSample {
  return {
    row: {
      runner,
      status: 'ambient',
      activeLabel: 'ambient',
      source: 'claude-auth',
      usage: {
        accountEmail: `${runner}@example.com`,
        remainingPercent: quota,
        usedPercent: 100 - quota,
        resetsAt: null,
        loginMethod: 'max',
        source: 'claude-auth',
      },
    },
    identity: 'observed',
    quota: 'observed',
    ...overrides,
  };
}

function harness(
  options: {
    sample?: (machine: string) => Promise<ProviderSeatSample>;
    hasInterest?: (machine: string) => boolean;
  } = {},
) {
  const state = {
    now: 1000,
    calls: [] as string[],
    changes: [] as string[],
    topology: new Map([
      ['alpha', 'alpha-1'],
      ['beta', 'beta-1'],
    ]),
  };
  const owner = new ProviderAccountObservation({
    now: () => state.now,
    topology: async () => state.topology,
    sample: async (machine) => {
      state.calls.push(machine);
      return options.sample ? options.sample(machine) : { runners: [seat('claude', 50)] };
    },
    unknown: (machine) => ({ machine, checkedAt: '', reachable: false, runners: [] }),
    hasInterest: options.hasInterest ?? (() => false),
    changed: (machine) => state.changes.push(machine),
  });
  return { owner, state };
}

test('overlapping and all-machine selectors share one owner and one in-flight probe', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { owner, state } = harness({
    sample: async () => {
      await gate;
      state.now = 2000;
      return { runners: [seat('claude', 50)] };
    },
  });
  const all = owner.read({}, false, managed);
  const one = owner.read({ machines: ['alpha'] }, false, managed);
  const forced = owner.read({ machines: ['alpha', 'alpha'] }, true, managed);
  await Promise.resolve();
  release();
  const [allResult, oneResult, forcedResult] = await Promise.all([all, one, forced]);
  assert.deepEqual(state.calls.sort(), ['alpha', 'beta']);
  assert.deepEqual(oneResult.machines, [allResult.machines[0]]);
  assert.equal(forcedResult.machines.length, 1);
  // Source success is completion time, not the read or the probe start.
  assert.deepEqual(allResult.observation, { status: 'ready', observedAt: 2000 });
  assert.equal(allResult.checkedAt, new Date(2000).toISOString());
  state.now += PROVIDER_ACCOUNTS_READY_MS;
  await owner.read({}, false, managed);
  assert.equal(state.calls.length, 2, 'managed warm reads never probe');
  assert.equal((await owner.read({}, false, managed)).observation?.status, 'stale');
});

test('a failed component keeps its last success while independent components advance', async () => {
  let attempt = 0;
  const { owner, state } = harness({
    sample: async () => {
      attempt++;
      if (attempt === 1)
        return {
          runners: [
            seat('claude', 80),
            {
              ...seat('codex', 70),
              row: { ...seat('codex', 70).row, cooling: [{ label: 'seat-a' }] },
              cooling: 'observed',
            },
          ],
        };
      const failedQuota = seat('claude', 0, { quota: 'failed' });
      failedQuota.row.usage = { ...failedQuota.row.usage!, remainingPercent: null, error: 'raw' };
      // A fulfilled error DTO is not source success.
      return {
        runners: [failedQuota, { ...seat('codex', 60), identity: 'failed', cooling: 'failed' }],
      };
    },
  });
  await owner.read({ machines: ['alpha'] }, false, managed);
  state.now = 5000;
  const [machine] = (await owner.read({ machines: ['alpha'] }, true, managed)).machines;
  const [claude, codex] = machine.runners;
  assert.equal(claude.usage?.remainingPercent, 80);
  assert.equal(claude.usage?.accountEmail, 'claude@example.com');
  assert.deepEqual(claude.observations?.identity, { status: 'ready', observedAt: 5000 });
  assert.equal(claude.observations?.quota.status, 'stale');
  assert.equal(claude.observations?.quota.observedAt, 1000);
  assert.equal(claude.observations?.quota.error?.code, 'PROVIDER_QUOTA_UNAVAILABLE');
  assert.equal(codex.usage?.remainingPercent, 60);
  assert.equal(codex.observations?.identity.observedAt, 1000);
  assert.deepEqual(codex.cooling, [{ label: 'seat-a' }]);
  assert.equal(codex.observations?.cooling?.status, 'stale');
  assert.equal(codex.observations?.cooling?.error?.code, 'PROVIDER_COOLING_UNAVAILABLE');
  assert.equal(machine.observation?.status, 'stale');
  assert.equal(machine.observation?.observedAt, 1000);
});

test('cold failures report errors without inventing success; absence is a success', async () => {
  let fail = true;
  const { owner, state } = harness({
    sample: async () => ({
      runners: [
        seat('claude', 50, fail ? { identity: 'failed', quota: 'failed' } : {}),
        // A missing optional runner and an empty login are definitive answers.
        seat('grok', 0, { identity: 'absent', quota: 'absent' }),
      ],
    }),
  });
  const cold = await owner.read({ machines: ['alpha'] }, false, managed);
  assert.equal(cold.machines[0].runners[1].observations?.identity.status, 'ready');
  assert.equal(cold.observation?.status, 'stale');
  assert.equal(cold.observation?.observedAt, 1000);
  const { owner: failed } = harness({
    sample: async () => ({
      runners: [seat('claude', 50, { identity: 'failed', quota: 'failed' })],
    }),
  });
  const allFailed = await failed.read({ machines: ['alpha'] }, false, managed);
  assert.equal(allFailed.observation?.status, 'error');
  assert.equal(allFailed.observation?.observedAt, undefined);
  assert.equal(allFailed.checkedAt, '');
  const { owner: rejected } = harness({
    sample: () => Promise.reject(new Error('ssh: secret stderr')),
  });
  const host = await rejected.read({ machines: ['alpha'] }, false, managed);
  assert.equal(host.observation?.error?.code, 'PROVIDER_HOST_UNAVAILABLE');
  assert.equal(host.machines[0].reachable, false);
  fail = false;
  state.now = 3000;
  assert.deepEqual((await owner.read({ machines: ['alpha'] }, true, managed)).observation, {
    status: 'ready',
    observedAt: 3000,
  });
});

test('host failure keeps every retained row and its source age', async () => {
  let fail = false;
  const { owner, state } = harness({
    sample: async () => {
      if (fail) throw new Error('unreachable');
      return { runners: [seat('claude', 40)] };
    },
  });
  await owner.read({ machines: ['alpha'] }, false, managed);
  fail = true;
  state.now = 9000;
  const [machine] = (await owner.read({ machines: ['alpha'] }, true, managed)).machines;
  assert.equal(machine.reachable, false);
  assert.equal(machine.runners[0].usage?.remainingPercent, 40);
  assert.equal(machine.observation?.status, 'stale');
  assert.equal(machine.observation?.observedAt, 1000);
  assert.equal(machine.observation?.error?.code, 'PROVIDER_HOST_UNAVAILABLE');
  assert.equal(machine.checkedAt, new Date(1000).toISOString());
});

test('passive work needs interest and keeps attempts at least a minute apart', async () => {
  let interested = false;
  const { owner, state } = harness({ hasInterest: (machine) => interested && machine === 'beta' });
  await owner.tick();
  assert.deepEqual(state.calls, []);
  interested = true;
  await owner.tick();
  assert.deepEqual(state.calls, ['beta']);
  state.now += PROVIDER_ACCOUNTS_TTL_MS - 1;
  await owner.tick();
  assert.deepEqual(state.calls, ['beta']);
  state.now++;
  await owner.tick();
  assert.deepEqual(state.calls, ['beta', 'beta']);
  interested = false;
  state.now += PROVIDER_ACCOUNTS_TTL_MS;
  await owner.tick();
  assert.deepEqual(state.calls, ['beta', 'beta']);
});

test('legacy readers keep stale-while-revalidate and withdraw on adoption, forget or expiry', async () => {
  const { owner, state } = harness();
  const settled = () => new Promise((resolve) => setImmediate(resolve));
  await owner.read({ machines: ['alpha'] }, false, { legacyClientId: 'one' });
  assert.equal(state.calls.length, 1);
  state.now += PROVIDER_ACCOUNTS_TTL_MS;
  const served = await owner.read({ machines: ['alpha'] }, false, { legacyClientId: 'one' });
  assert.equal(served.machines[0].checkedAt, new Date(1000).toISOString());
  await settled();
  assert.equal(state.calls.length, 2, 'a due legacy read revalidates in the background');
  await owner.read({ machines: ['alpha'] }, false, {
    legacyClientId: 'one',
    legacyInterest: false,
  });
  state.now += PROVIDER_ACCOUNTS_TTL_MS;
  await owner.tick();
  assert.equal(state.calls.length, 2, 'adoption withdraws legacy demand');
  await owner.read({ machines: ['alpha'] }, false, { legacyClientId: 'two' });
  await settled();
  assert.equal(state.calls.length, 3);
  owner.forget('two');
  state.now += PROVIDER_ACCOUNTS_TTL_MS;
  await owner.tick();
  assert.equal(state.calls.length, 3, 'disconnect withdraws legacy demand');
  await owner.read({ machines: ['beta'] }, false, { legacyClientId: 'three' });
  assert.equal(state.calls.length, 4);
  state.now += PROVIDER_ACCOUNTS_TTL_MS;
  await owner.tick();
  assert.equal(state.calls.length, 5, 'live legacy demand keeps the minute cadence');
  state.now += PROVIDER_ACCOUNTS_LEGACY_INTEREST_MS;
  await owner.tick();
  assert.equal(state.calls.length, 5, 'legacy demand expires without new reads');
});

test('topology removal retires the owner and suppresses its late publication', async () => {
  const releases: Array<() => void> = [];
  let hold = false;
  const { owner, state } = harness({
    hasInterest: () => true,
    sample: async () => {
      if (hold) await new Promise<void>((resolve) => releases.push(resolve));
      return { runners: [seat('claude', 50)] };
    },
  });
  await owner.tick();
  assert.deepEqual(state.changes.sort(), ['alpha', 'beta']);
  hold = true;
  state.now += PROVIDER_ACCOUNTS_TTL_MS;
  const ticking = owner.tick();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(releases.length, 2);
  state.topology = new Map([['beta', 'beta-2']]);
  state.changes.length = 0;
  const after = await owner.read({ machines: ['alpha', 'ghost'] }, false, managed);
  assert.deepEqual(state.changes, ['alpha'], 'retirement is announced once');
  assert.deepEqual(
    after.machines.map((machine) => [machine.machine, machine.observation?.error?.code]),
    [
      ['alpha', 'PROVIDER_MACHINE_UNKNOWN'],
      ['ghost', 'PROVIDER_MACHINE_UNKNOWN'],
    ],
  );
  assert.equal(after.observation?.status, 'error');
  state.now += 1;
  for (const release of releases) release();
  await ticking;
  assert.deepEqual(state.changes, ['alpha', 'beta'], 'only the live owner publishes');
  assert.equal(state.calls.filter((machine) => machine === 'ghost').length, 0);
});

test('stop drains in-flight probes, prevents late notices and later work', async () => {
  let release!: () => void;
  const { owner, state } = harness({
    hasInterest: () => true,
    sample: () =>
      new Promise<ProviderSeatSample>((resolve) => {
        release = () => resolve({ runners: [seat('claude', 50)] });
      }),
  });
  const pending = owner.read({ machines: ['alpha'] }, false, managed);
  await new Promise((resolve) => setImmediate(resolve));
  let drained = false;
  const stopping = owner.stop().then(() => {
    drained = true;
  });
  await Promise.resolve();
  assert.equal(drained, false);
  release();
  await Promise.all([pending, stopping]);
  await owner.tick();
  await owner.read({ machines: ['alpha'] }, true, managed);
  assert.deepEqual(state.calls, ['alpha']);
  assert.deepEqual(state.changes, []);
});

test('identity rows carry no data from a failed probe over a retained success', async () => {
  let attempt = 0;
  const failedRow: ProviderRunnerAccountStatus = {
    runner: 'claude',
    status: 'error',
    activeLabel: null,
    error: 'raw stderr',
    usage: null,
  };
  const { owner } = harness({
    sample: async () =>
      ++attempt === 1
        ? { runners: [seat('claude', 30)] }
        : { runners: [{ row: failedRow, identity: 'failed', quota: 'failed' }] },
  });
  await owner.read({ machines: ['alpha'] }, false, managed);
  const [machine] = (await owner.read({ machines: ['alpha'] }, true, managed)).machines;
  assert.equal(machine.runners[0].status, 'ambient');
  assert.equal(machine.runners[0].error, undefined);
  assert.equal(machine.runners[0].usage?.accountEmail, 'claude@example.com');
});
