import assert from 'node:assert/strict';
import test from 'node:test';

import { assertPublicationTextSafe, PublicationSecretError } from './publication-secrets.js';

test('secret refusals expose fingerprints and recovery, never source values', async () => {
  // The published all-zero-entropy BIP-39 test vector: checksum-valid, never a wallet.
  const phrase = [...Array<string>(11).fill('abandon'), 'about'].join(' ');
  const key = '1'.repeat(64);
  for (const text of [JSON.stringify({ arbitrary: phrase }), `private_key = ${key}`]) {
    await assert.rejects(
      () => assertPublicationTextSafe(text),
      (error: unknown) => {
        assert.ok(error instanceof PublicationSecretError);
        assert.match(error.message, /(?:srp|private-key) sha256:[a-f0-9]{12}/);
        assert.match(error.message, /rerun the recipe, then refresh the gate package/);
        assert.ok(!error.message.includes(phrase));
        assert.ok(!error.message.includes(key));
        return true;
      },
    );
  }
});

test('integrity and transaction hashes remain publishable', async () => {
  await assertPublicationTextSafe(
    JSON.stringify({ sha256: '1'.repeat(64), transaction: `0x${'2'.repeat(64)}` }),
    'Recipe passed. No secrets are included.',
  );
});

test('a reused clean verdict cannot authorize changed text', async () => {
  const text = 'Repeated immutable diagnostic input.';
  await assertPublicationTextSafe(text);
  await assertPublicationTextSafe(text);
  await assert.rejects(
    () => assertPublicationTextSafe(`${text}\nprivate_key = ${'1'.repeat(64)}`),
    PublicationSecretError,
  );
});
