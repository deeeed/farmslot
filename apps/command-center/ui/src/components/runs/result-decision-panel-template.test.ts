import assert from 'node:assert/strict';
import test from 'node:test';

import { type ResultDecisionActionView, resultDecisionView } from '@farmslot/review-dispatch';

import { litBindings, litText } from '../../testing/lit-text.js';

import {
  renderResultDecisionPanel,
  type ResultDecisionPanelInput,
} from './result-decision-panel-template.js';

const view = resultDecisionView({
  id: 'result-1',
  payload: {
    kind: 'result-decision',
    stoppedAt: 'review',
    reason: 'The review left 1 finding and the review budget is spent.',
    findings: [{ file: 'src/order.ts', line: 42, description: 'Cross offered on noCross.' }],
    delivered: { headSha: '0123456789abcdef', branch: 'feat/tat-4145' },
    findingsDigest: 'sha256:f',
    actions: [
      {
        id: 'send-back',
        available: false,
        unavailableReason: 'Review budget spent. An admin can grant a round.',
        requiresReason: false,
      },
      { id: 'accept-result', available: true, requiresReason: true },
      { id: 'close-result', available: true, requiresReason: false },
    ],
  },
});

function panel(overrides: Partial<ResultDecisionPanelInput> = {}) {
  const sent: ResultDecisionActionView['id'][] = [];
  const result = renderResultDecisionPanel({
    view,
    reason: '',
    blocked: false,
    blockedReason: null,
    confirming: null,
    onReason: () => undefined,
    onAction: (action) => sent.push(action.id),
    ...overrides,
  });
  return { result, sent, disabled: litBindings(result, '?disabled=') as boolean[] };
}

test('the panel shows why the run stopped, what it delivered and its findings', () => {
  const text = litText(panel().result);
  assert.match(text, /The review left 1 finding and the review budget is spent\./);
  assert.match(text, /Delivered head <code>0123456789ab · feat\/tat-4145<\/code>/);
  assert.match(text, /<summary>Findings \(1\)<\/summary>/);
  assert.match(text, /<code>src\/order\.ts:42<\/code> Cross offered on noCross\./);
});

test('an unavailable action stays visible, disabled, with its reason', () => {
  const { result, disabled } = panel({ reason: 'anything' });
  const text = litText(result);
  assert.match(text, /Send back for another fix/);
  assert.match(text, /Review budget spent\. An admin can grant a round\./);
  assert.deepEqual(disabled, [true, false, false]);
});

test('Accept needs a written reason and publishes nothing', () => {
  assert.deepEqual(panel({ reason: '   ' }).disabled, [true, true, false]);
  const { result, disabled, sent } = panel({ reason: 'Comparison lane, findings tracked.' });
  assert.deepEqual(disabled, [true, false, false]);
  assert.match(litText(result), /Settles the run as done\. Publishes nothing\./);
  const clicks = litBindings(result, '@click=') as Array<() => void>;
  clicks[1]!();
  clicks[2]!();
  assert.deepEqual(sent, ['accept-result', 'close-result']);
});

test('a blocked panel sends nothing and names a posture block', () => {
  assert.deepEqual(panel({ blocked: true, reason: 'ok' }).disabled, [true, true, true]);
  const posture = panel({ blockedReason: 'Choose what happens to the slot first.', reason: 'ok' });
  assert.deepEqual(posture.disabled, [true, true, true]);
  assert.match(litText(posture.result), /Choose what happens to the slot first\./);
});

test('a confirming action asks for its second click', () => {
  assert.match(litText(panel({ confirming: 'close-result' }).result), /Confirm Close\?/);
});
