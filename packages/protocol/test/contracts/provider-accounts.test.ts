import assert from 'node:assert/strict';
import test from 'node:test';

import {
  providerAccountsChangedKeys,
  providerAccountsDependencies,
  providerAccountsObservationParams,
  providerAccountsStoredData,
} from '../../src/contracts/provider-accounts.js';

test('durable provider seats keep identifiers, bounded identity, numbers and source ages only', () => {
  const stored = providerAccountsStoredData({
    checkedAt: '2026-10-26T10:00:00.000Z',
    observation: { status: 'stale', observedAt: 1000, error: { code: 'X', message: 'y' } },
    secret: 'top-level extra',
    machines: [
      {
        machine: 'macwork',
        checkedAt: '2026-10-26T10:00:00.000Z',
        reachable: true,
        observation: { status: 'ready', observedAt: 1000 },
        runners: [
          {
            runner: 'codex',
            status: 'bound',
            activeLabel: 'seat-a',
            source: 'active-profile',
            authPath: '/Users/operator/.codex/auth.json',
            error: 'ssh: stderr with token sk-PRIVATE',
            cooling: [{ label: 'seat-b', tier: 'session', expiresAt: '2026-10-26T11:00:00Z' }],
            inventory: {
              status: 'available',
              scope: 'host-default',
              error: 'raw inventory error',
              inspection: { command: 'cat ~/.codex/auth.json', description: 'copy' },
              accounts: [
                {
                  id: 'seat-a',
                  provider: 'openai',
                  email: 'a@example.com',
                  status: 'configured',
                  authType: 'oauth',
                  source: 'native-status',
                  authPath: '/private/auth.json',
                },
              ],
            },
            usage: {
              accountEmail: 'a@example.com',
              remainingPercent: 42,
              usedPercent: 58,
              resetsAt: '2026-10-26T12:00:00Z',
              loginMethod: 'pro · chatgpt',
              source: 'codexbar',
              error: 'codexbar stderr dump',
            },
            observations: {
              identity: { status: 'ready', observedAt: 1000 },
              quota: { status: 'stale', observedAt: 900, error: { code: 'Q', message: 'quota' } },
              cooling: { status: 'error', error: { code: 'C', message: 'cooling' } },
            },
          },
          {
            runner: 'claude',
            status: 'invented',
            activeLabel: 'x'.repeat(129),
            usage: { accountEmail: 'not an email', remainingPercent: 140, usedPercent: Number.NaN },
          },
          { runner: '../escape', status: 'bound' },
        ],
      },
      { machine: 'bad machine', runners: [] },
    ],
  });
  assert.deepEqual(stored, {
    checkedAt: '2026-10-26T10:00:00.000Z',
    observation: { status: 'stale', observedAt: 1000, error: { code: 'X', message: 'y' } },
    machines: [
      {
        machine: 'macwork',
        checkedAt: '2026-10-26T10:00:00.000Z',
        reachable: true,
        observation: { status: 'ready', observedAt: 1000 },
        runners: [
          {
            runner: 'codex',
            status: 'bound',
            activeLabel: 'seat-a',
            source: 'active-profile',
            cooling: [{ label: 'seat-b', tier: 'session', expiresAt: '2026-10-26T11:00:00Z' }],
            inventory: {
              status: 'available',
              scope: 'host-default',
              accounts: [
                {
                  id: 'seat-a',
                  provider: 'openai',
                  email: 'a@example.com',
                  status: 'configured',
                  authType: 'oauth',
                  source: 'native-status',
                },
              ],
            },
            usage: {
              accountEmail: 'a@example.com',
              remainingPercent: 42,
              usedPercent: 58,
              resetsAt: '2026-10-26T12:00:00Z',
              loginMethod: 'pro · chatgpt',
              source: 'codexbar',
            },
            observations: {
              identity: { status: 'ready', observedAt: 1000 },
              quota: { status: 'stale', observedAt: 900, error: { code: 'Q', message: 'quota' } },
              cooling: { status: 'error', error: { code: 'C', message: 'cooling' } },
            },
          },
          {
            runner: 'claude',
            status: 'unknown',
            activeLabel: null,
            usage: {
              accountEmail: null,
              remainingPercent: null,
              usedPercent: null,
              resetsAt: null,
              loginMethod: null,
              source: null,
            },
          },
        ],
      },
    ],
  });
  assert.doesNotMatch(JSON.stringify(stored), /PRIVATE|auth\.json|stderr|inspection|command/);
});

test('durable provider seats tolerate missing or malformed replies', () => {
  assert.deepEqual(providerAccountsStoredData(undefined), { machines: [], checkedAt: '' });
  assert.deepEqual(providerAccountsStoredData({ machines: 'nope', observation: { status: 'x' } }), {
    machines: [],
    checkedAt: '',
  });
});

test('observer identity rejects forced probes and canonicalizes machine selectors', () => {
  assert.deepEqual(providerAccountsObservationParams(undefined), {});
  assert.deepEqual(providerAccountsObservationParams({ machines: [] }), {});
  assert.deepEqual(providerAccountsObservationParams({ forceRefresh: false }), {});
  assert.deepEqual(providerAccountsObservationParams({ machines: ['mini', 'macwork', 'mini'] }), {
    machines: ['macwork', 'mini'],
  });
  for (const params of [
    { forceRefresh: true },
    { machines: ['macwork'], extra: 1 },
    { machines: 'macwork' },
    { machines: ['../escape'] },
    { machines: [''] },
    { machines: Array.from({ length: 65 }, (_, index) => `m${index}`) },
    [],
    'macwork',
  ])
    assert.throws(() => providerAccountsObservationParams(params), JSON.stringify(params));
});

test('dependencies follow single-machine collector ids and fleet topology for all machines', () => {
  const machineKey = (machine: string) => ({
    family: 'upstream',
    integration: 'providers',
    queryId: `providerAccounts.snapshot:{"machines":["${machine}"]}`,
  });
  const allKey = {
    family: 'upstream',
    integration: 'providers',
    queryId: 'providerAccounts.snapshot:{}',
  };
  assert.deepEqual(providerAccountsDependencies({ machines: ['mini', 'macwork', 'mini'] }), [
    machineKey('macwork'),
    machineKey('mini'),
  ]);
  // Imperative reads are stamped from raw params; their force flag does not change keys.
  assert.deepEqual(providerAccountsDependencies({ machines: ['mini'], forceRefresh: true }), [
    machineKey('mini'),
  ]);
  for (const params of [{}, { machines: [] }, undefined, { forceRefresh: true }])
    assert.deepEqual(providerAccountsDependencies(params), [
      allKey,
      { family: 'slots', scope: 'farm' },
    ]);
  assert.deepEqual(providerAccountsChangedKeys('mini'), [machineKey('mini'), allKey]);
});
