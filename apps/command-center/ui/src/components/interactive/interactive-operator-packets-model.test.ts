import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  collectInteractivePacketArtifacts,
  interactivePacketActionRequest,
  interactivePacketArtifactKey,
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

test('interactive packet artifact key is stable for equivalent render arrays', () => {
  const first = interactivePacketArtifactKey([
    {
      path: 'artifacts/interactive/review.packet.json',
      purpose: 'json',
      type: 'interactive-packet',
      sizeBytes: 128,
    },
  ]);
  const second = interactivePacketArtifactKey([
    {
      path: 'artifacts/interactive/review.packet.json',
      purpose: 'json',
      type: 'interactive-packet',
      sizeBytes: 128,
    },
  ]);
  const changed = interactivePacketArtifactKey([
    {
      path: 'artifacts/interactive/review.packet.json',
      purpose: 'json',
      type: 'interactive-packet',
      sizeBytes: 129,
    },
  ]);

  assert.equal(first, second);
  assert.notEqual(first, changed);
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
