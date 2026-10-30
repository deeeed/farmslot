import assert from 'node:assert/strict';
import test from 'node:test';

import type { SlotStatus } from '@farmslot/protocol';

import { fleetSeatsQuery } from './fleet-seats-query.js';

const slot = (machine: string) => ({ slot: `${machine}-1`, machine }) as SlotStatus;

test('fleet seats name the fleet machines, so slot changes do not reread them', () => {
  assert.equal(fleetSeatsQuery([]), undefined);
  const query = fleetSeatsQuery([slot('mini'), slot('macpro'), slot('mini')]);
  assert.deepEqual(query?.params, { machines: ['macpro', 'mini'] });
  assert.ok(query?.dependencies.length);
  assert.ok(query?.dependencies.every((key) => key.family === 'upstream'));
});
