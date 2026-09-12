import assert from 'node:assert/strict';
import test from 'node:test';

import type { Principal } from '@farmslot/protocol';

import { nativeNodeDeclaration } from './native-node.js';

const principal: Principal = {
  id: 'node-a-principal',
  subject: { type: 'node', displayName: 'Node A', machine: 'node-a' },
  roles: [],
};

test('native node declarations require an issued credential for that exact machine', () => {
  const declaration = { ownerPrincipalId: 'owner' };
  assert.deepEqual(nativeNodeDeclaration(declaration, 'node-a', principal, true), declaration);
  assert.throws(
    () => nativeNodeDeclaration(declaration, 'node-b', principal, true),
    /issued machine credential/,
  );
  assert.equal(nativeNodeDeclaration(declaration, 'node-a', principal, false), undefined);
  assert.throws(() => nativeNodeDeclaration({}, 'node-a', principal, true), /configured owner/);
  assert.equal(nativeNodeDeclaration(undefined, 'legacy', undefined, false), undefined);
  for (const supportsEnsure of [true, false])
    assert.deepEqual(
      nativeNodeDeclaration({ ...declaration, supportsEnsure }, 'node-a', principal, true),
      { ...declaration, supportsEnsure },
    );
  for (const supportsEnsure of ['true', 1, null])
    assert.throws(
      () => nativeNodeDeclaration({ ...declaration, supportsEnsure }, 'node-a', principal, true),
      /supportsEnsure must be boolean/,
    );
});
