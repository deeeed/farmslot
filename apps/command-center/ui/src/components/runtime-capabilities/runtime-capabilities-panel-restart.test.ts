import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { RUNTIME_CAPABILITY_ACQUIRE_TIMEOUT_MS } from '../../utils/resource-operation-timeout.js';

/**
 * Source-level guard for the restart sequence.
 *
 * Restart releases and then reacquires. `ok: true` on the release is not proof
 * the lease went away — the Gateway skips leases it will not act on and still
 * reports success — so reacquiring without confirming can start a second
 * provider on top of one that never stopped. The panel is a Lit component with
 * live RPCs, so this guards the ordering at the source rather than by mounting.
 */
function panelSource(): string {
  return readFileSync(path.resolve(import.meta.dirname, 'runtime-capabilities-panel.ts'), 'utf8');
}

test('restart confirms its lease was released before it reacquires', () => {
  const source = panelSource();
  const restart = source.slice(source.indexOf('private async restart('));
  const confirmAt = restart.indexOf('released.released.some');
  const reacquireAt = restart.indexOf('RUNTIME_CAPABILITY_ACQUIRE');

  assert.ok(confirmAt > -1, 'restart must confirm the lease appears in the released list');
  assert.ok(reacquireAt > -1, 'restart must reacquire');
  assert.ok(confirmAt < reacquireAt, 'the confirmation has to come before the reacquire');
});

test('stop also confirms the Gateway actually released the lease', () => {
  const source = panelSource();
  const release = source.slice(
    source.indexOf('private async release('),
    source.indexOf('private async acquire('),
  );

  assert.match(release, /result\.released\.some/);
});

test('acquire and restart leave time for dependent resources and a cold simulator boot', () => {
  const source = panelSource();
  const acquire = source.slice(
    source.indexOf('private async acquire('),
    source.indexOf('private async restart('),
  );
  const restart = source.slice(source.indexOf('private async restart('));

  assert.ok(RUNTIME_CAPABILITY_ACQUIRE_TIMEOUT_MS >= 150_000 + 120_000);
  assert.match(acquire, /RUNTIME_CAPABILITY_ACQUIRE_TIMEOUT_MS/);
  assert.match(restart, /RUNTIME_CAPABILITY_ACQUIRE_TIMEOUT_MS/);
});
