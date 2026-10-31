import assert from 'node:assert/strict';
import test from 'node:test';

import {
  Methods,
  type TmuxWorkerListResult,
  tmuxWorkerRefsMatch,
  type TmuxWorkerSummary,
} from '@farmslot/protocol';
import {
  canActOn,
  heldDataIsSaved,
  resourceQuery,
  type ResourceQueryState,
} from '@farmslot/protocol/client-cache';

import { visibleReadError } from '../lib/resource-read-status';
import { paneRunnerContext, type TerminalRunnerPane } from '../lib/terminal-controls';

import { mountHook } from './hook-harness.fixtures';
import type { PaneRunnerContextState } from './usePaneRunnerContext';

const worker: TmuxWorkerSummary = {
  ref: { nodeId: 'mini', session: 'mmt-3', target: '%19' },
  linkedRunner: 'claude',
  status: { label: 'Idle', source: 'tmux', confidence: 'high' },
};
const inventory: TmuxWorkerListResult = {
  observedAt: 1_000,
  nodes: [{ nodeId: 'mini', connected: true, ok: true, observedAt: 1_000, workers: [worker] }],
  workers: [worker],
};

// Pixel 6: "Runner keys wait for current worker inventory." came back in red on every reread.
test('runner keys stay usable and quiet while the worker inventory rereads', () => {
  let state: ResourceQueryState<TmuxWorkerListResult> = { status: 'loading' };
  const connection = { client: { connectionState: 'connected' }, status: 'connected' };
  const forgotten: string[][] = [];
  const hook = mountHook<[TerminalRunnerPane | null]>(
    new URL('./usePaneRunnerContext.ts', import.meta.url),
    'usePaneRunnerContext',
    {
      'expo-router': { useIsFocused: () => true },
      '@farmslot/protocol': { Methods, tmuxWorkerRefsMatch },
      '@farmslot/protocol/client-cache': { canActOn, heldDataIsSaved, resourceQuery },
      '../lib/resource-read-status': { visibleReadError },
      '../lib/terminal-controls': { paneRunnerContext },
      '../store/connection': {
        useConnectionStore: (select: (value: typeof connection) => unknown) => select(connection),
      },
      '../store/terminal-prefs': {
        useTerminalPrefsStore: (
          select: (value: { forgetClosedPanes: (node: string, open: string[]) => void }) => unknown,
        ) => select({ forgetClosedPanes: (_node, open) => forgotten.push(open) }),
      },
      './useResourceQuery': { useResourceQuery: () => state },
    },
  );
  const pane = { nodeId: 'mini', target: '%19' };
  const render = (selected: TerminalRunnerPane | null = pane) =>
    hook.render(selected) as PaneRunnerContextState;
  try {
    assert.equal(render().error, null, 'The first read is loading, not an error');
    state = { status: 'ready', data: inventory, observedAt: 1_000 };
    assert.equal(render().context.linkedRunner, 'claude');
    assert.deepEqual(forgotten, [['%19']], 'A current read prunes closed panes');

    state = { status: 'stale', data: inventory, observedAt: 1_000 };
    const rereading = render();
    assert.equal(rereading.error, null);
    assert.equal(rereading.context.linkedRunner, 'claude', 'Runner keys keep the held inventory');
    // Held inventory that lacks a pane a newer read shows must never prune its saved keys.
    state = {
      status: 'stale',
      data: { ...inventory, nodes: [{ ...inventory.nodes[0]!, workers: [] }], workers: [] },
      observedAt: 1_000,
    };
    render();
    assert.deepEqual(forgotten, [['%19']], 'Stale inventory never prunes pane preferences');
    state = { status: 'stale', data: inventory, observedAt: 1_000 };

    state = {
      ...state,
      observedAt: Date.now(),
      error: {
        code: 'RESOURCE_OBSERVATION_CHANGED',
        message: 'The file observation changed during this read.',
      },
    };
    assert.equal(render().error, null, 'A fresh superseded read is not an error either');

    // Saved inventory still says so: a failed read, or no connection.
    state = {
      status: 'stale',
      data: inventory,
      observedAt: 1_000,
      error: { code: 'TIMEOUT', message: 'Request tmux.worker.list timed out after 10000ms' },
    };
    assert.equal(render().error, 'Request tmux.worker.list timed out after 10000ms');
    assert.equal(render().context.linkedRunner, null);
    state = { status: 'stale', data: inventory, observedAt: 1_000 };
    connection.status = 'disconnected';
    assert.equal(render().error, 'Runner keys wait for current worker inventory.');
    // The transport, not only the store status, decides whether the held inventory is current.
    connection.status = 'connected';
    connection.client.connectionState = 'reconnecting';
    assert.equal(render().error, 'Runner keys wait for current worker inventory.');
    connection.client.connectionState = 'connected';

    // A slot terminal without a worker pane has no inventory to wait for.
    connection.status = 'connected';
    state = { status: 'loading' };
    assert.equal(render(null).error, null);
  } finally {
    hook.cleanup();
  }
});
