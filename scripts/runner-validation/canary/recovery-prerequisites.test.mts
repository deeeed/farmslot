import assert from 'node:assert/strict';
import { test } from 'node:test';

import { requireRecoveryFaultSupport } from './recovery-prerequisites.mjs';

test('recovery requires the first Node version that composes the fault hook with tsx', () => {
  for (const version of ['20.19.0', '22.15.0', '22.22.2', '23.0.0', '23.11.1', '24.11.0', '25.0.0'])
    assert.throws(
      () => requireRecoveryFaultSupport(version),
      /Recovery matrix requires Node 22\.x >= 22\.22\.3, 24\.x >= 24\.11\.1, 25\.x >= 25\.1\.0, or 26\+.*registerHooks.*23\.x is unsupported/,
    );
  for (const version of [
    '22.22.3',
    '22.23.0',
    '24.11.1',
    '24.12.0',
    '25.1.0',
    '25.2.0',
    '26.0.0',
    '26.7.0',
  ])
    assert.doesNotThrow(() => requireRecoveryFaultSupport(version));
});
