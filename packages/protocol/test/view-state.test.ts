import assert from 'node:assert/strict';
import test from 'node:test';

import { acceptanceClaimField, runDetailPanelField } from '../src/surfaces/run-view-state.js';
import {
  createViewStateContext,
  viewChoiceField,
  viewListField,
  viewScopedIntegerField,
  type ViewStateHistory,
  viewStateRoutePatch,
  viewStateSearchParams,
  viewTextField,
  viewToggleField,
  viewToggleOverrideField,
} from '../src/surfaces/view-state.js';

function fixture(query: string) {
  let current = new URLSearchParams(query);
  const history: Array<{ query: string; mode: ViewStateHistory }> = [];
  const listeners = new Set<() => void>();
  const state = createViewStateContext({
    read: () => new URLSearchParams(current),
    write(params, mode) {
      current = new URLSearchParams(params);
      history.push({ query: current.toString(), mode });
      for (const listener of listeners) listener();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  });
  return {
    state,
    history,
    navigate(query: string) {
      current = new URLSearchParams(query);
      for (const listener of listeners) listener();
    },
  };
}

test('panel overrides omit defaults, preserve the selected run/round and restore before rendering', () => {
  const f = fixture('run=run-1&round=review-2');
  const artifacts = viewToggleField('panels', 'artifacts', false);
  const acceptance = viewToggleField('panels', 'acceptance', true);
  assert.equal(f.state.get(artifacts), false);
  f.state.update((values) => {
    values.set(artifacts, true);
    values.set(acceptance, false);
  });
  const link = f.state.snapshot();
  assert.equal(new URLSearchParams(link).get('panels'), '!acceptance,artifacts');
  assert.equal(new URLSearchParams(link).get('round'), 'review-2');
  assert.equal(f.history.length, 1, 'a selection transaction creates one history entry');
  const restored = fixture(link);
  assert.equal(restored.state.get(artifacts), true);
  assert.equal(restored.state.get(acceptance), false);
  f.state.update((values) => {
    values.set(artifacts, false);
    values.set(acceptance, true);
  });
  assert.equal(new URLSearchParams(f.state.snapshot()).has('panels'), false);
});

test('Back/Forward readers use the current route, without a remembered preference overriding it', () => {
  const f = fixture('tab=diff');
  const tab = viewChoiceField('tab', 'summary', ['summary', 'diff']);
  let notifications = 0;
  const unsubscribe = f.state.subscribe(() => notifications++);
  assert.equal(f.state.get(tab), 'diff');
  f.navigate('');
  assert.equal(f.state.get(tab), 'summary');
  f.navigate('tab=diff');
  assert.equal(f.state.get(tab), 'diff');
  assert.equal(notifications, 2);
  unsubscribe();
  f.navigate('tab=unknown');
  assert.equal(f.state.get(tab), 'summary');
  assert.equal(notifications, 2);
});

test('search typing replaces history and repeated rounds retain their complete selections', () => {
  const f = fixture('run=run-1');
  const query = viewTextField('q');
  const rounds = viewListField('round');
  f.state.set(query, 'review fix', 'replace');
  assert.equal(f.history[0].mode, 'replace');
  f.state.set(rounds, ['review-1', 'review-3']);
  assert.deepEqual(f.state.get(rounds), ['review-1', 'review-3']);
  assert.equal(f.history[1].mode, 'push');
  f.state.set(rounds, []);
  assert.equal(new URLSearchParams(f.state.snapshot()).has('round'), false);
  f.state.set(query, 'review fix', 'replace');
  assert.equal(f.history.length, 3, 'the unchanged selection creates no history write');
});

test('an explicitly empty filter differs from a nonempty configured default', () => {
  const f = fixture('');
  const projects = viewListField('projects', ['farm'], 'csv');
  f.state.set(projects, []);
  assert.deepEqual(f.state.get(projects), []);
  f.state.set(projects, ['farm']);
  assert.equal(f.state.snapshot(), '');
  assert.deepEqual(f.state.get(projects), ['farm']);
});

test('native route adapters preserve repeated choices and explicitly clear restored defaults', () => {
  const before = viewStateSearchParams({
    runId: 'run-1',
    round: ['review-1', 'review-2'],
    panels: 'run-review-history',
    absent: undefined,
  });
  const next = new URLSearchParams(before);
  next.delete('panels');
  assert.deepEqual(viewStateRoutePatch(before, next), {
    runId: 'run-1',
    round: ['review-1', 'review-2'],
    panels: undefined,
  });
  assert.deepEqual(before.getAll('round'), ['review-1', 'review-2']);
});

test('panel IDs containing commas and explicit status-derived choices round-trip', () => {
  const f = fixture('');
  const field = viewToggleField('panels', 'proof:a,b%2C', false);
  f.state.set(field, true);
  assert.equal(f.state.get(field), true);
  assert.equal(f.state.get(viewToggleField('panels', 'b%2C', false)), false);
  f.state.set(viewToggleOverrideField('subtasks', 'run:unit', true), false);
  assert.equal(f.state.get(viewToggleOverrideField('subtasks', 'run:unit', false)), false);
  assert.equal(f.state.get(viewToggleOverrideField('subtasks', 'run:unit', true)), false);
});

test('a gallery restores its index on reload but an explicit new item wins', () => {
  const f = fixture('');
  const first = viewScopedIntegerField('mediaIndex', 'mediaSource', 'artifact-a', 0);
  f.state.set(first, 2);
  assert.equal(
    f.state.get(viewScopedIntegerField('mediaIndex', 'mediaSource', 'artifact-a', 0)),
    2,
  );
  assert.equal(
    f.state.get(viewScopedIntegerField('mediaIndex', 'mediaSource', 'artifact-b', 1)),
    1,
  );
  f.state.set(first, 0);
  assert.equal(new URLSearchParams(f.state.snapshot()).has('mediaIndex'), false);
  assert.equal(new URLSearchParams(f.state.snapshot()).has('mediaSource'), false);
});

test('matching run acceptance and claim disclosures share defaults and URL encoding', () => {
  const f = fixture('');
  assert.equal(f.state.get(runDetailPanelField('run-acceptance')), true);
  f.state.set(runDetailPanelField('run-acceptance'), false);
  f.state.set(acceptanceClaimField('AC-1'), true);
  assert.equal(new URLSearchParams(f.state.snapshot()).get('panels'), '!run-acceptance,claim:AC-1');
  const linked = fixture(f.state.snapshot());
  assert.equal(linked.state.get(runDetailPanelField('run-acceptance')), false);
  assert.equal(linked.state.get(acceptanceClaimField('AC-1')), true);
});
