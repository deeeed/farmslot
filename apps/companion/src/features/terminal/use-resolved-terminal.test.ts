import assert from 'node:assert/strict';
import test from 'node:test';
import { URL } from 'node:url';

import {
  type AgentContext,
  Methods,
  type Run,
  type SlotAgentTargetParams,
  type TmuxWorkerListResult,
  type TmuxWorkerRef,
  type TmuxWorkerSummary,
} from '@farmslot/protocol';
import { resourceQuery } from '@farmslot/protocol/client-cache';

import { mountHook } from '../../hooks/hook-harness.fixtures';
import type { TerminalSelector } from '../../lib/terminal-worker-ref';
import * as terminalWorkerRef from '../../lib/terminal-worker-ref';

interface Resolved {
  worker: TmuxWorkerRef | null;
  target: SlotAgentTargetParams | null;
  reason: string | undefined;
}
type ReadState = { status: string; data?: unknown; error?: Error };

const reviewer: AgentContext = {
  id: 'rev-1',
  role: 'review',
  label: 'Reviewer',
  status: 'working',
  slotId: 'mini-ff-1',
  runId: 'run-1',
  target: { session: 'mini-ff-1', window: 'review', paneId: '%2', target: 'mini-ff-1:review' },
};
function makeRun(overrides: Partial<Run> = { agentContexts: [reviewer] }): Run {
  return {
    id: 'run-1',
    familyId: 'family-1',
    ticketOrPr: 'PR #1',
    project: 'farm',
    flowType: 'fix-bug',
    lane: 'production',
    status: 'monitoring',
    branch: 'feature/x',
    slotId: 'mini-ff-1',
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-01T00:00:00.000Z',
    steps: [],
    decisions: [],
    metrics: {},
    ...overrides,
  } as Run;
}
function emptyInventory(hiddenWorkers?: number): TmuxWorkerListResult {
  return {
    observedAt: 1,
    workers: [],
    nodes: [
      {
        nodeId: 'mini',
        connected: true,
        ok: true,
        observedAt: 1,
        workers: [],
        ...(hiddenWorkers ? { hiddenWorkers } : {}),
      },
    ],
  };
}

function mount() {
  const reads = new Map<string, ReadState>();
  const requests: Array<[string, unknown]> = [];
  const retries: string[] = [];
  const client = {
    request: async (method: string, params: unknown) => {
      requests.push([method, params]);
      return { reinitialized: true };
    },
  };
  const hook = mountHook<[TerminalSelector]>(
    new URL('./use-resolved-terminal.ts', import.meta.url),
    'useResolvedTerminal',
    {
      '@farmslot/protocol': { Methods },
      '@farmslot/protocol/client-cache': { resourceQuery },
      '../../hooks/useResourceQuery': {
        useResourceQuery: (query?: { method: string }) =>
          (query && reads.get(query.method)) ?? { status: 'loading' },
      },
      '../../lib/resource-cache': {
        getResourceCache: () => ({
          retry: async (query: { method: string }) => retries.push(query.method),
        }),
      },
      '../../lib/terminal-worker-ref': terminalWorkerRef,
      '../../store/connection': {
        useConnectionStore: (select: (value: { client: typeof client }) => unknown) =>
          select({ client }),
      },
      '../../store/fleet': {
        useFleetStore: (select: (value: unknown) => unknown) =>
          select({ fleet: { slots: [{ slot: 'mini-ff-1', machine: 'mini' }] } }),
      },
    },
  );
  const render = (selector: TerminalSelector) => hook.render(selector) as Resolved;
  return { hook, reads, requests, retries, render };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

test('a run refresh keeps the same pane and target objects, so the stream is not restarted', () => {
  const { hook, reads, render } = mount();
  try {
    const selector = { slotId: 'mini-ff-1', runId: 'run-1' };
    reads.set(Methods.RUN_GET, { status: 'ready', data: { run: makeRun() } });
    const first = render(selector);
    assert.equal(first.worker?.target, '%2');
    assert.deepEqual(first.target, {
      slotId: 'mini-ff-1',
      runId: 'run-1',
      contextId: 'rev-1',
      role: 'review',
    });
    // An ordinary invalidation delivers an equal run as a new object.
    reads.set(Methods.RUN_GET, { status: 'ready', data: { run: makeRun() } });
    const second = render(selector);
    assert.equal(second.worker, first.worker);
    assert.equal(second.target, first.target);
  } finally {
    hook.cleanup();
  }
});

test('a pinned actor whose run read failed opens nothing and creates no session', async () => {
  const { hook, reads, requests, render } = mount();
  try {
    reads.set(Methods.RUN_GET, { status: 'error', error: new Error('timeout') });
    reads.set(Methods.TMUX_WORKER_LIST, { status: 'ready', data: emptyInventory() });
    const resolved = render({ slotId: 'mini-ff-1', runId: 'run-1', contextId: 'rev-1' });
    await settle();
    assert.equal(resolved.worker, null);
    assert.equal(resolved.reason, 'Run unavailable');
    assert.deepEqual(requests, []);
  } finally {
    hook.cleanup();
  }
});

test('a missing slot session is created once, and "hidden" is said only if still missing', async () => {
  for (const hidden of [undefined, 3]) {
    const { hook, reads, requests, retries, render } = mount();
    try {
      reads.set(Methods.RUN_FOR_SLOT, { status: 'ready', data: { run: null } });
      reads.set(Methods.TMUX_WORKER_LIST, { status: 'ready', data: emptyInventory(hidden) });
      const selector = { slotId: 'mini-ff-1' };
      assert.equal(render(selector).reason, 'Starting session…');
      await settle();
      render(selector);
      assert.deepEqual(requests, [[Methods.TERMINAL_REINIT, { slotId: 'mini-ff-1' }]]);
      assert.deepEqual(retries, [Methods.TMUX_WORKER_LIST]);
      assert.equal(render(selector).reason, hidden ? 'Hidden by the worker filter' : 'No pane');
      assert.equal(requests.length, 1);
    } finally {
      hook.cleanup();
    }
  }
});

test('a session that disappears while the terminal is open is created again', async () => {
  const { hook, reads, requests, render } = mount();
  try {
    const selector = { slotId: 'mini-ff-1' };
    const pane: TmuxWorkerSummary = {
      ref: { nodeId: 'mini', session: 'mini-ff-1', target: '%4' },
      linkedSlotId: 'mini-ff-1',
      status: { label: 'Idle', source: 'tmux', confidence: 'high' },
    };
    const listing = (workers: TmuxWorkerListResult['workers']): TmuxWorkerListResult => ({
      ...emptyInventory(),
      workers,
      nodes: [{ ...emptyInventory().nodes[0], workers }],
    });
    reads.set(Methods.RUN_FOR_SLOT, { status: 'ready', data: { run: null } });
    reads.set(Methods.TMUX_WORKER_LIST, { status: 'ready', data: listing([]) });
    render(selector);
    await settle();
    reads.set(Methods.TMUX_WORKER_LIST, { status: 'ready', data: listing([pane]) });
    assert.equal(render(selector).worker?.target, '%4');
    // The session is killed while the tab stays open.
    reads.set(Methods.TMUX_WORKER_LIST, { status: 'ready', data: listing([]) });
    render(selector);
    await settle();
    assert.equal(requests.length, 2);
  } finally {
    hook.cleanup();
  }
});
