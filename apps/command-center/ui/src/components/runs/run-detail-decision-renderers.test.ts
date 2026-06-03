import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { decisionActionHelp } from './run-detail-decision-renderers.js';

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
