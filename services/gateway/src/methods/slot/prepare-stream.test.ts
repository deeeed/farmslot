import assert from 'node:assert/strict';
import test from 'node:test';

import { createPrepareStream } from './prepare-stream.js';

interface Frame {
  event: string;
  payload: { data?: unknown; name?: unknown };
}

function collect(): { emit: (event: string, payload: unknown) => void; frames: Frame[] } {
  const frames: Frame[] = [];
  return {
    frames,
    emit: (event, payload) => frames.push({ event, payload: payload as Frame['payload'] }),
  };
}

test('output() streams raw bytes so mid-line chunks are not fragmented', () => {
  const { emit, frames } = collect();
  const stream = createPrepareStream(emit, { slotId: 'core-1', requestId: 'req-1', startTime: 0 });

  stream.output('stdout', 'Fetching packages... ');
  stream.complete(0);

  const scriptOut = frames.filter((f) => f.event === 'script.output');
  const prepareOut = frames.filter((f) => f.event === 'slot.prepare.output');
  assert.equal(scriptOut.length, 1);
  assert.equal(scriptOut[0].payload.data, 'Fetching packages... ');
  assert.equal(prepareOut.length, 1);
  assert.equal(prepareOut[0].payload.data, 'Fetching packages... ');
});

test('step() emits a newline-terminated line on script.output plus structured metadata', () => {
  const { emit, frames } = collect();
  const stream = createPrepareStream(emit, { slotId: 'core-2', requestId: 'req-2', startTime: 0 });

  stream.step('connect', 'Local slot on macwork');
  stream.complete(0);

  const scriptOut = frames.find((f) => f.event === 'script.output');
  assert.equal(scriptOut?.payload.data, '[connect] Local slot on macwork\n');
  const stepFrame = frames.find((f) => f.event === 'slot.prepare.step');
  assert.equal(stepFrame?.payload.name, 'connect');
});
