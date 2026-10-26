import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

import { providerAccountsStoredData } from '@farmslot/protocol';

import * as config from '../core/config.js';
import * as exec from '../core/exec.js';
import * as fleet from '../fleet/state.js';
import * as host from '../runners/provider-account-host.js';
import type { RunnerActiveSubscription } from '../runners/status-provider.js';
import * as status from '../runners/status-provider.js';
import { makeVars } from '../runners/test-fixtures.js';
import * as ledger from '../runners/usage-exhaustion-ledger.js';

// Fleet, host resolution, subscriptions and the cooling ledger are faked; no provider CLI runs.
let ledgerFails = true;
let probes = 0;
mock.module('../fleet/state.js', {
  namedExports: {
    ...fleet,
    loadFleetStatus: async () => ({
      slots: [
        { machine: 'alpha', slot: 'alpha-1' },
        { machine: 'down', slot: 'down-1' },
      ],
    }),
  },
});
mock.module('../core/config.js', {
  namedExports: {
    ...config,
    loadSlotVars: async (slotId: string) => {
      if (slotId === 'down-1') throw new Error('ssh: connect refused with private detail');
      return makeVars({ slotId, machine: 'alpha', host: 'localhost' });
    },
  },
});
mock.module('../core/exec.js', { namedExports: { ...exec, isLocal: () => true } });
mock.module('../runners/provider-account-host.js', {
  namedExports: {
    ...host,
    hostListEligibleLabels: async () => {
      throw new Error('unexpected remote cooling probe');
    },
  },
});
mock.module('../runners/usage-exhaustion-ledger.js', {
  namedExports: {
    ...ledger,
    loadExhaustionLedger: () => {
      if (ledgerFails) throw new Error('ledger unreadable');
      return {
        entries: {
          a: {
            provider: 'codex',
            label: 'seat-a',
            tier: 'session',
            expiresAt: '2999-01-01T00:00:00Z',
          },
        },
      };
    },
  },
});
mock.module('../runners/status-provider.js', {
  namedExports: {
    ...status,
    getHostRunnerSubscriptions: async (): Promise<RunnerActiveSubscription[]> => {
      probes++;
      return [
        {
          runner: 'codex',
          accountLabel: 'seat-a',
          authPath: '/Users/operator/.codex/auth.json',
          accountEmail: 'codex@example.com',
          remainingPercent: 30,
          usedPercent: 70,
          resetsAt: null,
          loginMethod: 'pro',
          source: 'active-profile',
          supportsAccountBinding: true,
          codexBarProviderId: 'codex',
          inventory: {
            status: 'available',
            scope: 'host-default',
            accounts: [],
            inspection: { command: 'node cli probe-identity', description: 'copy only' },
          },
          outcome: { identity: 'observed', quota: 'observed' },
        },
      ];
    },
  },
});
const {
  forgetProviderAccountsClientInterest,
  providerAccountsSnapshot,
  startProviderAccountsObservation,
  wakeProviderAccountsObservation,
} = await import('./provider-accounts.js');

test('snapshot exposes cooling failure, host failure and unknown rows; storage drops live detail', async () => {
  const result = await providerAccountsSnapshot({ machines: ['alpha', 'down', 'ghost'] });
  const [alpha, down, ghost] = result.machines;
  assert.equal(alpha.runners[0].observations?.cooling?.status, 'error');
  assert.equal(alpha.runners[0].observations?.identity.status, 'ready');
  assert.equal(alpha.observation?.status, 'stale');
  assert.ok(alpha.runners[0].inventory?.inspection, 'live reads keep the copy-only inspection');
  assert.equal(down.reachable, false);
  assert.equal(down.observation?.status, 'error');
  assert.equal(down.observation?.error?.code, 'PROVIDER_HOST_UNAVAILABLE');
  assert.equal(ghost.observation?.error?.code, 'PROVIDER_MACHINE_UNKNOWN');
  assert.equal(result.observation?.status, 'stale');
  ledgerFails = false;
  const refreshed = await providerAccountsSnapshot({ machines: ['alpha'], forceRefresh: true });
  assert.deepEqual(refreshed.machines[0].runners[0].cooling, [
    { label: 'seat-a', tier: 'session', expiresAt: '2999-01-01T00:00:00Z' },
  ]);
  assert.equal(refreshed.observation?.status, 'ready');
  const stored = JSON.stringify(providerAccountsStoredData(result));
  assert.doesNotMatch(stored, /inspection|probe-identity|auth\.json|private detail/);
});

test('observation has one starter and stop suppresses later work and notices', async () => {
  const changes: string[] = [];
  forgetProviderAccountsClientInterest('anyone');
  const stop = startProviderAccountsObservation({
    hasInterest: (machine) => machine === 'down',
    changed: (machine) => changes.push(machine),
  });
  assert.throws(() =>
    startProviderAccountsObservation({ hasInterest: () => false, changed: () => {} }),
  );
  const before = probes;
  await wakeProviderAccountsObservation();
  assert.equal(probes, before, 'nothing is due within the minute cadence');
  await stop();
  await wakeProviderAccountsObservation();
  await providerAccountsSnapshot({ machines: ['alpha'], forceRefresh: true });
  assert.equal(probes, before);
  assert.deepEqual(changes, []);
});
