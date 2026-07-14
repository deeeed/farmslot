import assert from 'node:assert/strict';
import test from 'node:test';

import { buildFixtureSelectionVars } from './internal.js';

test('buildFixtureSelectionVars picks up an env var named by a non-standard compose.var', () => {
  // A project with `compose.var: "TARGET"` relies on bash `${!TARGET}` reach:
  // the exported TARGET must reach selection without a dedicated flag.
  const selectionVars = buildFixtureSelectionVars({
    env: { TARGET: 'alpha', UNRELATED: 'x' },
  });
  assert.equal(selectionVars.TARGET, 'alpha');
  assert.equal(selectionVars.UNRELATED, 'x');
});

test('buildFixtureSelectionVars lets an explicit flag override the env value', () => {
  const selectionVars = buildFixtureSelectionVars({
    env: { FLOW_TYPE: 'from-env', APP: 'env-app', DOMAIN: 'env-domain' },
    flowType: 'from-flag',
    app: 'flag-app',
    domain: 'flag-domain',
  });
  assert.equal(selectionVars.FLOW_TYPE, 'from-flag');
  assert.equal(selectionVars.APP, 'flag-app');
  assert.equal(selectionVars.DOMAIN, 'flag-domain');
});

test('buildFixtureSelectionVars keeps the env value when the matching flag is absent', () => {
  const selectionVars = buildFixtureSelectionVars({
    env: { FLOW_TYPE: 'from-env', APP: 'env-app' },
    // no flowType/app flags passed
    domain: 'flag-domain',
  });
  assert.equal(selectionVars.FLOW_TYPE, 'from-env');
  assert.equal(selectionVars.APP, 'env-app');
  assert.equal(selectionVars.DOMAIN, 'flag-domain');
});

test('buildFixtureSelectionVars defaults a custom slot to the custom variant only when unset', () => {
  assert.equal(buildFixtureSelectionVars({ env: {}, slotMode: 'custom' }).FLOW_TYPE, 'custom');
  // An env-supplied or flag FLOW_TYPE is not clobbered by the custom default.
  assert.equal(
    buildFixtureSelectionVars({ env: { FLOW_TYPE: 'fix-bug' }, slotMode: 'custom' }).FLOW_TYPE,
    'fix-bug',
  );
});
