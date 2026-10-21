import assert from 'node:assert/strict';
import test from 'node:test';

import type { RunGateReadiness } from '@farmslot/protocol';

import { litText } from '../../testing/lit-text.js';

import { renderPublicationGatePanel } from './publication-gate-panel.js';

test('a gate with checked review findings asks for a reason before accepting and publishing them', () => {
  const readiness: RunGateReadiness = {
    state: 'not-ready',
    identity: { runId: 'run', generation: 1 },
    reasons: [
      {
        code: 'review-fix-required',
        prerequisite: 'review',
        message: 'Review rounds spent: 1 issue open',
        allowedReviewOverrides: ['approve-publish-unresolved'],
      },
    ],
    findings: [{ reviewId: 'review', file: 'src/a.ts', line: 3, description: 'Owner decision' }],
    findingsDigest: 'sha256:findings',
  };
  const input: Parameters<typeof renderPublicationGatePanel>[0] = {
    actions: [
      {
        id: 'approve-publish-unresolved',
        label: 'Accept Review Findings and Publish',
        style: 'danger',
      },
      { id: 'hold', label: 'Hold', style: 'secondary' },
    ],
    readiness,
    busy: false,
    pendingConfirm: null,
    reviewDisabled: false,
    changeReason: () => undefined,
    chooseAttestation: () => undefined,
    chooseAcceptFindings: () => undefined,
    invoke: () => undefined,
    requestReview: () => undefined,
  };
  const offered = litText(renderPublicationGatePanel(input));
  assert.match(offered, /gate-accept-findings/);
  assert.doesNotMatch(offered, /accept-findings-reason/);
  const accepting = litText(renderPublicationGatePanel({ ...input, acceptingFindings: true }));
  assert.match(accepting, /src\/a\.ts:3/);
  assert.match(accepting, /Owner decision/);
  assert.match(accepting, /accept-findings-reason/);
  assert.match(accepting, /Enter a reason before accepting the findings\./);
  const reasoned = litText(
    renderPublicationGatePanel({
      ...input,
      acceptingFindings: true,
      attestationReason: 'The owner accepts it.',
    }),
  );
  assert.match(reasoned, /Publishing accepts the open review findings\./);
  assert.match(reasoned, /Accept Review Findings and Publish/);
});

test('review and feedback are visible primary actions; inline blockers suppress the repeated footer', () => {
  const input: Parameters<typeof renderPublicationGatePanel>[0] = {
    actions: [
      { id: 'request-review', label: 'Request review', style: 'primary' },
      { id: 'send-feedback', label: 'Send back to agent', style: 'primary' },
      { id: 'hold', label: 'Hold', style: 'secondary' },
    ],
    readiness: {
      state: 'not-ready',
      identity: { runId: 'run', generation: 1 },
      reasons: [
        {
          code: 'review-result-required',
          prerequisite: 'review',
          message: 'Current-head review required.',
        },
      ],
    },
    busy: false,
    pendingConfirm: null,
    reviewDisabled: false,
    changeReason: () => undefined,
    chooseAttestation: () => undefined,
    chooseAcceptFindings: () => undefined,
    invoke: () => undefined,
    requestReview: () => undefined,
  };
  const panel = litText(renderPublicationGatePanel(input));
  const more = panel.indexOf('<details class="gate-more-actions"');
  assert.ok(more > panel.indexOf('Request review'));
  assert.ok(more > panel.indexOf('Send back to agent'));
  const inline = litText(renderPublicationGatePanel({ ...input, inlineBlockers: true }));
  assert.doesNotMatch(inline, /Current-head review required|Request review/);
  assert.match(inline, /Send back to agent/);
});
