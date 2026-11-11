import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

import secretScan from '../host-services/secret-scan.js';

// Counts scans in the caller's thread. The worker thread loads the real module.
const scrub = await import('@farmslot/handoff/scrub');
let callerThreadScans = 0;
mock.module('@farmslot/handoff/scrub', {
  namedExports: {
    ...scrub,
    scanForFloorSecrets: (...args: Parameters<typeof scrub.scanForFloorSecrets>) => {
      callerThreadScans += 1;
      return scrub.scanForFloorSecrets(...args);
    },
  },
});
const { assertPublicationTextSafe, PublicationSecretError } =
  await import('./publication-secrets.js');

const secret = `private_key = ${'1'.repeat(64)}`;

test('publication text is scanned on the worker thread, never in the caller', async () => {
  await assert.rejects(assertPublicationTextSafe('Clean summary.', secret), PublicationSecretError);
  await assertPublicationTextSafe('Clean summary.', 'Recipe passed.');
  assert.equal(callerThreadScans, 0);
});

test('a scan stopped before it completes refuses, and the next scan starts a new worker', async () => {
  const refused = assert.rejects(
    assertPublicationTextSafe('clean diagnostic line\n'.repeat(50_000)),
    (error: unknown) =>
      error instanceof Error &&
      !(error instanceof PublicationSecretError) &&
      /stopped/.test(error.message),
  );
  await secretScan.stop();
  await refused;
  await assert.rejects(assertPublicationTextSafe(secret), PublicationSecretError);
  await secretScan.stop();
});
