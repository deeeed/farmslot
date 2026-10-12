import assert from 'node:assert/strict';
import { test } from 'node:test';

import { type CdpSession, CdpWebPage } from '../src/runtime/cdp.js';

for (const [key, code] of [
  ['Enter', 13],
  ['Tab', 9],
  ['Escape', 27],
  ['Backspace', 8],
  ['Delete', 46],
  ['ArrowDown', 40],
  [' ', 32],
  ['a', 65],
  ['7', 55],
  ['F5', 116],
] as const) {
  test('CDP key press includes the virtual code for ' + JSON.stringify(key), async () => {
    const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
    const session = {
      async call(method: string, params: Record<string, unknown>) {
        calls.push({ method, params });
      },
    } as unknown as CdpSession;
    const result = await new CdpWebPage(session).keyPress(key);
    assert.deepEqual(result, { key });
    assert.deepEqual(
      calls,
      ['keyDown', 'keyUp'].map((type) => ({
        method: 'Input.dispatchKeyEvent',
        params: { type, key, windowsVirtualKeyCode: code },
      })),
    );
  });
}

test('unmapped browser keys keep their existing key-only dispatch', async () => {
  const calls: Array<Record<string, unknown>> = [];
  const session = {
    async call(_method: string, params: Record<string, unknown>) {
      calls.push(params);
    },
  } as unknown as CdpSession;
  await new CdpWebPage(session).keyPress('MediaPlayPause');
  assert.deepEqual(calls, [
    { type: 'keyDown', key: 'MediaPlayPause' },
    { type: 'keyUp', key: 'MediaPlayPause' },
  ]);
});
