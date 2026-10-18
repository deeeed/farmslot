import assert from 'node:assert/strict';
import test from 'node:test';

import type { ResultDecisionPayload, RunDecision } from '@farmslot/protocol';

import {
  evidenceOnlyDecisionIds,
  isResultDecision,
  pendingResultDecision,
  type ResultDecision,
  resultDecisionActionReady,
  resultDecisionView,
} from '../src/index.js';

function decision(payload: Partial<ResultDecisionPayload> = {}): ResultDecision {
  return {
    id: 'result-1',
    type: 'engine_result_decision',
    title: 'Needs decision',
    description: '',
    createdAt: '2026-10-18T10:00:00.000Z',
    actions: [],
    payload: {
      kind: 'result-decision',
      stoppedAt: 'review',
      reason: 'The review left 2 findings and no further fix can run.',
      findings: [
        { file: 'src/order.ts', line: 42, description: 'Cross is offered on a noCross market.' },
        { file: 'README.md', description: 'Docs still describe Isolated only.' },
      ],
      delivered: { headSha: '0123456789abcdef0123', branch: 'feat/tat-4145' },
      findingsDigest: 'sha256:f',
      outputReviewDecisionId: 'output-1',
      actions: [
        { id: 'close-result', available: true, requiresReason: false },
        {
          id: 'send-back',
          available: false,
          unavailableReason: 'Review budget spent. An admin can grant a round.',
          requiresReason: false,
        },
        { id: 'accept-result', available: true, requiresReason: true },
      ],
      ...payload,
    },
  };
}

const outputReview: RunDecision = {
  id: 'output-1',
  type: 'engine_output_review',
  title: 'Review run output',
  description: '',
  createdAt: '2026-10-18T09:00:00.000Z',
  actions: [],
  payload: { kind: 'output-review', manifestDigest: 'sha256:m', reportPath: 'artifacts/report.md' },
};

test('the result decision is found before an older pending output review', () => {
  const result = decision();
  assert.equal(pendingResultDecision({ decisions: [outputReview, result] }), result);
  assert.equal(pendingResultDecision({ decisions: [outputReview] }), undefined);
  assert.equal(
    pendingResultDecision({ decisions: [{ ...result, resolvedAt: '2026-10-18T11:00:00Z' }] }),
    undefined,
  );
});

test('lists skip the held output review and send the result decision to its run', () => {
  const result = decision();
  assert.deepEqual([...evidenceOnlyDecisionIds([outputReview, result])], ['output-1']);
  assert.deepEqual(
    [...evidenceOnlyDecisionIds([{ ...result, resolvedAt: '2026-10-18T11:00:00Z' }])],
    [],
  );
  assert.equal(isResultDecision(result), true);
  assert.equal(isResultDecision(outputReview), false);
});

test('review findings, the delivered head and the actions in one fixed order', () => {
  const view = resultDecisionView(decision());
  assert.equal(view.reason, 'The review left 2 findings and no further fix can run.');
  assert.deepEqual(view.detail, {
    title: 'Findings (2)',
    items: [
      { location: 'src/order.ts:42', description: 'Cross is offered on a noCross market.' },
      { location: 'README.md', description: 'Docs still describe Isolated only.' },
    ],
  });
  assert.deepEqual(view.delivered, {
    label: 'Delivered head',
    value: '0123456789ab · feat/tat-4145',
  });
  assert.equal(view.outputReviewDecisionId, 'output-1');
  assert.deepEqual(
    view.actions.map(({ id, label, available }) => [id, label, available]),
    [
      ['send-back', 'Send back for another fix', false],
      ['accept-result', 'Accept', true],
      ['close-result', 'Close', true],
    ],
  );
  assert.equal(
    view.actions[0]?.unavailableReason,
    'Review budget spent. An admin can grant a round.',
  );
  assert.equal(view.actions[1]?.note, 'Settles the run as done. Publishes nothing.');
  assert.equal(view.actions[2]?.note, undefined);
});

test('a refused completion shows the refused prerequisite and the delivered report', () => {
  const view = resultDecisionView(
    decision({
      stoppedAt: 'complete',
      reason: 'Completion refused: a declared check did not pass.',
      findings: undefined,
      refusal: {
        message: 'Deterministic checks did not pass.',
        reasons: [
          {
            code: 'check-failed',
            prerequisite: 'deterministic',
            message: 'yarn lint exited 1.',
            reference: 'checks/lint',
          },
          { code: 'missing', prerequisite: 'evidence', message: 'No report.' },
        ],
      },
      delivered: { reportPath: 'artifacts/report.md', manifestDigest: 'sha256:m' },
      actions: [{ id: 'close-result', available: true, requiresReason: false }],
    }),
  );
  assert.deepEqual(view.detail, {
    title: 'Refused prerequisites (2)',
    items: [
      { location: 'checks/lint', description: 'yarn lint exited 1.' },
      { description: 'No report.' },
    ],
  });
  assert.deepEqual(view.delivered, { label: 'Delivered report', value: 'artifacts/report.md' });
  assert.deepEqual(
    view.actions.map((action) => action.id),
    ['close-result'],
  );
});

test('a refusal with no listed reasons shows its message only when the reason does not already say it', () => {
  const refused = (message: string) =>
    resultDecisionView(
      decision({
        stoppedAt: 'complete',
        reason: 'Completion refused.',
        findings: undefined,
        refusal: { message, reasons: [] },
        delivered: { reportPath: 'artifacts/report.md', manifestDigest: 'sha256:m' },
      }),
    ).detail;
  assert.equal(refused('Completion refused.'), null);
  assert.deepEqual(refused('The deterministic check has no receipt.'), {
    title: 'Refused prerequisite',
    items: [{ description: 'The deterministic check has no receipt.' }],
  });
});

test('an action is ready only when available and given the reason it requires', () => {
  const [sendBack, accept, close] = resultDecisionView(decision()).actions;
  assert.equal(resultDecisionActionReady(sendBack!, 'anything'), false);
  assert.equal(resultDecisionActionReady(accept!, '   '), false);
  assert.equal(resultDecisionActionReady(accept!, 'Known findings on a comparison lane.'), true);
  assert.equal(resultDecisionActionReady(close!, ''), true);
});
