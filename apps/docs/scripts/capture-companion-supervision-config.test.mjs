import assert from 'node:assert/strict';
import test from 'node:test';

import {
  companionCaptureSlot,
  resolveCompanionCapturePorts,
} from './capture-companion-supervision-config.mjs';

test('capture uses distinct gateway and Metro ports from the dev-server resource', () => {
  const slot = companionCaptureSlot({
    slots: [
      {
        id: 'mac-companion-1',
        project: 'farmslot-farm',
        resources: {
          'dev-server': { port: 41_201, metro_port: 41_202 },
          'ios-sim': { simulator: 'Companion Test' },
        },
      },
    ],
  });

  assert.equal(slot?.simulator, 'Companion Test');
  assert.deepEqual(resolveCompanionCapturePorts({}, slot), {
    gatewayPort: '41201',
    metroPort: '41202',
  });
});

test('capture teaches migration when an existing dev-server lacks Metro', () => {
  const slot = companionCaptureSlot({
    slots: [
      {
        id: 'mac-companion-1',
        resources: { 'dev-server': { port: 41_201 } },
      },
    ],
  });

  assert.throws(
    () => resolveCompanionCapturePorts({}, slot),
    /missing resources\.dev-server\.metro_port.*farmslot update/i,
  );
});

test('capture requires manual pool configuration when dev-server is absent', () => {
  const slot = companionCaptureSlot({
    slots: [{ id: 'mac-companion-1', resources: {} }],
  });

  assert.throws(
    () => resolveCompanionCapturePorts({}, slot),
    /missing resources\.dev-server.*add it to the pool manually.*distinct port and metro_port/i,
  );
});

test('capture rejects gateway and Metro collisions', () => {
  assert.throws(
    () => resolveCompanionCapturePorts({ GATEWAY_PORT: '41201', METRO_PORT: '41201' }, null),
    /requires distinct.*port and metro_port/i,
  );
});
