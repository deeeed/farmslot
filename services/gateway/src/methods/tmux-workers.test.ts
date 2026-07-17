import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { FleetStatus, NodeTmuxPane, PoolConfig, Run } from '@farmslot/protocol';

import {
  buildSessionCorrelation,
  tmuxWorkerAllowedByConfig,
  tmuxWorkerFromNodePane,
} from './tmux-workers.js';

function fleet(): FleetStatus {
  return {
    checkedAt: '2026-05-22T00:00:00.000Z',
    slots: [
      {
        slot: 'runner-mobile-1',
        machine: 'runner-local',
        platform: 'ios',
        project: 'example-mobile',
        health: { ssh: 'LOCAL', device: '-', devserver: '-', cdp: '-', fixtures: '-' },
        branch: 'main',
        agent: 'working',
        enabled: true,
        dispatchable: false,
        lifecycle: 'busy',
        phase: 'working',
        warm: false,
        taskId: null,
        taskFile: null,
        currentRunId: 'run-1',
        currentFamilyId: 'family-1',
        dispatchedAt: null,
        completedAt: null,
        runner: 'codex',
        model: 'gpt-5.5',
        deviceName: null,
        taskPhase: null,
        taskStepProgress: null,
      },
    ],
    summary: {
      total: 1,
      ready: 0,
      busy: 1,
      held: 0,
      manual: 0,
      disabled: 0,
      blocked: 0,
      warmCount: 0,
    },
  };
}

test('buildSessionCorrelation maps pool sessions to active run and family metadata', () => {
  const pools: PoolConfig[] = [
    {
      machine: 'runner-local',
      project: 'example-mobile',
      platform: 'ios',
      os: 'darwin',
      host: 'localhost',
      sshUser: 'example',
      slots: [
        {
          id: 'runner-mobile-1',
          enabled: true,
          mode: 'dispatch',
          project: 'example-mobile',
          repo: '/repo',
          session: 'mm-1',
        },
      ],
    },
  ];

  assert.deepEqual(buildSessionCorrelation(pools, fleet()).get('runner-local')?.get('mm-1'), {
    slotId: 'runner-mobile-1',
    runId: 'run-1',
    familyId: 'family-1',
    activityHint: 'active',
  });
});

test('buildSessionCorrelation falls back to active run store data when fleet slot state is stale', () => {
  const pools: PoolConfig[] = [
    {
      machine: 'runner-local',
      project: 'example-mobile',
      platform: 'ios',
      os: 'darwin',
      host: 'localhost',
      sshUser: 'example',
      slots: [
        {
          id: 'runner-mobile-1',
          enabled: true,
          mode: 'dispatch',
          project: 'example-mobile',
          repo: '/repo',
          session: 'mm-1',
        },
      ],
    },
  ];
  const staleFleet = {
    ...fleet(),
    slots: [
      {
        ...fleet().slots[0],
        lifecycle: 'ready' as const,
        currentRunId: null,
        currentFamilyId: null,
      },
    ],
  };

  assert.deepEqual(
    buildSessionCorrelation(pools, staleFleet, [
      {
        id: 'run-active',
        familyId: 'family-active',
        status: 'self-reviewing',
        slotId: 'runner-mobile-1',
      } as Run,
    ])
      .get('runner-local')
      ?.get('mm-1'),
    {
      slotId: 'runner-mobile-1',
      runId: 'run-active',
      familyId: 'family-active',
      activityHint: 'active',
    },
  );
});

test('buildSessionCorrelation captures the active run runner for per-runner pane-retirement', () => {
  const pools: PoolConfig[] = [
    {
      machine: 'runner-local',
      project: 'example-mobile',
      platform: 'ios',
      os: 'darwin',
      host: 'localhost',
      sshUser: 'example',
      slots: [
        {
          id: 'runner-mobile-1',
          enabled: true,
          mode: 'dispatch',
          project: 'example-mobile',
          repo: '/repo',
          session: 'mm-1',
        },
      ],
    },
  ];
  const staleFleet = {
    ...fleet(),
    slots: [{ ...fleet().slots[0], lifecycle: 'ready' as const, currentRunId: null }],
  };

  const correlation = buildSessionCorrelation(pools, staleFleet, [
    {
      id: 'run-active',
      status: 'self-reviewing',
      slotId: 'runner-mobile-1',
      metrics: { runner: 'claude' },
    } as Run,
  ])
    .get('runner-local')
    ?.get('mm-1');

  assert.equal(correlation?.runner, 'claude');
});

test('buildSessionCorrelation records the worker pane from the primary agent context', () => {
  const pools: PoolConfig[] = [
    {
      machine: 'runner-local',
      project: 'example-mobile',
      platform: 'ios',
      os: 'darwin',
      host: 'localhost',
      sshUser: 'example',
      slots: [
        {
          id: 'runner-mobile-1',
          enabled: true,
          mode: 'dispatch',
          project: 'example-mobile',
          repo: '/repo',
          session: 'mm-1',
        },
      ],
    },
  ];
  const staleFleet = {
    ...fleet(),
    slots: [{ ...fleet().slots[0], lifecycle: 'ready' as const, currentRunId: null }],
  };

  const correlation = buildSessionCorrelation(pools, staleFleet, [
    {
      id: 'run-active',
      status: 'self-reviewing',
      slotId: 'runner-mobile-1',
      metrics: { runner: 'claude' },
      agentContexts: [
        {
          id: 'ctx-1',
          role: 'primary',
          label: 'worker',
          status: 'working',
          slotId: 'runner-mobile-1',
          runId: 'run-active',
          target: { session: 'mm-1', window: '3', pane: '%42', target: 'mm-1:3.%42' },
        },
      ],
    } as Run,
  ])
    .get('runner-local')
    ?.get('mm-1');

  assert.equal(correlation?.workerTarget, 'mm-1:3.%42');
  assert.equal(correlation?.workerWindow, '3');
  assert.equal(correlation?.workerPaneId, '%42');
});

test('tmuxWorkerFromNodePane scopes observability-degraded to the worker pane only', (t) => {
  t.after(() => {
    delete process.env.FARMSLOT_OBS_PANE_RETIRED;
  });
  process.env.FARMSLOT_OBS_PANE_RETIRED = '1';
  const observedAt = 2_000_000_000_000;
  const stale = { hook: { label: 'hook Stop', observedAt: observedAt - 300_000 } };
  const correlation = {
    slotId: 'runner-mobile-1',
    runId: 'run-active',
    runner: 'claude',
    workerTarget: 'mm-1:3.%42',
    workerWindow: '3',
    workerPaneId: '%42',
  };

  // The worker pane (matching target) surfaces the degraded alert under the flag.
  const workerPane: NodeTmuxPane = {
    session: 'mm-1',
    window: '3',
    pane: '0',
    paneId: '%42',
    target: 'mm-1:3.%42',
    command: 'claude',
    signals: stale,
  };
  const worker = tmuxWorkerFromNodePane({
    nodeId: 'runner-local',
    pane: workerPane,
    observedAt,
    correlation,
  });
  assert.equal(worker.status.attentionReason, 'observability-degraded');

  // A shell/reviewer pane in the SAME session is NOT the worker → no false degraded alert.
  const shellPane: NodeTmuxPane = {
    session: 'mm-1',
    window: '1',
    pane: '0',
    paneId: '%9',
    target: 'mm-1:1.%9',
    command: 'zsh',
    signals: stale,
  };
  const shell = tmuxWorkerFromNodePane({
    nodeId: 'runner-local',
    pane: shellPane,
    observedAt,
    correlation,
  });
  assert.notEqual(shell.status.attentionReason, 'observability-degraded');
  assert.equal(shell.status.attentionReason, 'stale-signal');
});

test('tmuxWorkerFromNodePane preserves node tmux identity and optional correlation', () => {
  const pane: NodeTmuxPane = {
    session: 'omx-session',
    window: '0',
    windowName: 'worker',
    pane: '1',
    paneId: '%7',
    target: '%7',
    active: true,
    width: 100,
    height: 30,
    title: 'codex',
    cwd: '/repo',
    command: 'codex',
    pid: 123,
    branch: 'feature/mobile',
    lastChangedAt: 1779411210000,
  };

  assert.deepEqual(
    tmuxWorkerFromNodePane({
      nodeId: 'runner-local',
      pane,
      observedAt: 1779411227000,
      correlation: { slotId: 'runner-mobile-1', runId: 'run-1', familyId: 'family-1' },
    }),
    {
      ref: {
        nodeId: 'runner-local',
        session: 'omx-session',
        window: '0',
        windowName: 'worker',
        pane: '1',
        paneId: '%7',
        target: '%7',
      },
      title: 'codex',
      cwd: '/repo',
      command: 'codex',
      pid: 123,
      branch: 'feature/mobile',
      lastChangedAt: 1779411210000,
      width: 100,
      height: 30,
      active: true,
      linkedSlotId: 'runner-mobile-1',
      linkedRunId: 'run-1',
      linkedFamilyId: 'family-1',
      status: {
        label: 'codex in tmux',
        source: 'tmux',
        confidence: 'medium',
        observedAt: 1779411227000,
        state: 'active',
      },
    },
  );
});

test('active slot correlations prevent stable panes from being misclassified as stale', () => {
  const worker = tmuxWorkerFromNodePane({
    nodeId: 'runner-local',
    observedAt: 1779411527000,
    pane: {
      session: 'mm-1',
      window: '0',
      pane: '0',
      target: '%1',
      command: 'claude.exe',
      lastChangedAt: 1779411227000,
    },
    correlation: {
      slotId: 'runner-mobile-1',
      runId: 'run-1',
      familyId: 'family-1',
      activityHint: 'active',
    },
  });

  assert.equal(worker.status.state, 'active');
});

test('buildTmuxWorkerListFromSources returns healthy workers and degraded node rows', async () => {
  const { buildTmuxWorkerListFromSources } = await import('./tmux-workers.js');
  const pools: PoolConfig[] = [
    {
      machine: 'healthy',
      project: 'farm',
      platform: 'mac',
      os: 'darwin',
      host: 'healthy.local',
      sshUser: 'example',
      slots: [],
    },
    {
      machine: 'offline',
      project: 'farm',
      platform: 'mac',
      os: 'darwin',
      host: 'offline.local',
      sshUser: 'example',
      slots: [],
    },
    {
      machine: 'degraded',
      project: 'farm',
      platform: 'mac',
      os: 'darwin',
      host: 'degraded.local',
      sshUser: 'example',
      slots: [],
    },
  ];

  const result = await buildTmuxWorkerListFromSources({
    pools,
    fleet: { ...fleet(), slots: [] },
    nodeIds: ['healthy', 'offline', 'degraded'],
    connectedNodeIds: new Set(['healthy', 'degraded']),
    observedAt: 1779411227000,
    requestPanes: async (nodeId) => {
      if (nodeId === 'degraded') throw new Error('tmux failed');
      return [
        {
          session: `${nodeId}-session`,
          window: '0',
          pane: '0',
          target: `%${nodeId}`,
          command: 'zsh',
        },
      ];
    },
  });

  assert.equal(result.nodes.length, 3);
  assert.equal(result.workers.length, 1);
  assert.deepEqual(
    result.nodes.map((node) => ({
      nodeId: node.nodeId,
      connected: node.connected,
      ok: node.ok,
      error: node.error,
      summary: node.summary,
    })),
    [
      {
        nodeId: 'degraded',
        connected: true,
        ok: false,
        error: 'tmux failed',
        summary: { panes: 0, active: 0, waiting: 0, idle: 0, stale: 0, unknown: 0 },
      },
      {
        nodeId: 'healthy',
        connected: true,
        ok: true,
        error: undefined,
        summary: { panes: 1, active: 0, waiting: 0, idle: 0, stale: 0, unknown: 1 },
      },
      {
        nodeId: 'offline',
        connected: false,
        ok: false,
        error: 'node offline is not connected',
        summary: { panes: 0, active: 0, waiting: 0, idle: 0, stale: 0, unknown: 0 },
      },
    ],
  );
});

test('tmux worker inventory applies optional pool include and exclude filters', async () => {
  const { buildTmuxWorkerListFromSources } = await import('./tmux-workers.js');
  const pools: PoolConfig[] = [
    {
      machine: 'runner-local',
      project: 'farm',
      platform: 'mac',
      os: 'darwin',
      host: 'localhost',
      sshUser: 'example',
      tmuxWorkers: {
        include: [{ session: 'omx-*' }, { linkedSlotId: 'runner-local-keep-*' }],
        exclude: [{ cwd: '/Users/example/dev/example-app/*' }, { command: 'node' }],
      },
      slots: [
        {
          id: 'runner-local-keep-1',
          enabled: true,
          mode: 'dispatch',
          project: 'farm',
          repo: '/repo',
          session: 'keep-slot',
        },
      ],
    },
  ];

  const result = await buildTmuxWorkerListFromSources({
    pools,
    fleet: {
      ...fleet(),
      slots: [
        {
          ...fleet().slots[0],
          slot: 'runner-local-keep-1',
          machine: 'runner-local',
          currentRunId: null,
          currentFamilyId: null,
        },
      ],
    },
    nodeIds: ['runner-local'],
    connectedNodeIds: new Set(['runner-local']),
    observedAt: 1779411227000,
    requestPanes: async () => [
      {
        session: 'omx-task',
        window: '1',
        pane: '1',
        target: '%1',
        cwd: '/Users/example/dev/farmslot',
        command: 'bash',
      },
      {
        session: 'keep-slot',
        window: '1',
        pane: '1',
        target: '%2',
        cwd: '/Users/example/dev/farmslot',
        command: 'zsh',
      },
      {
        session: 'omx-example-app',
        window: '1',
        pane: '1',
        target: '%3',
        cwd: '/Users/example/dev/example-app/mobile',
        command: 'bash',
      },
      {
        session: 'omc-node',
        window: '1',
        pane: '1',
        target: '%4',
        cwd: '/Users/example/dev/farmslot',
        command: 'node',
      },
      {
        session: 'plain-shell',
        window: '1',
        pane: '1',
        target: '%5',
        cwd: '/Users/example/dev/farmslot',
        command: 'bash',
      },
    ],
  });

  assert.deepEqual(
    result.workers.map((worker) => worker.ref.target),
    ['%1', '%2'],
  );
  assert.equal(result.hiddenWorkers, 3);
  assert.equal(result.nodes[0]?.hiddenWorkers, 3);
});

test('tmux worker filter rules use AND within one rule and exclude wins', () => {
  const base = tmuxWorkerFromNodePane({
    nodeId: 'runner-local',
    observedAt: 1,
    pane: {
      session: 'omx-task',
      window: '1',
      pane: '1',
      target: '%1',
      cwd: '/repo',
      command: 'bash',
    },
    correlation: { slotId: 'runner-mobile-1' },
  });

  assert.equal(
    tmuxWorkerAllowedByConfig({ include: [{ session: 'omx-*', cwd: '/repo' }] }, base),
    true,
  );
  assert.equal(
    tmuxWorkerAllowedByConfig({ include: [{ session: 'omx-*', cwd: '/other' }] }, base),
    false,
  );
  assert.equal(
    tmuxWorkerAllowedByConfig(
      { include: [{ session: 'omx-*' }], exclude: [{ linkedSlotId: 'runner-mobile-*' }] },
      base,
    ),
    false,
  );
});

test('buildTmuxWorkerUpdateFromNodeSnapshot rejects malformed pane snapshots', async () => {
  const { buildTmuxWorkerUpdateFromNodeSnapshot } = await import('./tmux-workers.js');

  await assert.rejects(
    buildTmuxWorkerUpdateFromNodeSnapshot({
      machine: 'runner-local',
      panes: { panes: [] },
    }),
    /invalid panes payload/,
  );
});

test('tmuxWorkerStatusFromPane prefers fresh hook/statusline signals and marks stale signals', async () => {
  const { tmuxWorkerStatusFromPane } = await import('./tmux-workers.js');
  const observedAt = 1779411229000;

  assert.deepEqual(
    tmuxWorkerStatusFromPane(
      {
        session: 's',
        window: '0',
        pane: '0',
        target: '%1',
        command: 'zsh',
        signals: { hook: { label: 'hook Stop', observedAt: observedAt - 1_000 } },
      },
      observedAt,
    ),
    {
      label: 'hook Stop',
      source: 'hook',
      confidence: 'high',
      observedAt: observedAt - 1_000,
      state: 'idle',
      requiresAttention: true,
      attentionReason: 'idle',
    },
  );

  assert.deepEqual(
    tmuxWorkerStatusFromPane(
      {
        session: 's',
        window: '0',
        pane: '0',
        target: '%1',
        command: 'zsh',
        signals: { statusline: { label: 'busy · sonnet', observedAt: observedAt - 1_000 } },
      },
      observedAt,
    ),
    {
      label: 'busy · sonnet',
      source: 'statusline',
      confidence: 'high',
      observedAt: observedAt - 1_000,
      state: 'active',
    },
  );

  assert.deepEqual(
    tmuxWorkerStatusFromPane(
      {
        session: 's',
        window: '0',
        pane: '0',
        target: '%1',
        command: 'zsh',
        signals: { hook: { label: 'hook Stop', observedAt: observedAt - 300_000 } },
      },
      observedAt,
    ),
    {
      label: 'hook Stop',
      source: 'hook',
      confidence: 'low',
      observedAt: observedAt - 300_000,
      stale: true,
      state: 'stale',
      requiresAttention: true,
      attentionReason: 'stale-signal',
    },
  );

  assert.deepEqual(
    tmuxWorkerStatusFromPane(
      {
        session: 's',
        window: '0',
        pane: '0',
        target: '%1',
        command: 'zsh',
        signals: { taskFile: { label: 'task running', observedAt: observedAt - 300_000 } },
        lastChangedAt: observedAt - 1_000,
      },
      observedAt,
      'active',
    ),
    {
      label: 'task running',
      source: 'task-file',
      confidence: 'low',
      observedAt: observedAt - 300_000,
      stale: true,
      state: 'stale',
      requiresAttention: true,
      attentionReason: 'stale-signal',
    },
  );

  assert.deepEqual(
    tmuxWorkerStatusFromPane(
      {
        session: 's',
        window: '0',
        pane: '0',
        target: '%1',
        command: 'claude',
        signals: {
          process: {
            label: 'process active · cpu 6.4%',
            observedAt: observedAt - 1_000,
            active: true,
            cpuPct: 6.4,
            runningProcesses: 1,
          },
        },
        lastChangedAt: observedAt - 300_000,
      },
      observedAt,
    ),
    {
      label: 'process active · cpu 6.4%',
      source: 'tmux',
      confidence: 'medium',
      observedAt: observedAt - 1_000,
      state: 'active',
    },
  );

  assert.deepEqual(
    tmuxWorkerStatusFromPane(
      {
        session: 's',
        window: '0',
        pane: '0',
        target: '%1',
        command: 'zsh',
        lastChangedAt: observedAt - 300_000,
      },
      observedAt,
    ),
    {
      label: 'zsh in tmux',
      source: 'tmux',
      confidence: 'medium',
      observedAt,
      state: 'idle',
    },
  );
});

test('tmuxWorkerStatusFromPane surfaces observability-degraded for stale hooks under the ADR-032 flag', async (t) => {
  const { tmuxWorkerStatusFromPane } = await import('./tmux-workers.js');
  const observedAt = 2_000_000_000_000;
  const stalePane = {
    session: 's',
    window: '0',
    pane: '0',
    target: '%1',
    command: 'claude',
    signals: { hook: { label: 'hook Stop', observedAt: observedAt - 300_000 } },
  };

  // Flag off → generic stale-signal (byte-identical to Phase 2), even with a runner.
  assert.equal(
    tmuxWorkerStatusFromPane(stalePane, observedAt, undefined, 'claude').attentionReason,
    'stale-signal',
  );

  t.after(() => {
    delete process.env.FARMSLOT_OBS_PANE_RETIRED;
  });
  process.env.FARMSLOT_OBS_PANE_RETIRED = '1';

  // Flag on + retired runner → hook-liveness lapse surfaces distinctly BEFORE a nudge is attempted.
  const degraded = tmuxWorkerStatusFromPane(stalePane, observedAt, undefined, 'claude');
  assert.equal(degraded.requiresAttention, true);
  assert.equal(degraded.attentionReason, 'observability-degraded');
  assert.equal(degraded.state, 'stale');

  // Without a runner the surface cannot scope per-runner → falls back to generic stale-signal.
  assert.equal(tmuxWorkerStatusFromPane(stalePane, observedAt).attentionReason, 'stale-signal');

  // Per-runner scoping: a pane-only runner (grok) is never retired, so it is not mislabeled.
  assert.equal(
    tmuxWorkerStatusFromPane(stalePane, observedAt, undefined, 'grok').attentionReason,
    'stale-signal',
  );
});

test('tmuxWorkerStatusFromPane degraded check is not masked by a fresh task-file signal under the flag', async (t) => {
  const { tmuxWorkerStatusFromPane } = await import('./tmux-workers.js');
  const observedAt = 2_000_000_000_000;
  // Stale hook, but a FRESH task-file signal that would otherwise win the branch order.
  const pane = {
    session: 's',
    window: '0',
    pane: '0',
    target: '%1',
    command: 'claude',
    signals: {
      hook: { label: 'hook Stop', observedAt: observedAt - 300_000 },
      taskFile: { label: 'task signal', observedAt: observedAt - 1_000 },
    },
  };

  t.after(() => {
    delete process.env.FARMSLOT_OBS_PANE_RETIRED;
  });

  // Flag off → the fresh task-file signal wins (byte-identical to Phase 2).
  const off = tmuxWorkerStatusFromPane(pane, observedAt, undefined, 'claude');
  assert.equal(off.source, 'task-file');

  // Flag on → observability-degraded surfaces before the fresh task-file can mask it.
  process.env.FARMSLOT_OBS_PANE_RETIRED = '1';
  const on = tmuxWorkerStatusFromPane(pane, observedAt, undefined, 'claude');
  assert.equal(on.attentionReason, 'observability-degraded');
});

test('tmuxWorkerStatusFromPane surfaces observability-degraded for entirely absent hooks under the flag', async (t) => {
  const { tmuxWorkerStatusFromPane } = await import('./tmux-workers.js');
  const observedAt = 2_000_000_000_000;
  // No hook/statusline signal at all — only a bare pane.
  const pane = {
    session: 's',
    window: '0',
    pane: '0',
    target: '%1',
    command: 'claude',
    signals: {},
  };

  t.after(() => {
    delete process.env.FARMSLOT_OBS_PANE_RETIRED;
  });
  process.env.FARMSLOT_OBS_PANE_RETIRED = '1';
  const on = tmuxWorkerStatusFromPane(pane, observedAt, undefined, 'claude');
  assert.equal(on.attentionReason, 'observability-degraded');
  assert.equal(on.state, 'stale');
});
