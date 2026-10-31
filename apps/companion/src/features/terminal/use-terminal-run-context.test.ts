import assert from 'node:assert/strict';
import test from 'node:test';

import { Methods, type Run, type RunGetResult } from '@farmslot/protocol';
import {
  canActOn,
  createGatewayResourceCache,
  type ResourceQuery,
  resourceQuery,
  type ResourceQueryState,
} from '@farmslot/protocol/client-cache';

import { ResourceCacheConformanceTransport } from '../../../../../packages/protocol/src/client-cache/conformance';
import { mountHook } from '../../hooks/hook-harness.fixtures';
import { currentFarmConnection } from '../../lib/connection-authority';
import { heldDataUsable } from '../../lib/resource-read-status';
import {
  buildCompanionTerminalTarget,
  type CompanionTerminalTargetParams,
  shouldUseBareTerminalSessionForRun,
} from '../../lib/terminal-target';

import type { useTerminalRunContext } from './use-terminal-run-context';

type Context = ReturnType<typeof useTerminalRunContext>;

/** Connected, or still inside the shared reconnect grace. */
const held = { current: true };

test('terminal commands use current canonical inputs without rereads while the stream survives invalidation', async () => {
  const transport = new ResourceCacheConformanceTransport({ gatewayUrl: 'ws://terminal.invalid/' });
  transport.setConnection({ connected: true, id: 1 });
  let workspaceKey = 'first-owner';
  let hold = false;
  let revision = 0;
  let reads = 0;
  const run = {
    id: 'run-a',
    slotId: 'slot-a',
    status: 'monitoring',
    decisions: [],
  } as unknown as Run;
  transport.request = async <T>(method: Parameters<typeof resourceQuery>[0], params: unknown) => {
    reads++;
    if (hold) return new Promise<never>(() => undefined);
    const query = resourceQuery(method, params);
    return {
      data: (method === Methods.RUN_RECIPE_RUNS_FOR_RUN
        ? { recipeRuns: [], selectedRecipeRunId: null }
        : { run }) as T,
      resourceState: {
        epoch: 'conformance-epoch',
        dependencies: query.dependencies.map((key) => ({ key, revision })),
      },
    };
  };
  const cache = createGatewayResourceCache({ transport });
  const client = {
    connectionGeneration: 1,
    connectionState: 'connected',
    workspaceAccess: 'farm',
    authenticatedPrincipal: { id: 'operator' },
  };
  const authority = { client, status: 'connected', activeProfileId: 'first', authorityEpoch: 0 };
  const stops = new Map<string, () => void>();
  const useConnectionStore = Object.assign(
    (select: (state: typeof authority) => unknown) => select(authority),
    { getState: () => authority },
  );
  const hook = mountHook<[CompanionTerminalTargetParams]>(
    new URL('./use-terminal-run-context.ts', import.meta.url),
    'useTerminalRunContext',
    {
      '@farmslot/protocol': { Methods },
      '@farmslot/protocol/client-cache': { canActOn, resourceQuery },
      '../../farmslot/run-collections-proof': { observeNativeSlotFrame: () => undefined },
      '../../hooks/useResourceQuery': {
        useResourceQuery(query?: ResourceQuery<unknown>) {
          if (!query) return { status: 'loading' };
          if (!stops.has(query.id))
            stops.set(
              query.id,
              cache.observe(query, () => undefined),
            );
          return cache.read(query);
        },
      },
      '../../lib/connection-authority': { currentFarmConnection },
      '../../lib/resource-cache': {
        getResourceCache: () => cache,
        getResourceWorkspaceAccess: () => 'farm',
        getResourceWorkspaceKey: () => workspaceKey,
      },
      '../../lib/run-collections': {
        assertNativeRunReady(runId: string, expected?: Run) {
          const state = cache.read(resourceQuery<RunGetResult>(Methods.RUN_GET, { runId }));
          if (!canActOn(state, true) || !state.data || state.data.run !== expected)
            throw new Error('Wait for the current run');
          return state.data.run;
        },
      },
      '../../lib/terminal-target': {
        buildCompanionTerminalTarget,
        shouldUseBareTerminalSessionForRun,
      },
      '../../store/connection': { useConnectionStore },
      '../../lib/resource-read-status': { heldDataUsable },
      '../../store/held-connection': {
        useHeldConnection: () => held.current,
        heldConnectionCurrent: () => held.current,
      },
      '../native-conversation/use-slot-native-session': {
        useSlotNativeSession(
          _run: Run | null,
          slotId: string,
          contextId: string | undefined,
          runId: string | undefined,
          options: { bareSession: boolean },
        ) {
          return {
            contextId: contextId ?? '',
            target: undefined,
            terminalTarget: buildCompanionTerminalTarget({
              slotId,
              runId,
              contextId,
              bareSession: options.bareSession,
            }),
          };
        },
      },
    },
  );
  const render = (params: CompanionTerminalTargetParams = { slotId: 'slot-a' }) =>
    hook.render(params) as Context;
  const flush = async () => {
    for (let i = 0; i < 12; i++) await new Promise<void>((resolve) => setImmediate(resolve));
  };
  try {
    render();
    await flush();
    render();
    await flush();
    const ready = render();
    assert.equal(ready.ready, true);
    assert.equal(ready.streamReady, true);
    assert.equal(ready.targetRun, run);
    assert.equal(ready.recipes.status, 'ready');
    const readCount = reads;
    assert.equal(ready.requireRun(), run);
    assert.equal(
      reads,
      readCount,
      'Command preconditions inspect shared reads, without issuing another run RPC',
    );
    assert.deepEqual(ready.target, { slotId: 'slot-a', runId: 'run-a' });
    const captured = ready.capture();
    hold = true;
    revision++;
    transport.publish({
      version: 1,
      epoch: 'conformance-epoch',
      changes: [{ key: { family: 'run', runId: 'run-a' }, revision, kind: 'updated' }],
    });
    await flush();
    // Saved data is the normal state: a reread never holds back a command.
    assert.equal(ready.requireRun(), run, 'Commands act on held data while it rereads');
    const stale = render();
    assert.equal(stale.ready, false);
    assert.equal(
      stale.streamReady,
      true,
      'A stale observation does not repeatedly tear down the admitted terminal stream',
    );
    // Pixel 6 typing arrived duplicated or dropped while each reread disabled input.
    assert.equal(stale.inputReady, true, 'Typing keeps reaching the admitted stream');
    assert.doesNotThrow(() => stale.requireInput());
    // A short reconnect keeps typing on for the same target: keys queue until it is back.
    client.connectionGeneration++;
    assert.doesNotThrow(() => stale.requireInput());
    assert.equal(captured.current(), false);
    assert.equal(
      captured.ownsView(),
      true,
      'Busy cleanup still belongs to this view after losing its connection',
    );
    const reconnected = render();
    assert.equal(reconnected.streamReady, false, 'A new connection needs another current read');
    assert.equal(reconnected.inputReady, true, 'Typing survives a short reconnect');
    // Offline past the grace, typing stops.
    held.current = false;
    assert.equal(render().inputReady, false);
    assert.throws(() => stale.requireInput(), /before typing/);
    held.current = true;
    workspaceKey = 'second-owner';
    authority.authorityEpoch++;
    render();
    assert.equal(captured.ownsView(), false);
    assert.throws(() => ready.requireRun(), /current terminal run/);
    const pinned = render({ slotId: 'slot-a', runId: 'run-a', contextId: 'exact-reviewer' });
    assert(pinned.target);
    assert.equal(pinned.target.contextId, 'exact-reviewer');
    assert.equal(pinned.target.runId, 'run-a');
    assert.equal(
      pinned.target.bareSession,
      undefined,
      'An explicit actor pin never falls back to a bare slot session',
    );
    const actorCapture = pinned.capture();
    render({ slotId: 'slot-a', runId: 'run-a', contextId: 'another-actor' });
    assert.equal(
      actorCapture.ownsView(),
      false,
      'An earlier actor cannot clear the next actor command state',
    );
    assert.throws(() => pinned.requireRun(), /current terminal run/);
  } finally {
    hook.cleanup();
    for (const stop of stops.values()) stop();
    await cache.dispose();
  }
});

test('saved terminal run data stops typing until a current read', () => {
  const run: Run = {
    id: 'run-a',
    familyId: 'run-a',
    lane: 'production',
    flowType: 'dev',
    status: 'monitoring',
    project: 'example',
    ticketOrPr: 'EX-1',
    slotId: 'slot-a',
    branch: 'ex-1',
    taskFile: null,
    steps: [],
    decisions: [],
    metrics: { runner: 'codex', model: 'gpt-5.5', nudgeCount: 0 },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:01:00.000Z',
  };
  const runQuery = resourceQuery<RunGetResult>(Methods.RUN_GET, { runId: 'run-a' });
  let runState: ResourceQueryState<RunGetResult> = {
    status: 'ready',
    data: { run },
    observedAt: 1_000,
  };
  const client = { connectionGeneration: 1, connectionState: 'connected', workspaceAccess: 'farm' };
  const authority = { client, status: 'connected', activeProfileId: 'first', authorityEpoch: 0 };
  const useConnectionStore = Object.assign(
    (select: (state: typeof authority) => unknown) => select(authority),
    { getState: () => authority },
  );
  const read = (query?: ResourceQuery<unknown>): ResourceQueryState<unknown> =>
    query?.id === runQuery.id ? runState : { status: 'ready', data: { recipeRuns: [] } };
  const hook = mountHook<[CompanionTerminalTargetParams]>(
    new URL('./use-terminal-run-context.ts', import.meta.url),
    'useTerminalRunContext',
    {
      '@farmslot/protocol': { Methods },
      '@farmslot/protocol/client-cache': { canActOn, resourceQuery },
      '../../farmslot/run-collections-proof': { observeNativeSlotFrame: () => undefined },
      '../../hooks/useResourceQuery': { useResourceQuery: read },
      '../../lib/connection-authority': { currentFarmConnection },
      '../../lib/resource-cache': {
        getResourceCache: () => ({ read }),
        getResourceWorkspaceAccess: () => 'farm',
        getResourceWorkspaceKey: () => 'owner',
      },
      '../../lib/run-collections': { assertNativeRunReady: () => run },
      '../../lib/terminal-target': {
        buildCompanionTerminalTarget,
        shouldUseBareTerminalSessionForRun,
      },
      '../../store/connection': { useConnectionStore },
      '../../lib/resource-read-status': { heldDataUsable },
      '../../store/held-connection': {
        useHeldConnection: () => held.current,
        heldConnectionCurrent: () => held.current,
      },
      '../native-conversation/use-slot-native-session': {
        useSlotNativeSession: (
          _run: Run | null,
          slotId: string,
          contextId?: string,
          runId?: string,
        ) => ({
          contextId: contextId ?? '',
          target: undefined,
          terminalTarget: buildCompanionTerminalTarget({
            slotId,
            runId,
            contextId,
            bareSession: false,
          }),
        }),
      },
    },
  );
  const render = () => hook.render({ slotId: 'slot-a', runId: 'run-a' }) as Context;
  try {
    assert.equal(render().inputReady, true);
    // A failed reread leaves saved data: typing stops even though the stream stays admitted.
    runState = {
      status: 'stale',
      data: { run },
      observedAt: 1_000,
      error: { code: 'UNAVAILABLE', message: 'Gateway unavailable' },
    };
    const saved = render();
    assert.equal(saved.streamReady, true);
    assert.equal(saved.inputReady, false);
    assert.throws(() => saved.requireInput(), /before typing/);
  } finally {
    hook.cleanup();
  }
});
