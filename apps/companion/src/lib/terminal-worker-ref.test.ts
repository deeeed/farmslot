import assert from 'node:assert/strict';
import test from 'node:test';

import type {
  AgentContext,
  Run,
  TmuxWorkerListResult,
  TmuxWorkerSummary,
} from '@farmslot/protocol';

import { resolveTerminalWorkerRef, slotTerminalTarget } from './terminal-worker-ref';

function makeRun(overrides: Partial<Run>): Run {
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

function context(overrides: Partial<AgentContext>): AgentContext {
  return {
    id: 'worker',
    role: 'primary',
    label: 'Worker',
    status: 'working',
    slotId: 'mini-ff-1',
    runId: 'run-1',
    ...overrides,
  };
}

function pane(target: string, overrides: Partial<TmuxWorkerSummary> = {}): TmuxWorkerSummary {
  return {
    ref: { nodeId: 'mini', session: 'mini-ff-1', target },
    status: { label: 'idle', source: 'pane' },
    ...overrides,
  } as TmuxWorkerSummary;
}

function inventory(
  machine: string,
  workers: TmuxWorkerSummary[],
  extra: { ok?: boolean; hiddenWorkers?: number } = {},
): TmuxWorkerListResult {
  return {
    observedAt: 1,
    workers,
    nodes: [
      {
        nodeId: machine,
        connected: extra.ok !== false,
        ok: extra.ok !== false,
        observedAt: 1,
        workers,
        ...(extra.hiddenWorkers ? { hiddenWorkers: extra.hiddenWorkers } : {}),
      },
    ],
  };
}

test('an agent context with a recorded pane id opens that pane without reading the inventory', () => {
  const run = makeRun({
    agentContexts: [
      context({
        id: 'rev-2',
        role: 'review',
        target: { session: 'mini-ff-1', window: 'review', pane: '0', paneId: '%7', target: 'x' },
      }),
    ],
  });
  assert.deepEqual(
    resolveTerminalWorkerRef({
      selector: { slotId: 'mini-ff-1', runId: 'run-1', contextId: 'rev-2' },
      run,
      slotMachine: 'mini',
      inventory: undefined,
    }),
    {
      status: 'ready',
      worker: {
        nodeId: 'mini',
        session: 'mini-ff-1',
        window: 'review',
        pane: '0',
        paneId: '%7',
        target: '%7',
      },
    },
  );
});

test('a bare slot reads its own machine and picks the active pane linked to the slot', () => {
  const selector = { slotId: 'mini-ff-1' };
  assert.deepEqual(
    resolveTerminalWorkerRef({ selector, run: null, slotMachine: 'mini', inventory: undefined }),
    { status: 'needs-inventory', machine: 'mini' },
  );
  const linked = pane('%4', { linkedSlotId: 'mini-ff-1', active: true });
  const resolved = resolveTerminalWorkerRef({
    selector,
    run: null,
    slotMachine: 'mini',
    inventory: inventory('mini', [
      pane('%2', { linkedSlotId: 'mini-ff-2', active: true }),
      pane('%3', { linkedSlotId: 'mini-ff-1' }),
      linked,
    ]),
  });
  assert.deepEqual(resolved, { status: 'ready', worker: linked.ref });
});

test('a context without a pane id takes the pane running its worker', () => {
  const run = makeRun({
    agentContexts: [
      context({ target: { session: 'mini-ff-1', window: 'dev', target: 'mini-ff-1:dev' } }),
    ],
  });
  const worker = pane('%9', { linkedSlotId: 'mini-ff-1', linkedRunId: 'run-1', linkedRunner: 'x' });
  const resolved = resolveTerminalWorkerRef({
    selector: { slotId: 'mini-ff-1', contextId: 'worker' },
    run,
    slotMachine: 'mini',
    inventory: inventory('mini', [pane('%8', { linkedSlotId: 'mini-ff-1', active: true }), worker]),
  });
  assert.deepEqual(resolved, { status: 'ready', worker: worker.ref });
});

test("a review worktree uses the run's pool machine, never its execution node id", () => {
  const run = makeRun({
    id: 'run-2',
    slotId: null,
    reviewWorkspace: {
      workspaceId: 'ws-1',
      machine: 'macpro',
      executionNodeId: 'local',
      checkoutPath: '/w',
      taskPath: '/t',
      artifactPath: '/a',
    },
  });
  const selector = { runId: 'run-2' };
  assert.deepEqual(
    resolveTerminalWorkerRef({ selector, run, slotMachine: undefined, inventory: undefined }),
    { status: 'needs-inventory', machine: 'macpro' },
  );
  const shell = pane('%5', { linkedRunId: 'run-2' });
  shell.ref = { ...shell.ref, nodeId: 'macpro', session: 'review-shell-ws-1' };
  assert.deepEqual(
    resolveTerminalWorkerRef({
      selector,
      run,
      slotMachine: undefined,
      inventory: inventory('macpro', [pane('%1'), shell]),
    }),
    { status: 'ready', worker: shell.ref },
  );
  assert.deepEqual(slotTerminalTarget(selector, run), { slotId: '', runId: 'run-2' });
});

test('a missing session asks for terminal.reinit with the slot target the gateway knows', () => {
  const resolved = resolveTerminalWorkerRef({
    selector: { slotId: 'mini-ff-1' },
    run: null,
    slotMachine: 'mini',
    inventory: inventory('mini', [pane('%2', { linkedSlotId: 'mini-ff-2' })]),
  });
  assert.deepEqual(resolved, { status: 'no-pane', machine: 'mini', hidden: false });
  // A finished run pinned to its slot opens the slot's own session, as the old screen did.
  const finished = makeRun({ status: 'done' });
  assert.deepEqual(slotTerminalTarget({ slotId: 'mini-ff-1', runId: 'run-1' }, finished), {
    slotId: 'mini-ff-1',
    bareSession: true,
  });
  assert.deepEqual(
    slotTerminalTarget({ slotId: 'mini-ff-1', runId: 'run-1', contextId: 'worker' }, makeRun({})),
    { slotId: 'mini-ff-1', runId: 'run-1', contextId: 'worker' },
  );
});

test('a pane the worker filter hides says so instead of opening another pane', () => {
  assert.deepEqual(
    resolveTerminalWorkerRef({
      selector: { slotId: 'mini-ff-1' },
      run: null,
      slotMachine: 'mini',
      inventory: inventory('mini', [], { hiddenWorkers: 2 }),
    }),
    { status: 'no-pane', machine: 'mini', hidden: true },
  );
});

test('a pinned session that is gone, an offline machine and a native worker never open a pane', () => {
  const run = makeRun({ agentContexts: [context({})] });
  assert.equal(
    resolveTerminalWorkerRef({
      selector: { slotId: 'mini-ff-1', runId: 'run-1', contextId: 'gone' },
      run,
      slotMachine: 'mini',
      inventory: undefined,
    }).status,
    'unavailable',
  );
  assert.deepEqual(
    resolveTerminalWorkerRef({
      selector: { slotId: 'mini-ff-1' },
      run: null,
      slotMachine: 'mini',
      inventory: inventory('mini', [], { ok: false }),
    }),
    { status: 'unavailable', reason: 'mini offline' },
  );
  assert.deepEqual(
    resolveTerminalWorkerRef({
      selector: { slotId: 'mini-ff-1', runId: 'run-1' },
      run: makeRun({ transport: 'native', agentContexts: [context({})] }),
      slotMachine: 'mini',
      inventory: undefined,
    }),
    { status: 'native' },
  );
});

test('a run still loading waits rather than guessing a pane', () => {
  assert.deepEqual(
    resolveTerminalWorkerRef({
      selector: { slotId: 'mini-ff-1', runId: 'run-1' },
      run: undefined,
      slotMachine: 'mini',
      inventory: undefined,
    }),
    { status: 'waiting', reason: 'Loading…' },
  );
});

test('an explicit actor pin on a finished run never falls back to the bare slot session', () => {
  const finished = makeRun({ status: 'done' });
  assert.deepEqual(
    slotTerminalTarget(
      { slotId: 'mini-ff-1', runId: 'run-1', contextId: 'rev-3', role: 'review' },
      finished,
    ),
    { slotId: 'mini-ff-1', runId: 'run-1', contextId: 'rev-3', role: 'review' },
  );
  assert.deepEqual(slotTerminalTarget({ slotId: 'mini-ff-1', runId: 'run-1' }, null), {
    slotId: 'mini-ff-1',
    bareSession: true,
  });
});
