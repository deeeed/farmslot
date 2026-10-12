import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const routerRoot = path.dirname(require.resolve('expo-router/package.json'));
function loadReader(relative: string, overrides: Record<string, unknown> = {}) {
  const file = path.join(routerRoot, relative);
  const localRequire = createRequire(file);
  const exports: Record<string, unknown> = {};
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), {
    exports,
    process,
    URL,
    URLSearchParams,
    console,
    require: (name: string) => overrides[name] ?? localRequire(name),
  });
  return exports;
}
const parserFile = path.join(routerRoot, 'build/fork/getStateFromPath.js');
const parserRequire = createRequire(parserFile);
const parser = loadReader('build/fork/getStateFromPath.js', {
  '../react-navigation/native': parserRequire('../react-navigation/core/validatePathConfig'),
});
const globalReader = loadReader('build/global-state/getRouteInfoFromState.js', {
  '../fork/getPathFromState-forks': { appendBaseUrl: (pathname: string) => pathname },
});
const { extractExpoPathFromURL } = require(
  path.join(routerRoot, 'build/fork/extractPathFromURL.js'),
);
const config = {
  screens: {
    __root: {
      path: '',
      screens: {
        'terminal/worker': 'terminal/worker',
        'slot/[slotId]': 'slot/:slotId',
        'parts/[...parts]': 'parts/*parts',
      },
    },
  },
};
interface RouteState {
  routes: Array<{ name: string; params?: Record<string, unknown>; state?: RouteState }>;
}
const parse = parser.getStateFromPath as (pathname: string, config: unknown) => RouteState;
const global = globalReader.getRouteInfoFromState as (state: RouteState) => {
  params: Record<string, unknown>;
  pathnameWithParams: string;
};
function readLocal(params: Record<string, unknown>, contextKey: string) {
  const reader = loadReader('build/hooks/useLocalSearchParams.js', {
    react: { use: () => params },
    '../Route': { LocalRouteParamsContext: {}, useRouteNode: () => ({ contextKey }) },
    '../link/preview/PreviewRouteContext': { usePreviewInfo: () => ({ params: undefined }) },
  });
  return (reader.useLocalSearchParams as () => Record<string, unknown>)();
}
function readLink(url: string) {
  const pathname = extractExpoPathFromURL([], url);
  const state = parse(pathname, config);
  assert(state, 'Native extraction matches the route');
  let route = state.routes[0];
  while (route.state) route = route.state.routes[0];
  return {
    local: readLocal(route.params ?? {}, `./${route.name}.tsx`),
    global: global(state),
  };
}
function workerLink(values: Record<string, string | string[]>) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    for (const entry of Array.isArray(value) ? value : [value]) query.append(key, entry);
  }
  return `farmslot-development://terminal/worker?${query}`;
}
function plain(value: unknown) {
  return JSON.parse(JSON.stringify(value));
}

test('native query pane ids retain literal percent escapes in both readers', () => {
  const read = readLink(workerLink({ target: '%225', paneId: '%225' }));
  assert.equal(read.local.target, '%225');
  assert.equal(read.global.params.target, '%225');
  assert.equal(read.global.params.paneId, '%225');
});
test('query delimiters and repeated values survive the full native pipeline', () => {
  const values = { title: 'hello%20world', tag: ['%225', 'a b', 'a+b', 'a&b=c'] };
  const read = readLink(workerLink(values));
  assert.deepEqual(plain(read.local), values);
  assert.deepEqual(plain(read.global.params), values);
  const roundTrip = readLink(`farmslot-development://${read.global.pathnameWithParams}`);
  assert.deepEqual(plain(roundTrip.global.params), values);
});
test('serialized worker references preserve their pane id', () => {
  const worker = { nodeId: 'node', session: 'qa', target: '%225', paneId: '%225' };
  const read = readLink(workerLink({ worker: JSON.stringify(worker) }));
  assert.deepEqual(JSON.parse(read.local.worker as string), worker);
  assert.deepEqual(JSON.parse(read.global.params.worker as string), worker);
});
test('development-client wrapper preserves encoded inner query values', () => {
  const inner = workerLink({ target: '%225' });
  const wrapper = `farmslot-development://expo-development-client/?${new URLSearchParams({ url: inner })}`;
  assert.equal(readLink(wrapper).local.target, '%225');
});
test('pathname parameters keep existing decode behavior', () => {
  const read = readLink('farmslot-development://slot/slot%20one?target=%25225');
  assert.deepEqual(plain(read.local), { slotId: 'slot one', target: '%225' });
  assert.deepEqual(plain(read.global.params), { slotId: 'slot one', target: '%225' });
  const deep = readLink('farmslot-development://parts/a%20b/%25225');
  assert.deepEqual(plain(deep.local.parts), ['a b', '%225']);
  assert.deepEqual(plain(deep.global.params.parts), ['a b', '%225']);
});
test('nullable and malformed pathname values remain readable', () => {
  assert.deepEqual(
    {
      ...readLocal({ slotId: '%invalid', absent: undefined, cleared: null }, './slot/[slotId].tsx'),
    },
    {
      slotId: '%invalid',
      absent: undefined,
      cleared: null,
    },
  );
});
