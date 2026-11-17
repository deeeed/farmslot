import assert from 'node:assert/strict';
import test from 'node:test';

import type { ResourceQueryState } from '@farmslot/protocol/client-cache';

import { resourcePresentationChanged } from './resource-presentation.js';

test('equal visible facts skip rendering while observation metadata advances', () => {
  const data = { value: 'retained' };
  const first: ResourceQueryState = { status: 'ready', data, observedAt: 1 };
  assert.equal(resourcePresentationChanged({ ...first, observedAt: 2 }, first), false);
  assert.equal(resourcePresentationChanged({ ...first, data: { value: 'new' } }, first), true);
  assert.equal(resourcePresentationChanged({ ...first, status: 'stale' }, first), true);
  assert.equal(
    resourcePresentationChanged(
      { ...first, error: { code: 'FAILED', message: 'Read failed' } },
      first,
    ),
    true,
  );
  assert.equal(resourcePresentationChanged({ status: 'loading' }, first), true);
  const stale: ResourceQueryState = { ...first, status: 'stale' };
  assert.equal(resourcePresentationChanged({ ...stale, observedAt: 2 }, stale), true);
});
