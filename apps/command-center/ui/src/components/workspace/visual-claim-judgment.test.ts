import assert from 'node:assert/strict';
import test from 'node:test';

import type { EvidenceReviewJudgmentRow } from '@farmslot/adapter-sdk/evidence';

import { litBinding, litText } from '../../testing/lit-text.js';

import {
  renderVisualClaimJudgment,
  type VisualClaimJudgmentInput,
} from './visual-claim-judgment.js';
const row: EvidenceReviewJudgmentRow = {
  claim: {
    requiresPersonReview: false,
    id: 'AC-1',
    text: 'Order price is visible',
    status: {
      id: 'AC-1',
      text: 'Order price is visible',
      verdict: 'awaiting-review',
      proofMode: 'visual',
      evidence: [],
      recipeNodes: [],
    },
    kind: 'acceptance',
    proofKinds: [],
    reviewLabels: [],
    caption: '',
    evidence: [],
    moments: [],
    clips: [],
    occurrences: [],
  },
  pending: true,
  reviewKind: 'person-reviewed',
  prevalidation: null,
  media: { selected: [], raw: [], clip: null },
};
const input: VisualClaimJudgmentInput = {
  row,
  reason: '',
  changeReason: () => {},
  record: () => {},
};
test('checking and refresh feedback stay on the triggered criterion', () => {
  const checking = litText(
    renderVisualClaimJudgment({
      ...input,
      busy: true,
      feedback: { claimId: 'AC-1', phase: 'saving' },
    }),
  );
  assert.match(checking, /Checking…/);
  assert.equal(
    litBinding(
      renderVisualClaimJudgment({
        ...input,
        busy: true,
        feedback: { claimId: 'AC-1', phase: 'saving' },
      }),
      'aria-busy=',
    ),
    true,
  );
  assert.match(
    litText(
      renderVisualClaimJudgment({
        ...input,
        busy: true,
        feedback: { claimId: 'AC-1', phase: 'refreshing' },
      }),
    ),
    /Refreshing…/,
  );
  assert.doesNotMatch(
    litText(
      renderVisualClaimJudgment({ ...input, feedback: { claimId: 'AC-2', phase: 'saving' } }),
    ),
    /Checking…/,
  );
});
test('a refusal is inline and leaves retry controls available', () => {
  const text = litText(
    renderVisualClaimJudgment({
      ...input,
      feedback: { claimId: 'AC-1', phase: 'error', message: 'Judgment saved, refresh refused' },
    }),
  );
  assert.match(text, /role="alert"/);
  assert.match(text, /Judgment saved, refresh refused/);
  assert.match(text, /Looks right/);
});
test('a confirmed criterion collapses action controls behind Change without dropping them', () => {
  const text = litText(
    renderVisualClaimJudgment({
      ...input,
      row: { ...row, pending: false, claim: { ...row.claim, proofKinds: ['person-reviewed'] } },
    }),
  );
  assert.match(text, /<details class="gate-change">\s*<summary>Change<\/summary>/);
  assert.match(text, /Looks right/);
  assert.match(text, /Record issue/);
  assert.doesNotMatch(text, /Agent review.*Not recorded/);
});
