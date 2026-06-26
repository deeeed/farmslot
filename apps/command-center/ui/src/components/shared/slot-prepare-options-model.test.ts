import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildSlotPreparePlan,
  projectPrepareProfileFallback,
  reconcilePrepareProfile,
  resolveBindOnly,
  suggestPrepareRecovery,
} from './slot-prepare-options-model.js';

test('reconcilePrepareProfile prefers attach then project default', () => {
  assert.equal(
    reconcilePrepareProfile(
      [
        { name: 'full', label: 'Full', isDefault: true },
        { name: 'attach', label: 'Attach', isDefault: false },
      ],
      'missing',
    ),
    'attach',
  );
});

test('resolveBindOnly respects forcePrepare', () => {
  assert.equal(resolveBindOnly('feature/a', 'feature/a', false), true);
  assert.equal(resolveBindOnly('feature/a', 'feature/a', true), false);
});

test('buildSlotPreparePlan surfaces bind-only and branch checkout', () => {
  const bindOnly = buildSlotPreparePlan({
    runBranch: 'feature/a',
    slotBranch: 'feature/a',
    strictProfile: true,
    prepareProfile: 'attach',
    forcePrepare: false,
  });
  assert.equal(bindOnly.mode, 'bind-only');

  const checkout = buildSlotPreparePlan({
    runBranch: 'feature/a',
    slotBranch: 'main',
    strictProfile: true,
    prepareProfile: 'attach',
    forcePrepare: false,
  });
  assert.equal(checkout.mode, 'checkout');
  assert.match(checkout.lines.join(' '), /main.*feature\/a/);
});

test('projectPrepareProfileFallback reads project config', () => {
  const fallback = projectPrepareProfileFallback(
    [
      {
        name: 'example-mobile',
        prepare: {
          profiles: {
            attach: { phases: ['git'], requires: ['health_ok'], fallback: 'ensure-js-runtime' },
            'ensure-js-runtime': { phases: ['git', 'deps'], requires: [] },
          },
        },
      },
    ],
    'example-mobile',
    'attach',
  );
  assert.equal(fallback, 'ensure-js-runtime');
});

test('suggestPrepareRecovery offers fallback profile on precondition failure', () => {
  const suggestion = suggestPrepareRecovery(
    "Prepare profile 'attach' preconditions failed (health_ok: WalletView not ready)",
    'attach',
    [
      {
        name: 'example-mobile',
        prepare: {
          profiles: {
            attach: { phases: ['git'], requires: ['health_ok'], fallback: 'ensure-js-runtime' },
            'ensure-js-runtime': { phases: ['git', 'deps'], requires: [] },
          },
        },
      },
    ],
    'example-mobile',
  );
  assert.equal(suggestion.profile, 'ensure-js-runtime');
});