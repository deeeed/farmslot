import assert from 'node:assert/strict';
import test from 'node:test';

import type {
  AgentContext,
  Run,
  TmuxWorkerListResult,
  TmuxWorkerRef,
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

function pane(
  target: string,
  overrides: Partial<TmuxWorkerSummary> = {},
  ref: Partial<TmuxWorkerRef> = {},
): TmuxWorkerSummary {
  return {
    ref: { nodeId: 'mini', session: 'mini-ff-1', target, ...ref },
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
      target: { slotId: 'mini-ff-1', runId: 'run-1', contextId: 'rev-2', role: 'review' },
    },
  );
});

test('a plain slot link shows, types into and sends to the same actor', () => {
  // The slot's run has a primary worker and a working reviewer: the terminal opens the
  // reviewer, so Send names the reviewer too and never falls to the gateway's primary default.
  const run = makeRun({
    agentContexts: [
      context({ target: { session: 'mini-ff-1', window: 'dev', paneId: '%1', target: 'a' } }),
      context({
        id: 'rev-1',
        role: 'review',
        target: { session: 'mini-ff-1', window: 'review', paneId: '%2', target: 'b' },
      }),
    ],
  });
  const resolved = resolveTerminalWorkerRef({
    selector: { slotId: 'mini-ff-1' },
    run,
    slotMachine: 'mini',
    inventory: undefined,
  });
  assert.equal(resolved.status, 'ready');
  if (resolved.status !== 'ready') return;
  assert.equal(resolved.worker.target, '%2');
  assert.deepEqual(resolved.target, {
    slotId: 'mini-ff-1',
    runId: 'run-1',
    contextId: 'rev-1',
    role: 'review',
  });
});

test('a context that recorded only its window opens a pane in that window, never the worker', () => {
  const run = makeRun({
    agentContexts: [
      context({ target: { session: 'mini-ff-1', window: 'dev', target: 'mini-ff-1:dev' } }),
      context({
        id: 'rev-1',
        role: 'review',
        status: 'waiting',
        target: { session: 'mini-ff-1', window: 'review', target: 'mini-ff-1:review' },
      }),
    ],
  });
  const dev = pane(
    '%1',
    { linkedSlotId: 'mini-ff-1', linkedRunId: 'run-1', linkedRunner: 'x' },
    { windowName: 'dev' },
  );
  const reviewer = pane('%2', { linkedSlotId: 'mini-ff-1' }, { windowName: 'review' });
  const selector = { slotId: 'mini-ff-1', runId: 'run-1', contextId: 'rev-1' };
  const resolved = resolveTerminalWorkerRef({
    selector,
    run,
    slotMachine: 'mini',
    inventory: inventory('mini', [dev, reviewer]),
  });
  assert.equal(resolved.status === 'ready' && resolved.worker.target, '%2');
  assert.deepEqual(
    resolveTerminalWorkerRef({
      selector,
      run,
      slotMachine: 'mini',
      inventory: inventory('mini', [dev]),
    }),
    { status: 'unavailable', reason: 'Window not open' },
  );
});

test('an actor pin whose run cannot be read never opens another actor', () => {
  const other = pane('%7', {
    linkedSlotId: 'mini-ff-1',
    linkedRunId: 'run-OTHER',
    linkedRunner: 'x',
  });
  for (const selector of [
    { slotId: 'mini-ff-1', runId: 'run-1', contextId: 'rev-3' },
    { slotId: 'mini-ff-1', runId: 'run-1', role: 'review' as const },
  ])
    assert.deepEqual(
      resolveTerminalWorkerRef({
        selector,
        run: null,
        slotMachine: 'mini',
        inventory: inventory('mini', [other]),
      }),
      { status: 'unavailable', reason: 'Run unavailable' },
    );
});

test('a bare slot reads its own machine and picks the active pane linked to the slot', () => {
  const selector = { slotId: 'mini-ff-1' };
  const target = { slotId: 'mini-ff-1' };
  assert.deepEqual(
    resolveTerminalWorkerRef({ selector, run: null, slotMachine: 'mini', inventory: undefined }),
    { status: 'needs-inventory', machine: 'mini', target },
  );
  const linked = pane('%4', { linkedSlotId: 'mini-ff-1', active: true });
  assert.deepEqual(
    resolveTerminalWorkerRef({
      selector,
      run: null,
      slotMachine: 'mini',
      inventory: inventory('mini', [
        pane('%2', { linkedSlotId: 'mini-ff-2', active: true }),
        pane('%3', { linkedSlotId: 'mini-ff-1' }),
        linked,
      ]),
    }),
    { status: 'ready', worker: linked.ref, target },
  );
});

test("a native run's slot shell opens the slot's own session", () => {
  const run = makeRun({ transport: 'native', agentContexts: [context({})] });
  const selector = { slotId: 'mini-ff-1', runId: 'run-1' };
  assert.deepEqual(
    resolveTerminalWorkerRef({ selector, run, slotMachine: 'mini', inventory: undefined }),
    { status: 'native' },
  );
  assert.deepEqual(
    resolveTerminalWorkerRef({
      selector: { ...selector, shell: true },
      run,
      slotMachine: 'mini',
      inventory: undefined,
    }),
    {
      status: 'needs-inventory',
      machine: 'mini',
      target: { slotId: 'mini-ff-1', bareSession: true },
    },
  );
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
  const target = { slotId: '', runId: 'run-2' };
  assert.deepEqual(
    resolveTerminalWorkerRef({ selector, run, slotMachine: undefined, inventory: undefined }),
    { status: 'needs-inventory', machine: 'macpro', target },
  );
  const shell = pane(
    '%5',
    { linkedRunId: 'run-2' },
    { nodeId: 'macpro', session: 'review-shell-ws-1' },
  );
  assert.deepEqual(
    resolveTerminalWorkerRef({
      selector,
      run,
      slotMachine: undefined,
      inventory: inventory('macpro', [pane('%1'), shell]),
    }),
    { status: 'ready', worker: shell.ref, target },
  );
});

test('a missing session asks for terminal.reinit with the target the gateway knows', () => {
  // Hidden panes elsewhere on the machine do not stop the reinit; the screen says "hidden"
  // only when the pane is still missing after it.
  assert.deepEqual(
    resolveTerminalWorkerRef({
      selector: { slotId: 'mini-ff-1' },
      run: null,
      slotMachine: 'mini',
      inventory: inventory('mini', [pane('%2', { linkedSlotId: 'mini-ff-2' })], {
        hiddenWorkers: 2,
      }),
    }),
    { status: 'no-pane', machine: 'mini', hidden: true, target: { slotId: 'mini-ff-1' } },
  );
  // A finished run pinned to its slot opens the slot's own session, as the old screen did.
  assert.deepEqual(
    resolveTerminalWorkerRef({
      selector: { slotId: 'mini-ff-1', runId: 'run-1' },
      run: makeRun({ status: 'done' }),
      slotMachine: 'mini',
      inventory: inventory('mini', []),
    }),
    {
      status: 'no-pane',
      machine: 'mini',
      hidden: false,
      target: { slotId: 'mini-ff-1', bareSession: true },
    },
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

test('a gone pin, an offline machine and a loading run never open a pane', () => {
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
      run: undefined,
      slotMachine: 'mini',
      inventory: undefined,
    }),
    { status: 'waiting', reason: 'Loading…' },
  );
});

test('a CI-fix context saved as session:window with no window field opens that window', () => {
  // services/gateway/src/ci-monitor/inline-fix.ts saves {session, window: null, pane: null,
  // target}; the pane shown and typed into must be the one Send names.
  const run = makeRun({
    agentContexts: [
      context({
        id: 'ci-fix-1',
        role: 'ci-fix',
        target: { session: 'mini-ff-1', window: null, pane: null, target: 'mini-ff-1:dev' },
      }),
    ],
  });
  const shell = pane('%8', { linkedSlotId: 'mini-ff-1', active: true }, { windowName: 'shell' });
  const dev = pane('%9', { linkedSlotId: 'mini-ff-1' }, { windowName: 'dev', window: '1' });
  const resolved = resolveTerminalWorkerRef({
    selector: { slotId: 'mini-ff-1', runId: 'run-1', contextId: 'ci-fix-1' },
    run,
    slotMachine: 'mini',
    inventory: inventory('mini', [shell, dev]),
  });
  assert.equal(resolved.status === 'ready' && resolved.worker.target, '%9');
  assert.deepEqual(resolved.status === 'ready' && resolved.target, {
    slotId: 'mini-ff-1',
    runId: 'run-1',
    contextId: 'ci-fix-1',
    role: 'ci-fix',
  });
});

test('a native reviewer on a review worktree opens its conversation, not the worktree shell', () => {
  const run = makeRun({
    id: 'run-2',
    slotId: null,
    transport: 'native',
    reviewWorkspace: {
      workspaceId: 'ws-1',
      machine: 'macpro',
      executionNodeId: 'local',
      checkoutPath: '/w',
      taskPath: '/t',
      artifactPath: '/a',
    },
    agentContexts: [context({ id: 'rev-1', role: 'review', slotId: null, runId: 'run-2' })],
  });
  assert.deepEqual(
    resolveTerminalWorkerRef({
      selector: { runId: 'run-2' },
      run,
      slotMachine: undefined,
      inventory: undefined,
    }),
    { status: 'native' },
  );
});
