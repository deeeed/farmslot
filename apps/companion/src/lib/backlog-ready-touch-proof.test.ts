import assert from 'node:assert/strict';
import test from 'node:test';

import type { GestureResponderEvent } from 'react-native';

import {
  isBacklogReadyTouchProofEnabled,
  readBacklogReadyTouches,
  recordBacklogReadyTouch,
} from '../farmslot/backlog-ready-touch-proof';

const devGlobal = globalThis as typeof globalThis & { __DEV__?: boolean };
const previousDev = devGlobal.__DEV__;
const previousBridge = process.env.EXPO_PUBLIC_FARMSLOT_RECIPE_BRIDGE;

test.beforeEach(() => {
  devGlobal.__DEV__ = true;
  process.env.EXPO_PUBLIC_FARMSLOT_RECIPE_BRIDGE = '1';
});
test.afterEach(() => {
  if (previousDev === undefined) delete devGlobal.__DEV__;
  else devGlobal.__DEV__ = previousDev;
  if (previousBridge === undefined) delete process.env.EXPO_PUBLIC_FARMSLOT_RECIPE_BRIDGE;
  else process.env.EXPO_PUBLIC_FARMSLOT_RECIPE_BRIDGE = previousBridge;
});

const nativeEvent: GestureResponderEvent['nativeEvent'] = {
  pageX: 65,
  pageY: 336,
  locationX: 40,
  locationY: 10,
  identifier: 0,
  target: 42,
  timestamp: 12345,
  changedTouches: [],
  touches: [],
};
const control = { itemId: 'owned', testId: 'companion-backlog-owned-ready', disabled: true };

test('native touch observation requires both development and the recipe bridge', () => {
  for (const [dev, bridge] of [
    [false, '1'],
    [true, '0'],
  ] as const) {
    devGlobal.__DEV__ = dev;
    process.env.EXPO_PUBLIC_FARMSLOT_RECIPE_BRIDGE = bridge;
    assert.equal(isBacklogReadyTouchProofEnabled(), false);
    recordBacklogReadyTouch(nativeEvent, control);
    assert.deepEqual(readBacklogReadyTouches(), []);
  }
});

test('the input receipt copies rendered control state and native event facts', () => {
  const before = Date.now();
  recordBacklogReadyTouch(nativeEvent, control);
  const touch = readBacklogReadyTouches().at(-1);
  assert(touch);
  assert(touch.receivedAt >= before && touch.receivedAt <= Date.now());
  assert.equal(touch.kind, 'native-touch-start');
  assert.equal(touch.disabled, true);
  assert.equal(touch.nativeTimestamp, nativeEvent.timestamp);
  assert.equal(touch.nativeTarget, nativeEvent.target);
  assert.equal(touch.pageX, nativeEvent.pageX);
  assert.equal(touch.pageY, nativeEvent.pageY);
  assert.equal(touch.testId, control.testId);
  touch.testId = 'changed-reader-copy';
  assert.equal(readBacklogReadyTouches().at(-1)?.testId, control.testId);
});

test('input observations are bounded and sequences distinguish new gestures', () => {
  const baseline = readBacklogReadyTouches().at(-1)?.sequence ?? 0;
  for (let i = 0; i < 40; i++)
    recordBacklogReadyTouch(nativeEvent, { ...control, disabled: false });
  const touches = readBacklogReadyTouches();
  assert.equal(touches.length, 32);
  assert.equal(touches.at(-1)?.sequence, baseline + 40);
  assert(touches.every((touch) => touch.disabled === false));
});
