import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildHash,
  getHashParam,
  hashRoute,
  hashSearch,
  navigateHash,
  parseHashRoute,
  prepareNavigationLink,
  readViewChoice,
  viewChoiceHash,
} from './url-state.js';

test('F414 repeated link activation derives inherited choices from the authored href', () => {
  const expanded = 'http://localhost:5175/#runs?panels=sidebar&sidebarWidth=320';
  const collapsed = 'http://localhost:5175/#runs?sidebarWidth=320';
  const first = prepareNavigationLink('#doctor', undefined, expanded);
  assert.ok(first);
  assert.equal(new URL(first.appliedHref).hash, '#doctor?panels=sidebar&sidebarWidth=320');
  const next = prepareNavigationLink(first.appliedHref, first, collapsed);
  assert.ok(next);
  assert.equal(new URL(next.appliedHref).hash, '#doctor?sidebarWidth=320');
  const explicit = prepareNavigationLink('#doctor?panels=sidebar', undefined, collapsed);
  assert.ok(explicit);
  assert.equal(new URL(explicit.appliedHref).hash, '#doctor?panels=sidebar&sidebarWidth=320');
  assert.equal(prepareNavigationLink(null, undefined, expanded), null);
  assert.equal(prepareNavigationLink('', undefined, expanded), null);
  assert.equal(prepareNavigationLink('https://example.com/#runs', undefined, expanded), null);
});

test('F414 navigation after an async action carries shell choices into the destination URL', async (t) => {
  const descriptors = new Map(
    ['location', 'history'].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
  );
  const location = { hash: '#dispatch?panels=sidebar&sidebarWidth=320&file=private-draft' };
  const currentHash = () => location.hash;
  const writes: string[] = [];
  Object.defineProperty(globalThis, 'location', { configurable: true, value: location });
  Object.defineProperty(globalThis, 'history', {
    configurable: true,
    value: {
      replaceState(_data: unknown, _title: string, hash: string) {
        writes.push(hash);
        location.hash = hash;
      },
      pushState(_data: unknown, _title: string, hash: string) {
        writes.push(hash);
        location.hash = hash;
      },
    },
  });
  t.after(() => {
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  });
  await Promise.resolve();
  navigateHash('run/new-run');
  assert.equal(currentHash(), '#run/new-run?panels=sidebar&sidebarWidth=320');
  navigateHash('#config/pool', 'replace');
  assert.equal(currentHash(), '#config/pool?panels=sidebar&sidebarWidth=320');
  const count = writes.length;
  navigateHash('#config/pool', 'push');
  assert.equal(
    writes.length,
    count,
    'inherited shell choices must not create redundant history entries',
  );
  navigateHash('#runs?panels=!sidebar', 'push');
  assert.equal(new URLSearchParams(currentHash().split('?')[1]).get('panels'), '!sidebar');
});

test('hash helpers parse route and query consistently', () => {
  const hash = '#slot/demo?file=src%2Findex.ts&resource=ios%20sim';

  assert.equal(hashRoute(hash), 'slot/demo');
  assert.equal(hashSearch(hash), 'file=src%2Findex.ts&resource=ios%20sim');
  assert.equal(getHashParam('file', hash), 'src/index.ts');
  assert.equal(getHashParam('resource', hash), 'ios sim');
});

test('parseHashRoute returns an isolated URLSearchParams object', () => {
  const parsed = parseHashRoute('#runs?family=abc');

  parsed.params.set('run', 'def');

  assert.equal(parsed.route, 'runs');
  assert.equal(buildHash(parsed.route, parsed.params), '#runs?family=abc&run=def');
});

test('context-configured view choices round-trip, omit defaults and preserve unrelated state', () => {
  const context = { route: 'doctor', param: 'slowest', defaultValue: 'closed' };
  const opened = viewChoiceHash(context, 'open', '#doctor?projects=demo');
  assert.equal(opened, '#doctor?projects=demo&slowest=open');
  assert.equal(readViewChoice(context, opened), 'open');
  const closed = viewChoiceHash(context, 'closed', opened);
  assert.equal(closed, '#doctor?projects=demo');
  assert.equal(readViewChoice(context, closed), 'closed');
  assert.equal(readViewChoice(context, '#runs?slowest=open'), 'closed');
  assert.equal(viewChoiceHash(context, 'open', '#runs?tab=history'), '#runs?tab=history');
});
