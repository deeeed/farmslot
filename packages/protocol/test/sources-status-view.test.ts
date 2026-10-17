import assert from 'node:assert/strict';
import test from 'node:test';

import { deriveSourceStatusView } from '../src/sources/status-view.js';

import { sourceStatusFixture as status } from './fixtures/source-status.js';

test('current branch resolution and retained recorded inputs stay distinct without inferred drift', () => {
  const original = status();
  const view = deriveSourceStatusView(original, { params: { runId: 'retained' }, actions: [] });
  assert.equal(view.rows[0].resolution?.commit, 'c'.repeat(40));
  assert.equal(view.rows[0].recordedLocks[0].entry.commit, 'a'.repeat(40));
  assert.equal(view.rows[0].materializations[0].commit, 'a'.repeat(40));
  assert.deepEqual(view.rows[0].materializations[0].drift, []);
  view.rows[0].recordedLocks[0].entry.commit = 'changed';
  assert.equal(original.locks[0].entries[0].commit, 'a'.repeat(40));
});

test('call context filters reported nodes and recorded runs, and reports selection errors', () => {
  const original = status();
  original.nodes.push({ ...structuredClone(original.nodes[0]), nodeId: 'node-2' });
  const view = deriveSourceStatusView(original, {
    params: { nodeId: 'node-2' },
    actions: ['sync', 'pin', 'unpin'],
    target: { scope: 'node', targetId: 'node-2' },
    selections: [
      { sourceId: 'pack', selection: 'branch', ref: '/tmp/pack' },
      { sourceId: 'unknown', selection: 'main' },
    ],
  });
  assert.deepEqual(
    view.rows[0].materializations.map((row) => row.nodeId),
    ['node-2'],
  );
  assert.deepEqual(view.rows[0].recordedLocks, []);
  assert.equal(view.rows[0].selectionErrors.length, 1);
  assert.equal(view.selectionErrors.length, 2);
  assert.deepEqual(view.actions, ['sync', 'pin', 'unpin']);
});

test('unknown selection metadata stays unknown and missing revisions disable mutation controls', () => {
  const original = status();
  delete original.pinRevision;
  delete original.effectiveSelections;
  const context = {
    actions: ['sync', 'pin', 'unpin'] as const,
    target: { scope: 'farm' as const, targetId: 'farm' },
  };
  const view = deriveSourceStatusView(original, context);
  assert.equal(view.rows[0].effective, undefined);
  assert.equal(view.rows[0].resolution, undefined);
  assert.deepEqual(view.actions, ['sync']);
  original.configured = false;
  assert.deepEqual(deriveSourceStatusView(original, context).actions, []);
});

test('a context without sources, pins or recorded inputs is hidden; others read as one line', () => {
  const original = status();
  assert.equal(deriveSourceStatusView(original, { actions: [] }).line, 'pack experiment');
  const farmPin = {
    sourceId: 'pack',
    selection: 'branch' as const,
    ref: 'experiment',
    scope: 'farm' as const,
    targetId: 'farm',
    actor: 'operator',
    declarationRevision: 1,
    revision: 2,
    baseMainCommit: 'a'.repeat(40),
    createdAt: '2026-10-12T00:00:00Z',
  };
  original.effectiveSelections![0].pin = farmPin;
  const pinned = deriveSourceStatusView(original, { actions: [] });
  assert.equal(pinned.hidden, false);
  assert.equal(pinned.line, 'pack experiment (farm pin)');

  const empty = status();
  empty.configured = false;
  empty.declarations = [];
  empty.locks = [];
  const hidden = deriveSourceStatusView(empty, { params: { runId: 'retained' }, actions: [] });
  assert.equal(hidden.hidden, true);
  assert.equal(hidden.line, '');

  const refused = status();
  refused.runSource = {
    runId: 'retained',
    state: 'locked',
    canSelectSources: false,
    selectionRefusal: 'Run source inputs are admitted or have effects: retained',
  };
  const locked = deriveSourceStatusView(refused, { params: { runId: 'retained' }, actions: [] });
  assert.equal(locked.editable, false);
  assert.deepEqual(locked.actions, []);
  assert.equal(locked.line, 'pack main');
  assert.equal('readOnlyReason' in locked, false);

  // A locked run without a recorded entry shows no pin, in its line as in its summary.
  refused.effectiveSelections![0].pin = farmPin;
  refused.locks = [];
  const unrecorded = deriveSourceStatusView(refused, {
    params: { runId: 'retained' },
    actions: [],
  });
  assert.equal(unrecorded.rows[0].summary.includes('pinned'), false);
  assert.equal(unrecorded.line.includes('(farm pin)'), false);
});

test('admitted and historical inputs remain visible after their declaration is removed', () => {
  const original = status();
  original.declarations = [];
  original.runSource = {
    runId: 'retained',
    state: 'locked',
    canSelectSources: false,
    selectionRefusal: 'Create another run',
  };
  const view = deriveSourceStatusView(original, {
    target: { scope: 'run', targetId: 'retained' },
    actions: ['pin', 'unpin', 'sync'],
  });
  assert.equal(view.rows[0].declaration.id, 'pack');
  assert(view.rows[0].summary.includes('run input main'));
  assert(view.rows[0].summary.includes('a'.repeat(40)));
  assert(!view.rows[0].summary.includes('c'.repeat(40)));
  assert.equal(view.editable, false);
  assert.deepEqual(view.actions, []);
});

test('only an authoritative mutable run enables source edits', () => {
  const original = status();
  original.runSource = { runId: 'queued', state: 'planned', canSelectSources: true };
  const context = {
    target: { scope: 'run' as const, targetId: 'queued' },
    actions: ['pin', 'unpin'] as const,
  };
  assert.equal(deriveSourceStatusView(original, context).editable, true);
  original.runSource.canSelectSources = false;
  assert.deepEqual(deriveSourceStatusView(original, context).actions, []);
  assert.equal(deriveSourceStatusView(original, context).editable, false);
});

test('a draft shows the selected branch and main base without claiming a published pin', () => {
  const original = status();
  original.resolutions.push({ ...original.resolutions[0], ref: 'main' });
  original.resolutions.push({
    ...original.resolutions[0],
    ref: 'experiment/run',
    commit: 'd'.repeat(40),
  });
  const view = deriveSourceStatusView(original, {
    actions: [],
    selections: [{ sourceId: 'pack', selection: 'branch', ref: 'experiment/run' }],
  });
  assert.match(view.rows[0].summary, /run selection experiment\/run/);
  assert.equal(
    view.line,
    'pack experiment/run (run pin)',
    'the line names the draft, not the farm ref',
  );
  assert(view.rows[0].summary.includes('d'.repeat(40)));
  assert(view.rows[0].details.some((line) => line.includes('Draft main base ' + 'c'.repeat(40))));
  assert.deepEqual(view.actions, []);
});

test('published pin scope and base stay visible when detail facts are collapsed', () => {
  const original = status();
  original.effectiveSelections![0].pin = {
    sourceId: 'pack',
    scope: 'node',
    targetId: 'node-1',
    selection: 'branch',
    ref: 'experiment',
    baseMainCommit: 'e'.repeat(40),
    actor: 'owner',
    createdAt: '2026-10-13T00:00:00Z',
    declarationRevision: 1,
    revision: 2,
  };
  const view = deriveSourceStatusView(original, { actions: [] });
  assert.match(view.rows[0].summary, /pinned node/);
  assert(view.rows[0].summary.includes('base main ' + 'e'.repeat(40)));
});
