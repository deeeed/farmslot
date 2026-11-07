import assert from 'node:assert/strict';
import test from 'node:test';

import { canonicalAgentContextTarget, parseCapturedAgentPaneTarget } from './role-target.js';

test('dispatch refuses to record the dev-server log pane as its worker', () => {
  assert.throws(
    () => parseCapturedAgentPaneTarget('mmt-3', 'mmt-3:2.1|devserver-log|%250'),
    /devserver-log.*worker/,
  );
});

test('a persisted dev-server log pane cannot be adopted for worker input', () => {
  assert.throws(
    () =>
      canonicalAgentContextTarget({
        session: 'mmt-3',
        window: 'devserver-log',
        paneId: '%250',
        target: 'mmt-3:devserver-log',
      }),
    /devserver-log.*worker/,
  );
});

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
