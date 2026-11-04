import assert from 'node:assert/strict';
import test from 'node:test';

import { canonicalAgentContextTarget } from './role-target.js';

test('an exact pane id wins over the role window when routing input', () => {
  // Rediscovery proves which pane owns the session. A window can hold several
  // panes, so routing by `session:window` could reach a sibling.
  assert.equal(
    canonicalAgentContextTarget({
      session: 'ff-1',
      window: 'dev',
      pane: null,
      paneId: '%42',
      target: '%42',
    }),
    '%42',
  );
});

test('without a pane id the role window still beats a numeric target', () => {
  assert.equal(
    canonicalAgentContextTarget({ session: 'ff-1', window: 'dev', pane: null, target: 'ff-1:3' }),
    'ff-1:dev',
  );
  assert.equal(
    canonicalAgentContextTarget({ session: 'ff-1', window: '3', pane: null, target: 'ff-1:3' }),
    'ff-1:3',
  );
});

test('a malformed pane id is ignored rather than routed to', () => {
  assert.equal(
    canonicalAgentContextTarget({
      session: 'ff-1',
      window: 'dev',
      pane: null,
      paneId: 'not-a-pane',
      target: 'ff-1:dev',
    }),
    'ff-1:dev',
  );
});
