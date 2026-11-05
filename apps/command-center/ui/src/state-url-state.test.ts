import assert from 'node:assert/strict';
import test from 'node:test';

import { runDetailArtifactBrowserHash } from './components/runs/run-detail-url-state.js';
import {
  filtersHash,
  parseFiltersFromHash,
  parseRunsHashState,
  runsHashWithState,
  writeRunsHashState,
} from './state-url-state.js';

test('F414 selecting and closing a run retain shell choices while clearing detail state', (t) => {
  const old = new Map(
    ['location', 'history'].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
  );
  const location = {
    hash: '#runs?run=old&panels=sidebar,monitor-details&sidebarWidth=320&file=old.ts',
  };
  const current = () => new URLSearchParams(location.hash.split('?')[1]);
  const modes: string[] = [];
  Object.defineProperty(globalThis, 'location', { configurable: true, value: location });
  Object.defineProperty(globalThis, 'history', {
    configurable: true,
    value: {
      pushState(_state: unknown, _title: string, hash: string) {
        modes.push('push');
        location.hash = hash;
      },
      replaceState(_state: unknown, _title: string, hash: string) {
        modes.push('replace');
        location.hash = hash;
      },
    },
  });
  t.after(() => {
    for (const [key, descriptor] of old) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  });
  writeRunsHashState({ run: 'next' }, 'push');
  assert.equal(current().get('run'), 'next');
  assert.equal(current().get('panels'), 'sidebar');
  assert.equal(current().get('file'), null);
  writeRunsHashState({}, 'replace');
  assert.equal(current().get('run'), null);
  assert.equal(current().get('panels'), 'sidebar');
  assert.equal(current().get('sidebarWidth'), '320');
  assert.deepEqual(modes, ['push', 'replace']);
});

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
  assert.deepEqual(
    parseRunsHashState('#runs?run=run-1&runsTab=history&tab=pr-preview&status=failed&projects=cc'),
    {
      run: 'run-1',
      tab: 'history',
      status: 'failed',
    },
  );
  assert.deepEqual(parseRunsHashState('#slot/demo?tab=history'), {});

  assert.equal(
    runsHashWithState(
      { run: 'run-1', tab: 'all', status: '', family: 'fam-2' },
      '#runs?projects=cc&status=done',
    ),
    '#runs?projects=cc&run=run-1&family=fam-2&runsTab=all',
  );
  assert.equal(runsHashWithState({ tab: 'all' }, '#slot/demo'), null);
});

test('changing the selected run clears detail-only step and artifact state', () => {
  assert.equal(
    runsHashWithState(
      { run: '', tab: 'all' },
      '#runs?run=run-1&runsTab=all&tab=pr-preview&file=report.md&step=ci-pass&artifactRun=run-1&artifact=report.md&projects=cc',
    ),
    '#runs?runsTab=all&projects=cc',
  );
  assert.equal(
    runsHashWithState({ run: 'run-2' }, '#runs?run=run-1&step=monitor&projects=cc'),
    '#runs?run=run-2&projects=cc',
  );
});

test('explicit empty shared filters override a browser’s previously saved selection', () => {
  assert.deepEqual(parseFiltersFromHash('#runs?projects=&machines=&runsTab=all'), {
    projects: [],
    machines: [],
  });
});

test('default filters stay out of the URL and restore empty on reload', () => {
  const hash = filtersHash({ projects: [], machines: [] }, '#runs?projects=&machines=&runsTab=all');
  assert.equal(hash, '#runs?runsTab=all');
  assert.equal(parseFiltersFromHash(hash), null);
  assert.equal(filtersHash({ projects: [], machines: [] }, '#fleet'), '#fleet');
});

test('changing embedded runs or returning to the list clears artifact browser choices', () => {
  const hash = runDetailArtifactBrowserHash(
    'run-1',
    {
      query: 'report',
      types: new Set(['markdown']),
      path: 'artifacts/report.md',
      preview: false,
    },
    '#runs?run=run-1&projects=cc',
  );
  assert.equal(runsHashWithState({ run: 'run-2' }, hash), '#runs?run=run-2&projects=cc');
  assert.equal(runsHashWithState({ run: '', tab: 'all' }, hash), '#runs?projects=cc&runsTab=all');
});
