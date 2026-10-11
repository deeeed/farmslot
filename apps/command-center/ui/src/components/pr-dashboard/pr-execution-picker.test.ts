import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

import type { PropertyValues } from 'lit';

import type { PRSlotExecutionProfile } from '@farmslot/protocol';

mock.module('../../gateway-client.js', { namedExports: { gateway: {} } });
Object.defineProperty(globalThis, 'location', {
  configurable: true,
  value: new URL('http://localhost/'),
});
const { PRExecutionPicker } = await import('./pr-execution-picker.js');

class ExecutionPickerFixture extends PRExecutionPicker {
  openProfile(profile: PRSlotExecutionProfile) {
    const previous = this.value;
    this.value = profile;
    this.willUpdate(new Map([['value', previous]]) as PropertyValues<this>);
  }
}

function profile(count: number): PRSlotExecutionProfile {
  return {
    slotPolicy: { kind: 'exact', slotId: 'slot-1' },
    models: Array.from({ length: count }, (_, index) => ({
      runner: 'claude',
      model: index % 2 ? 'opus' : 'sonnet',
      effort: null,
      mode: 'cold',
      allowedSlots: ['slot-1'],
    })),
  };
}

for (const count of [6, 20]) {
  test(`opening a saved ${count}-alternative execution profile preserves the supported rows`, () => {
    const picker = new ExecutionPickerFixture();
    const value = profile(count);
    picker.openProfile(value);
    assert.deepEqual(picker.validationErrors, []);
    assert.deepEqual(picker.value, value);
    assert.ok(picker.render());
  });
}

test('execution profiles still reject more than twenty alternatives', () => {
  const picker = new ExecutionPickerFixture();
  assert.throws(() => picker.openProfile(profile(21)), /at most 20/);
});
