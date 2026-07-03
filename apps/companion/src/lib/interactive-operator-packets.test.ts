import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Run } from '@farmslot/protocol';

import {
  collectRunInteractivePacketArtifacts,
  interactivePacketActionRequest,
  interactivePacketArtifactKey,
  interactivePacketArtifactOpenUrl,
} from './interactive-operator-packets';

test('interactive packet action request accepts complete terminal actions', () => {
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
  assert.equal(
    interactivePacketActionRequest({
      id: 'bad',
      label: 'Bad',
      kind: 'decision.resolve',
      safety: 'operator-confirmed',
      payload: { decisionId: 'd1' },
    }),
    null,
  );
});

test('interactive packet artifacts are collected from run outputs', () => {
  const run: Run = {
    id: 'run-1',
    familyId: 'run-1',
    lane: 'production',
    flowType: 'dev',
    status: 'done',
    project: 'test',
    ticketOrPr: 'TEST-1',
    slotId: null,
    branch: null,
    taskFile: null,
    decisions: [],
    metrics: { nudgeCount: 0, model: null, runner: null },
    createdAt: '2026-07-03T00:00:00.000Z',
    updatedAt: '2026-07-03T00:00:00.000Z',
    steps: [
      {
        name: 'review',
        status: 'done',
        outputs: {
          artifacts: [
            { path: 'artifacts/report.md', purpose: 'report' },
            { path: 'artifacts/review.packet.json', purpose: 'json' },
          ],
        },
      },
    ],
  };

  assert.deepEqual(
    collectRunInteractivePacketArtifacts(run).map((artifact) => artifact.path),
    ['artifacts/review.packet.json'],
  );
});

test('interactive packet artifact key is stable for equivalent run updates', () => {
  const first = interactivePacketArtifactKey([
    { path: 'artifacts/review.packet.json', purpose: 'json', type: 'interactive-packet' },
  ]);
  const second = interactivePacketArtifactKey([
    { path: 'artifacts/review.packet.json', purpose: 'json', type: 'interactive-packet' },
  ]);
  const changed = interactivePacketArtifactKey([
    { path: 'artifacts/review.packet.json', purpose: 'json', type: 'interactive-packet' },
    { path: 'artifacts/decision.packet.json', purpose: 'json', type: 'interactive-packet' },
  ]);

  assert.equal(first, second);
  assert.notEqual(first, changed);
});

test('interactive packet artifact open URL carries gateway auth for headerless links', () => {
  assert.equal(
    interactivePacketArtifactOpenUrl('wss://gateway.example/ws', 'run-1', 'artifacts/report.md', {
      Authorization: 'Bearer dev token',
    }),
    'https://gateway.example/api/run-artifact?runId=run-1&path=artifacts%2Freport.md&token=dev%20token',
  );
});
