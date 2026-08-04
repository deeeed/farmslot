import assert from 'node:assert/strict';
import test from 'node:test';

import {
  filtersHash,
  parseFiltersFromHash,
  parseRunsHashState,
  runsHashWithState,
} from './state-url-state.js';

test('global filters parse and update existing hash params without dropping view params', () => {
  assert.deepEqual(parseFiltersFromHash('#runs?projects=cc,ui&machines=mac%20mini&family=fam-1'), {
    projects: ['cc', 'ui'],
    machines: ['mac mini'],
  });

  assert.equal(
    filtersHash({ projects: ['gateway'], machines: [] }, '#runs?family=fam-1&machines=old'),
    '#runs?family=fam-1&projects=gateway',
  );
});

test('runs hash state only applies on runs routes and preserves unrelated params', () => {
  assert.deepEqual(parseRunsHashState('#runs?run=run-1&tab=history&status=failed&projects=cc'), {
    run: 'run-1',
    tab: 'history',
    status: 'failed',
  });
  assert.deepEqual(parseRunsHashState('#slot/demo?tab=history'), {});

  assert.equal(
    runsHashWithState(
      { run: 'run-1', tab: 'all', status: '', family: 'fam-2' },
      '#runs?projects=cc&status=done',
    ),
    '#runs?projects=cc&run=run-1&tab=all&family=fam-2',
  );
  assert.equal(runsHashWithState({ tab: 'all' }, '#slot/demo'), null);
});
