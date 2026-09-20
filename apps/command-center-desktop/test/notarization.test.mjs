import assert from 'node:assert/strict';
import { test } from 'node:test';

import { requireNotarizationCredentials } from '../scripts/notarization.mjs';

test('distribution rejects missing or incomplete notarization credentials before build', () => {
  assert.throws(() => requireNotarizationCredentials({}), /credentials are required/);
  assert.throws(
    () => requireNotarizationCredentials({ APPLE_ID: 'user', APPLE_KEYCHAIN_PROFILE: 'valid' }),
    /Missing.*PASSWORD/,
  );
  assert.throws(() => requireNotarizationCredentials({ APPLE_API_KEY: 'file' }), /Missing.*KEY_ID/);
  assert.throws(() => requireNotarizationCredentials({ APPLE_KEYCHAIN_PROFILE: ' ' }), /Missing/);
  assert.doesNotThrow(() =>
    requireNotarizationCredentials({
      APPLE_ID: 'user',
      APPLE_APP_SPECIFIC_PASSWORD: 'secret',
      APPLE_TEAM_ID: 'team',
    }),
  );
  assert.doesNotThrow(() =>
    requireNotarizationCredentials({
      APPLE_API_KEY: 'file',
      APPLE_API_KEY_ID: 'id',
      APPLE_API_ISSUER: 'issuer',
    }),
  );
  assert.doesNotThrow(() => requireNotarizationCredentials({ APPLE_KEYCHAIN_PROFILE: 'profile' }));
});
