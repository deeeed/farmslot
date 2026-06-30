import assert from 'node:assert/strict';
import test from 'node:test';

import type { GatewayDoctorParams } from '@farmslot/protocol';

import { gatewayDoctor } from './gateway-doctor.js';

test('gatewayDoctor returns a gateway-owned catalog without running checks', async () => {
  const result = await gatewayDoctor({ run: false });

  assert.deepEqual(
    result.availableSections.map((section) => section.id),
    ['gateway', 'workspace', 'capture', 'browser', 'simulator', 'android'],
  );
  assert.deepEqual(result.requestedSectionIds, [
    'gateway',
    'workspace',
    'capture',
    'browser',
    'simulator',
    'android',
  ]);
  assert.equal(result.sections.length, 0);
  assert.deepEqual(result.summary, { ok: 0, warn: 0, fail: 0 });
  assert.ok(result.availableSections.every((section) => section.label && section.description));
});

test('gatewayDoctor validates requested sections and preserves gateway catalog order', async () => {
  const result = await gatewayDoctor({ run: false, sectionIds: ['android', 'gateway', 'android'] });

  assert.deepEqual(result.requestedSectionIds, ['gateway', 'android']);
});

test('gatewayDoctor rejects unknown section ids with a clear API error', async () => {
  const params = { run: false, sectionId: 'not-a-section' } as unknown as GatewayDoctorParams;

  await assert.rejects(() => gatewayDoctor(params), /Unknown gateway\.doctor sectionId/);
});
