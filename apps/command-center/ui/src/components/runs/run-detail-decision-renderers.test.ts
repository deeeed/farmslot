import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import {
  decisionActionHelp,
  publicationGateWaitingTitle,
} from './run-detail-decision-renderers.js';

test('publication gate title names review issues instead of worker finished', () => {
  assert.equal(
    publicationGateWaitingTitle({
      actions: [{ id: 'continue-review-fix', label: 'Continue Fixing', style: 'primary' }],
    }),
    'Independent review found issues',
  );
  assert.equal(
    publicationGateWaitingTitle({
      actions: [{ id: 'approve-publish', label: 'Approve', style: 'primary' }],
    }),
    'Worker finished — verify before marking ready',
  );
});

test('decisionActionHelp prefers persisted descriptions over fallback copy', () => {
  assert.equal(
    decisionActionHelp('engine_collision', { id: 'abort', description: 'Gateway copy' }),
    'Gateway copy',
  );
});

test('decisionActionHelp falls back for legacy collision decisions only', () => {
  assert.match(
    decisionActionHelp('engine_collision', { id: 'abort' }),
    /Cancels the current dispatch/,
  );
  assert.equal(decisionActionHelp('engine_collision', { id: 'unknown' }), '');
  assert.equal(decisionActionHelp(undefined, { id: 'abort' }), '');
});
