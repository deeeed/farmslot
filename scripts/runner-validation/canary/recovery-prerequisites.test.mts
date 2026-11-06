import assert from 'node:assert/strict';
import { test } from 'node:test';

import { requireRecoveryFaultSupport } from './recovery-prerequisites.mjs';

test('recovery requires the first Node version that composes the fault hook with tsx', () => {
  for (const version of ['20.19.0', '22.15.0', '22.22.2'])
    assert.throws(
      () => requireRecoveryFaultSupport(version),
      /Recovery matrix requires Node 22\.22\.3\+.*registerHooks/,
    );
  for (const version of ['22.22.3', '22.23.0', '24.0.0', '26.7.0'])
    assert.doesNotThrow(() => requireRecoveryFaultSupport(version));
});
