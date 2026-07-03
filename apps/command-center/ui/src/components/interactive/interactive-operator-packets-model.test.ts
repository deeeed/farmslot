import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  collectInteractivePacketArtifacts,
  interactivePacketActionRequest,
} from './interactive-operator-packets-model.js';

test('interactive packet action model accepts only complete v1 actions', () => {
  assert.deepEqual(
    interactivePacketActionRequest({
      id: 'send',
      label: 'Send',
      kind: 'terminal.send',
      safety: 'operator-confirmed',
      payload: { text: 'Proceed.' },
    }),
    { kind: 'terminal.send', text: 'Proceed.' },
  );
  assert.deepEqual(
    interactivePacketActionRequest({
      id: 'resolve',
      label: 'Resolve',
      kind: 'decision.resolve',
      safety: 'operator-confirmed',
      payload: { decisionId: 'd1', actionId: 'approve' },
    }),
    { kind: 'decision.resolve', decisionId: 'd1', actionId: 'approve' },
  );
  assert.equal(
    interactivePacketActionRequest({
      id: 'bad',
      label: 'Bad',
      kind: 'terminal.send',
      safety: 'operator-confirmed',
      payload: {},
    }),
    null,
  );
});

test('interactive packet artifact model filters packet artifacts', () => {
  assert.deepEqual(
    collectInteractivePacketArtifacts([
      { path: 'artifacts/report.md', purpose: 'report' },
      { path: 'artifacts/interactive/review.packet.json', purpose: 'json' },
    ]).map((artifact) => artifact.path),
    ['artifacts/interactive/review.packet.json'],
  );
});
