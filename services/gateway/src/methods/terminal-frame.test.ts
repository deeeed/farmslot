import assert from 'node:assert/strict';
import test from 'node:test';

import { WebSocket } from 'ws';

import { eventFrameText } from '../server/event-frame.js';

import {
  TERMINAL_BUFFER_LIMIT,
  TERMINAL_RESYNC_CLOSE,
  terminalDataPayload,
  withTerminalBackpressure,
} from './terminal-frame.js';

function socket(bufferedAmount: number): WebSocket {
  // ws exposes its accepted-server constructor at runtime but omits it from ClientOptions.
  const ws: WebSocket = Reflect.construct(WebSocket, [null, undefined, {}]);
  Object.defineProperty(ws, 'readyState', { value: WebSocket.OPEN });
  Object.defineProperty(ws, 'bufferedAmount', { value: bufferedAmount });
  return ws;
}

test('terminal data frames match per-viewer serialization and escape each chunk once', (t) => {
  const chunk = 'line "1"\r\n\u001b[32mgreen\u001b[0m\t\\ done';
  const identities = [
    {},
    { slotId: 'slot-1', runId: 'run "a"', role: 'worker' },
    { worker: { nodeId: 'node', session: 's', target: 's:1.0' } },
  ];
  const payloads = identities.map((identity) => terminalDataPayload(identity));
  const stringify = JSON.stringify;
  let chunkSerializations = 0;
  t.mock.method(JSON, 'stringify', (...args: Parameters<typeof JSON.stringify>) => {
    if (args[0] === chunk) chunkSerializations++;
    return stringify(...args);
  });
  const frames = payloads.map((payload, index) =>
    eventFrameText('terminal.data', payload(chunk, 1_000 + index), index + 1),
  );
  t.mock.restoreAll();
  assert.equal(chunkSerializations, 1, 'one escape of the chunk for every viewer');
  assert.deepEqual(
    frames,
    identities.map((identity, index) =>
      JSON.stringify({
        type: 'event',
        event: 'terminal.data',
        payload: { ...identity, data: chunk, timestamp: 1_000 + index },
        seq: index + 1,
      }),
    ),
  );
});

test('a terminal viewer over the buffer limit is closed for a resync instead of losing output', (t) => {
  const emitted: string[] = [];
  const emit = (event: string) => emitted.push(event);
  const full = socket(TERMINAL_BUFFER_LIMIT + 1);
  const close = t.mock.method(full, 'close', () => undefined);
  const guarded = withTerminalBackpressure(full, emit);
  guarded('terminal.data', {});
  guarded('terminal.data', {});
  assert.deepEqual(emitted, [], 'no data frame is queued behind a full buffer');
  assert.deepEqual(close.mock.calls[0]?.arguments, [
    TERMINAL_RESYNC_CLOSE.code,
    TERMINAL_RESYNC_CLOSE.reason,
  ]);
  guarded('terminal.mode', {});
  assert.deepEqual(emitted, ['terminal.mode'], 'only output is held back');

  const healthy = socket(TERMINAL_BUFFER_LIMIT);
  t.mock.method(healthy, 'close', () => assert.fail('a viewer at the limit keeps its socket'));
  withTerminalBackpressure(healthy, emit)('terminal.data', {});
  assert.deepEqual(emitted, ['terminal.mode', 'terminal.data']);
});
