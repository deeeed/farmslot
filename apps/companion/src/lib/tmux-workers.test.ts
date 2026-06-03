import assert from 'node:assert/strict';
import test from 'node:test';

import type {
  TmuxWorkerNodeResult,
  TmuxWorkerSummary,
  TmuxWorkerWatchEntry,
} from '@farmslot/protocol';

import {
  buildTmuxWorkerRows,
  filterTmuxWorkerNodes,
  tmuxWorkerNodeSummaryLabel,
  tmuxWorkerRefFromRouteParams,
  tmuxWorkerRouteParams,
  tmuxWorkerRouteParamsFromRef,
  tmuxWorkerStateLabel,
  tmuxWorkerSubtitle,
  tmuxWorkerTitle,
  tmuxWorkerWatchEntrySubtitle,
  tmuxWorkerWatchEntryTitle,
} from './tmux-workers';

function worker(overrides: Partial<TmuxWorkerSummary> = {}): TmuxWorkerSummary {
  return {
    ref: {
      nodeId: 'runner-local',
      session: 'omx',
      window: '1',
      windowName: 'editor',
      pane: '2',
      paneId: '%4',
      target: 'omx:1.2',
    },
    title: 'Implement feature',
    cwd: '/Users/example/dev/farmslot',
    linkedSlotId: 'runner-mobile-1',
    status: { label: 'working', source: 'hook', confidence: 'high' },
    ...overrides,
  };
}

function node(overrides: Partial<TmuxWorkerNodeResult> = {}): TmuxWorkerNodeResult {
  return {
    nodeId: 'runner-local',
    connected: true,
    ok: true,
    observedAt: 1,
    workers: [worker()],
    ...overrides,
  };
}
test('buildTmuxWorkerRows shows one primary pane per session by default', () => {
  const rows = buildTmuxWorkerRows([
    node({
      nodeId: 'runner-local',
      workers: [
        worker({
          title: 'A',
          ref: { ...worker().ref, session: 's1', pane: '1', target: 's1:1.1' },
        }),
        worker({
          title: 'B',
          active: true,
          ref: { ...worker().ref, session: 's1', pane: '2', target: 's1:1.2' },
        }),
      ],
    }),
    node({ nodeId: 'runner-a', workers: [] }),
  ]);

  // Active pane wins the primary slot; sibling stays hidden until expanded.
  assert.deepEqual(
    rows.map((row) =>
      row.type === 'header'
        ? `node:${row.node.nodeId}`
        : row.type === 'window'
          ? `window:${row.window}`
          : row.worker.title,
    ),
    ['node:runner-local', 'B', 'node:runner-a'],
  );
  const primary = rows.find((row) => row.type === 'worker');
  assert.ok(primary && primary.type === 'worker');
  assert.equal(primary.role, 'primary');
  assert.equal(primary.siblingCount, 1);
  assert.equal(primary.sessionPaneCount, 2);
  assert.equal(primary.isActive, true);
});

test('buildTmuxWorkerRows reveals sibling panes when session is expanded', () => {
  const nodes = [
    node({
      nodeId: 'runner-local',
      workers: [
        worker({
          title: 'A',
          ref: { ...worker().ref, session: 's1', pane: '1', target: 's1:1.1' },
        }),
        worker({
          title: 'B',
          active: true,
          ref: { ...worker().ref, session: 's1', pane: '2', target: 's1:1.2' },
        }),
      ],
    }),
  ];
  const expanded = new Set(['runner-local::s1']);
  const rows = buildTmuxWorkerRows(nodes, expanded);
  assert.deepEqual(
    rows.map((row) =>
      row.type === 'header'
        ? `node:${row.node.nodeId}`
        : row.type === 'window'
          ? `window:${row.window}`
          : row.worker.title,
    ),
    ['node:runner-local', 'B', 'A'],
  );
  const sibling = rows[2];
  assert.ok(sibling && sibling.type === 'worker');
  assert.equal(sibling.role, 'sibling');
  assert.equal(sibling.expanded, true);
});
test('tmux worker presentation uses stable fallback labels and route params', () => {
  const item = worker({ title: undefined, command: 'codex', linkedSlotId: undefined });

  assert.equal(tmuxWorkerTitle(item), 'omx');
  assert.equal(tmuxWorkerSubtitle(item), '/Users/example/dev/farmslot');
  const routeParams = tmuxWorkerRouteParams(item);
  assert.ok(routeParams.workerRef);
  const { workerRef: _workerRef, ...legacyParams } = routeParams;
  assert.deepEqual(legacyParams, {
    nodeId: 'runner-local',
    session: 'omx',
    target: 'omx:1.2',
    window: '1',
    windowName: 'editor',
    pane: '2',
    paneId: '%4',
    title: 'omx',
  });
});

test('tmux worker presentation hides pane ids and surfaces activity summaries', () => {
  const item = worker({
    branch: 'feature/mobile',
    status: { label: 'busy · opus', source: 'statusline', confidence: 'high', state: 'active' },
  } as Partial<TmuxWorkerSummary>);
  assert.equal(
    tmuxWorkerSubtitle(item),
    '/Users/example/dev/farmslot · feature/mobile · runner-mobile-1',
  );
  assert.equal(tmuxWorkerStateLabel(item), 'active');
  assert.equal(
    tmuxWorkerNodeSummaryLabel(
      node({
        summary: { panes: 4, active: 1, waiting: 1, idle: 2, stale: 0, unknown: 0 },
        hiddenWorkers: 2,
      } as Partial<TmuxWorkerNodeResult>),
    ),
    '4 panes · 1 active · 1 waiting · 2 idle · 2 hidden',
  );
});

test('filterTmuxWorkerNodes applies global machine filters to node groups', () => {
  const nodes = [
    node({ nodeId: 'runner-local', workers: [worker({ title: 'runner-local worker' })] }),
    node({
      nodeId: 'runner-a',
      workers: [worker({ ref: { ...worker().ref, nodeId: 'runner-a' } })],
    }),
    node({ nodeId: 'mini', ok: false, connected: false, workers: [] }),
  ];

  assert.deepEqual(
    filterTmuxWorkerNodes(nodes, { projects: [], machines: ['runner-a', 'mini'] }).map(
      (item) => item.nodeId,
    ),
    ['runner-a', 'mini'],
  );
});
test('filterTmuxWorkerNodes leaves tmux workers unfiltered when no machine filter is active', () => {
  const nodes = [node({ nodeId: 'runner-local' }), node({ nodeId: 'runner-a' })];

  assert.equal(
    filterTmuxWorkerNodes(nodes, { projects: ['ignored-for-worker-nodes'], machines: [] }),
    nodes,
  );
});
test('tmux worker route params preserve tmux percent pane targets', () => {
  const item = worker({
    ref: {
      nodeId: 'runner-local',
      session: 'omx',
      target: '%13',
      paneId: '%13',
      window: '1',
      pane: '0',
    },
  });

  const params = tmuxWorkerRouteParams(item);
  assert.match(params.workerRef, /%2513/);
  assert.deepEqual(tmuxWorkerRefFromRouteParams(params), item.ref);
});
test('tmux worker route parser supports legacy individual params', () => {
  assert.deepEqual(
    tmuxWorkerRefFromRouteParams({
      nodeId: 'runner-a',
      session: 'omx',
      target: '%4',
      paneId: '%4',
    }),
    { nodeId: 'runner-a', session: 'omx', target: '%4', paneId: '%4' },
  );
});

test('tmux worker watch presentation supports stale entries', () => {
  const entry: TmuxWorkerWatchEntry = {
    id: 'runner-local:%4',
    ref: { nodeId: 'runner-local', session: 'omx', target: '%4', paneId: '%4' },
    item: {
      id: 'runner-local:%4',
      ref: { nodeId: 'runner-local', session: 'omx', target: '%4', paneId: '%4' },
      nodeId: 'runner-local',
      target: '%4',
      title: 'Ad-hoc Codex',
      cwd: '/Users/example/dev/farmslot',
      branch: 'feature/terminals',
      pinnedAt: 1,
      lastSeenAt: 2,
    },
    live: false,
  };

  assert.equal(tmuxWorkerWatchEntryTitle(entry), 'omx · %4');
  assert.equal(
    tmuxWorkerWatchEntrySubtitle(entry),
    'feature/terminals · /Users/example/dev/farmslot',
  );
  assert.deepEqual(tmuxWorkerRouteParamsFromRef(entry.ref, 'omx · %4'), {
    workerRef: encodeURIComponent(JSON.stringify(entry.ref)),
    nodeId: 'runner-local',
    session: 'omx',
    target: '%4',
    paneId: '%4',
    title: 'omx · %4',
  });
});
