import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { RUN_VIEW_FIELDS, type ViewStateContext, viewToggleField } from '@farmslot/protocol';

let params: Record<string, string | string[]> = {
  runId: 'retained',
  panels: 'run-review-history',
  round: ['first', 'second'],
};
mock.module('react-native', { namedExports: { Platform: { OS: 'android' } } });
const localWrites: unknown[] = [];
const rootWrites: unknown[] = [];
mock.module('@react-native-async-storage/async-storage', {
  defaultExport: { getItem: async () => null, setItem: async () => undefined },
});
mock.module('expo-router', {
  namedExports: {
    useIsFocused: () => true,
    useLocalSearchParams: () => params,
    useSegments: () => ['workspace', 'run', '[runId]', 'timeline'],
    useNavigation: () => ({ setParams: (value: unknown) => localWrites.push(value) }),
    useRouter: () => ({ setParams: (value: unknown) => rootWrites.push(value), push() {} }),
  },
});
test('the native screen context restores incoming choices during its first render', async () => {
  const { ViewStateProvider, useViewState } = await import('../components/view-state');
  function Choices() {
    const state = useViewState();
    return React.createElement(
      'output',
      null,
      JSON.stringify({
        open: state.get(viewToggleField('panels', 'run-review-history', false)),
        rounds: state.get(RUN_VIEW_FIELDS.rounds),
      }),
    );
  }

  assert.match(
    renderToStaticMarkup(
      React.createElement(ViewStateProvider, null, React.createElement(Choices)),
    ),
    /&quot;open&quot;:true/,
  );
  params = { runId: 'retained' };
  const back = renderToStaticMarkup(
    React.createElement(ViewStateProvider, null, React.createElement(Choices)),
  );
  assert.match(back, /&quot;open&quot;:false/);
  assert.match(back, /&quot;rounds&quot;:\[\]/);
});

test('a nested screen writes display choices to its own navigator', async () => {
  const { ViewStateProvider, useViewState } = await import('../components/view-state');
  const states: ViewStateContext[] = [];
  function Screen() {
    states.push(useViewState());
    return null;
  }
  params = { runId: 'retained' };
  renderToStaticMarkup(React.createElement(ViewStateProvider, null, React.createElement(Screen)));
  const state = states[0];
  assert.ok(state);
  state.set(RUN_VIEW_FIELDS.rounds, ['review-1']);
  assert.equal(
    rootWrites.length,
    0,
    'the imperative root router targets the workspace layout instead of its nested leaf',
  );
  assert.deepEqual(localWrites, [{ runId: 'retained', round: 'review-1' }]);
});

test('workspace tab destinations retain display choices and exclude unsaved or authority inputs', async () => {
  const { viewStateHref } = await import('../components/view-state');
  assert.deepEqual(
    viewStateHref(
      { pathname: '/workspace/run/[runId]/timeline', params: { runId: 'retained' } },
      { round: ['review-1'], panels: 'run-review-history', draft: 'private', token: 'private' },
    ),
    {
      pathname: '/workspace/run/[runId]/timeline',
      params: { round: ['review-1'], panels: 'run-review-history', runId: 'retained' },
    },
  );
});

test('Review tab destinations retain the History choice without action or draft inputs', async () => {
  const { viewStateHref } = await import('../components/view-state');
  assert.deepEqual(
    viewStateHref({ pathname: '/runs' }, { runsTab: 'all', draft: 'private', token: 'private' }),
    { pathname: '/runs', params: { runsTab: 'all' } },
  );
});
