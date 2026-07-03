import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  INTERACTIVE_OPERATOR_PACKET_SCHEMA_V1,
  interactiveOperatorPacketActionRequest,
  interactiveOperatorPacketArtifacts,
  isInteractiveOperatorPacket,
  isInteractiveOperatorPacketArtifact,
  validateInteractiveOperatorPacket,
} from '../../src/index.js';

test('interactive operator packet validator accepts the v1 shape', () => {
  const packet = {
    schema: INTERACTIVE_OPERATOR_PACKET_SCHEMA_V1,
    id: 'review-plan-1',
    title: 'Review plan',
    intent: 'plan',
    summary: 'Confirm the narrow implementation scope.',
    body: { format: 'markdown', text: '## Plan\n\nShip a thin slice.' },
    anchors: [{ id: 'diff', label: 'Diff', artifactPath: 'artifacts/diff.txt', line: 4 }],
    actions: [
      {
        id: 'approve',
        label: 'Approve',
        kind: 'terminal.send',
        safety: 'operator-confirmed',
        payload: { text: 'Approved packet review-plan-1.' },
      },
    ],
    createdAt: '2026-07-03T00:00:00.000Z',
  };

  const result = validateInteractiveOperatorPacket(packet);
  assert.equal(result.ok, true);
  assert.equal(isInteractiveOperatorPacket(packet), true);
});

test('interactive operator packet validator reports clear invalid fields', () => {
  const result = validateInteractiveOperatorPacket({
    schema: 'wrong',
    id: '',
    title: 'Broken packet',
    intent: 'html-app',
    body: { format: 'html' },
    actions: [{ id: 'run', label: 'Run shell', kind: 'shell.exec', safety: 'hidden' }],
    createdAt: '',
  });

  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /schema must be/);
  assert.match(result.errors.join('\n'), /intent is unsupported/);
  assert.match(result.errors.join('\n'), /body\.format/);
  assert.match(result.errors.join('\n'), /actions\[0\]\.kind/);
});

test('interactive operator packet validator rejects duplicate anchor and action ids', () => {
  const result = validateInteractiveOperatorPacket({
    schema: INTERACTIVE_OPERATOR_PACKET_SCHEMA_V1,
    id: 'duplicates',
    title: 'Duplicate ids',
    intent: 'review',
    body: { format: 'markdown', text: 'Check duplicate ids.' },
    anchors: [
      { id: 'diff', label: 'Diff A' },
      { id: 'diff', label: 'Diff B' },
    ],
    actions: [
      {
        id: 'send',
        label: 'Send A',
        kind: 'copy',
        safety: 'read-only',
        payload: { text: 'A' },
      },
      {
        id: 'send',
        label: 'Send B',
        kind: 'copy',
        safety: 'read-only',
        payload: { text: 'B' },
      },
    ],
    createdAt: '2026-07-03T00:00:00.000Z',
  });

  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /anchors\[1\]\.id must be unique/);
  assert.match(result.errors.join('\n'), /actions\[1\]\.id must be unique/);
});

test('interactive operator packet validator trims strings and rejects incomplete action payloads', () => {
  const result = validateInteractiveOperatorPacket({
    schema: INTERACTIVE_OPERATOR_PACKET_SCHEMA_V1,
    id: 'trim-payloads',
    title: 'Trim payloads',
    intent: 'review',
    body: { format: 'markdown', text: 'Check action payloads.' },
    anchors: [
      { id: ' diff ', label: 'Diff A' },
      { id: 'diff', label: 'Diff B' },
    ],
    actions: [
      {
        id: 'copy',
        label: 'Copy',
        kind: 'copy',
        safety: 'read-only',
        payload: { text: 42 },
      },
      {
        id: 'resolve',
        label: 'Resolve',
        kind: 'decision.resolve',
        safety: 'operator-confirmed',
        payload: { decisionId: 'd1' },
      },
    ],
    createdAt: '2026-07-03T00:00:00.000Z',
  });

  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /anchors\[1\]\.id must be unique/);
  assert.match(result.errors.join('\n'), /actions\[0\]\.payload\.text/);
  assert.match(result.errors.join('\n'), /actions\[1\]\.payload\.actionId/);
});

test('interactive packet artifacts are selected by path or explicit metadata', () => {
  assert.equal(
    isInteractiveOperatorPacketArtifact({
      path: 'artifacts/interactive/review.packet.json',
      purpose: 'json',
    }),
    true,
  );
  assert.equal(
    isInteractiveOperatorPacketArtifact({
      path: 'artifacts/notes.json',
      purpose: 'interactive-packet',
    }),
    true,
  );
  assert.deepEqual(
    interactiveOperatorPacketArtifacts([
      { path: 'artifacts/report.md', purpose: 'report' },
      { path: 'artifacts/review.packet.json', purpose: 'json' },
    ]).map((artifact) => artifact.path),
    ['artifacts/review.packet.json'],
  );
});

test('interactive packet action requests require complete payloads', () => {
  assert.deepEqual(
    interactiveOperatorPacketActionRequest({
      id: 'send',
      label: 'Send',
      kind: 'terminal.send',
      safety: 'operator-confirmed',
      payload: { text: 'Proceed.' },
    }),
    { kind: 'terminal.send', text: 'Proceed.' },
  );
  assert.deepEqual(
    interactiveOperatorPacketActionRequest({
      id: 'resolve',
      label: 'Resolve',
      kind: 'decision.resolve',
      safety: 'operator-confirmed',
      payload: { decisionId: 'd1', actionId: 'approve' },
    }),
    { kind: 'decision.resolve', decisionId: 'd1', actionId: 'approve' },
  );
  assert.equal(
    interactiveOperatorPacketActionRequest({
      id: 'bad',
      label: 'Bad',
      kind: 'open-artifact',
      safety: 'read-only',
      payload: {},
    }),
    null,
  );
});
