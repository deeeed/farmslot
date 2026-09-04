import assert from 'node:assert/strict';
import test from 'node:test';

import { RESOURCE_POSTURE_WAIT_POLICIES } from '@farmslot/protocol';

import { summarizeBacklogDispatchConfig } from './dispatch-config-summary.js';

test('a dispatch wait policy is visible in the read-only summary', () => {
  // Without this the operator could set a wait policy in the editor and never
  // see it again on the item.
  const summary = summarizeBacklogDispatchConfig({ waitPolicy: 'minimize' });

  assert.equal(summary.visible, true);
  assert.ok(summary.rows.includes('Wait policy: minimize'));
  assert.ok(summary.chips.some((chip) => chip.label === 'wait: minimize'));
});

test('an item with no dispatch config, wait policy included, stays hidden', () => {
  assert.equal(summarizeBacklogDispatchConfig({}).visible, false);
});

test('every protocol wait policy renders, so none is silently dropped', () => {
  for (const policy of RESOURCE_POSTURE_WAIT_POLICIES) {
    const summary = summarizeBacklogDispatchConfig({ waitPolicy: policy });
    assert.ok(summary.rows.includes(`Wait policy: ${policy}`), `${policy} missing from rows`);
  }
});
