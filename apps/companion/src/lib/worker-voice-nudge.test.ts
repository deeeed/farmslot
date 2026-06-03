import assert from 'node:assert/strict';
import test from 'node:test';

import type { TmuxWorkerRef } from '@farmslot/protocol';

import { buildWorkerVoiceFormatRequest, workerVoiceInstructionInput } from './worker-voice-nudge';

const worker: TmuxWorkerRef = {
  nodeId: 'runner-local',
  session: 'omx',
  window: '1',
  pane: '2',
  target: 'omx:1.2',
};

test('buildWorkerVoiceFormatRequest targets the selected worker and caps terminal tail', () => {
  const tail = Array.from({ length: 25 }, (_, index) => `line ${index}`);

  assert.deepEqual(
    buildWorkerVoiceFormatRequest({ transcript: ' continue ', worker, terminalTail: tail }),
    {
      transcript: 'continue',
      worker,
      terminalTail: tail.slice(-20),
    },
  );
});

test('workerVoiceInstructionInput sends reviewed text with enter only when non-empty', () => {
  assert.equal(workerVoiceInstructionInput(' summarize status '), 'summarize status\r');
  assert.equal(workerVoiceInstructionInput('   '), '');
});
