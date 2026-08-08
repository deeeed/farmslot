import assert from 'node:assert/strict';
import test from 'node:test';

import { pairingAuthorityFromSelection } from './app-shell-pairing-model.js';

test('pairing authority requires an explicit selection', () => {
  assert.throws(
    () => pairingAuthorityFromSelection('', '', '', ''),
    /explicit Companion pairing authority/u,
  );
});

test('pairing authority validates and preserves an existing principal choice', () => {
  assert.throws(
    () => pairingAuthorityFromSelection('existing-principal', ' ', '', ''),
    /existing principal ID/u,
  );
  assert.deepEqual(pairingAuthorityFromSelection('existing-principal', ' owner-id ', '', ''), {
    kind: 'existing-principal',
    principalId: 'owner-id',
  });
});

test('pairing authority validates and preserves a new service principal choice', () => {
  assert.throws(
    () => pairingAuthorityFromSelection('new-service-principal', '', 'Companion', ''),
    /service principal role/u,
  );
  assert.deepEqual(
    pairingAuthorityFromSelection('new-service-principal', '', ' Companion phone ', 'operator'),
    {
      kind: 'new-service-principal',
      displayName: 'Companion phone',
      roles: [{ role: 'operator', scope: { kind: 'global' } }],
    },
  );
});
