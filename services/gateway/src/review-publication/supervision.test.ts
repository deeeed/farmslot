import assert from 'node:assert/strict';
import test from 'node:test';

import type { Run } from '@farmslot/protocol';

import { supervisedPublicationOwner } from './supervision.js';

test('an admin publishes the native owner review as that owner, never as itself', (t) => {
  const previous = process.env.FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID;
  process.env.FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID = 'farm-automation';
  t.after(() => {
    if (previous === undefined) delete process.env.FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID;
    else process.env.FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID = previous;
  });
  const delegated: Pick<Run, 'reviewPublication' | 'prWork'> = {
    reviewPublication: {
      direct: {
        ownerId: 'farm-automation',
        requested: true,
        pr: { host: 'github.com', repo: 'owner/repo', number: 1 },
        policy: { enabled: false, source: 'built-in' },
      },
      checkedAt: '2026-10-17T00:00:00.000Z',
    },
  };
  // The generation-one requester retries publication of its delegated review.
  assert.deepEqual(supervisedPublicationOwner(delegated, 'arthur', true), {
    ownerId: 'farm-automation',
    ownerGeneration: undefined,
  });
  assert.equal(supervisedPublicationOwner(delegated, 'arthur', false), undefined);
  assert.equal(supervisedPublicationOwner(delegated, 'farm-automation', true), undefined);
  // Supervision covers only the configured native owner's reviews.
  process.env.FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID = 'other-owner';
  assert.equal(supervisedPublicationOwner(delegated, 'arthur', true), undefined);
  assert.equal(supervisedPublicationOwner(undefined, 'arthur', true), undefined);
});
