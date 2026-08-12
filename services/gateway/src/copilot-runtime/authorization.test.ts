import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import {
  assertDangerousConfirmation,
  COPILOT_DANGEROUS_TYPED_PHRASE,
  COPILOT_DANGEROUS_WARNING,
  dangerousLaunchBinding,
} from './authorization.js';
import { testCheckout } from './test-helpers.js';

test('dangerous confirmation binds all displayed launch metadata', () => {
  const checkout = testCheckout('/operator/farmslot');
  const binding = dangerousLaunchBinding({ checkout, runner: 'cursor', model: 'test-model' });
  assert.deepEqual(
    {
      checkout: binding.checkout,
      branch: binding.branch,
      head: binding.head,
      dirtyFileCount: binding.dirtyFileCount,
      runner: binding.runner,
      model: binding.model,
      safetyTier: binding.safetyTier,
    },
    {
      checkout: checkout.path,
      branch: checkout.branch,
      head: checkout.head,
      dirtyFileCount: checkout.dirtyFileCount,
      runner: 'cursor',
      model: 'test-model',
      safetyTier: 'dangerous',
    },
  );
  assertDangerousConfirmation(binding, {
    fingerprint: binding.fingerprint,
    typedPhrase: COPILOT_DANGEROUS_TYPED_PHRASE,
    warningAcknowledged: true,
  });
  const expectedFingerprint = createHash('sha256')
    .update(
      JSON.stringify({
        checkout: checkout.path,
        branch: checkout.branch,
        head: checkout.head,
        dirtyFileCount: checkout.dirtyFileCount,
        runner: 'cursor',
        model: 'test-model',
        safetyTier: 'dangerous',
        typedPhrase: COPILOT_DANGEROUS_TYPED_PHRASE,
        warning: COPILOT_DANGEROUS_WARNING,
      }),
    )
    .digest('hex');
  assert.equal(binding.fingerprint, expectedFingerprint);
});

test('dangerous confirmation rejects stale metadata and incomplete acknowledgement', () => {
  const binding = dangerousLaunchBinding({
    checkout: testCheckout('/operator/farmslot'),
    runner: 'cursor',
    model: 'test-model',
  });
  assert.throws(() => assertDangerousConfirmation(binding, undefined), /typed confirmation/);
  assert.throws(
    () =>
      assertDangerousConfirmation(binding, {
        fingerprint: 'stale',
        typedPhrase: binding.typedPhrase,
        warningAcknowledged: true,
      }),
    /displayed launch metadata/,
  );
  assert.match(COPILOT_DANGEROUS_WARNING, /same-user OS access is not hard containment/);
  for (const boundary of [
    'gate approval',
    'publication',
    'merge',
    'release',
    'deletion',
    'cancellation',
    'backlog dispatch',
    'dispatch expansion',
  ]) {
    assert.match(COPILOT_DANGEROUS_WARNING, new RegExp(boundary));
  }
});
