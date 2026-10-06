import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import type { Run } from '@farmslot/protocol';

import { colors } from '../../styles/theme-tokens.js';

import {
  filterRunList,
  isArchivableRun,
  RUN_STALE_AFTER_MS,
  runGradeColor,
  runProgressSummary,
  showsRunProgress,
} from './run-list-model.js';

function run(id: string, overrides: Partial<Run> = {}): Run {
  return {
    id,
    familyId: 'family-a',
    lane: 'production',
    flowType: 'fix-bug',
    status: 'done',
    project: 'project-a',
    ticketOrPr: `BUG-${id}`,
    slotId: null,
    branch: null,
    taskFile: null,
    steps: [],
    decisions: [],
    metrics: { nudgeCount: 0, runner: 'codex', model: 'gpt-5', durationMs: 0 },
    createdAt: '2026-05-14T00:00:00.000Z',
    updatedAt: '2026-05-14T00:00:00.000Z',
    ...overrides,
  } as Run;
}

function filter(overrides: Partial<Parameters<typeof filterRunList>[0]> = {}): readonly Run[] {
  return filterRunList({
    familyFilter: '',
    familyRuns: null,
    tagFilter: '',
    tagRuns: null,
    runs: [],
    globalFilters: { projects: [], machines: [] },
    tab: 'all',
    statusFilter: 'all',
    flowFilter: '',
    laneFilter: '',
    searchQuery: '',
    sortBy: 'newest',
    ...overrides,
  });
}

test('runGradeColor maps semantic grades to status colors', () => {
  assert.equal(runGradeColor('good'), colors.statusOk);
  assert.equal(runGradeColor('ok'), colors.statusWarn);
  assert.equal(runGradeColor('bad'), colors.statusFail);
  assert.equal(runGradeColor('unknown'), colors.textMuted);
});

test('filterRunList applies machine filters via slot id prefix', () => {
  const macwork = run('1', { slotId: 'macwork-mm-4', status: 'done' });
  const mini = run('2', { slotId: 'mini-mm-1', status: 'done' });
  const unslotted = run('3', { status: 'done' });

  assert.deepEqual(
    filter({
      runs: [macwork, mini, unslotted],
      globalFilters: { projects: [], machines: ['macwork'] },
      tab: 'history',
    }).map((item) => item.id),
    ['1'],
  );
});

test('filterRunList matches machine filter via find-slot selectedSlot when slotId is null', () => {
  const macwork = run('1', {
    slotId: null,
    status: 'preparing',
    steps: [
      {
        name: 'find-slot',
        status: 'done',
        outputs: { selectedSlot: 'macwork-ff-4' },
      },
    ],
  });
  const mini = run('2', { slotId: 'mini-mm-1', status: 'done' });

  assert.deepEqual(
    filter({
      runs: [macwork, mini],
      globalFilters: { projects: [], machines: ['macwork'] },
      tab: 'active',
    }).map((item) => item.id),
    ['1'],
  );
});

test('filterRunList applies family, project, tab, status, flow, lane, and search filters', () => {
  const matching = run('1', {
    status: 'failed',
    flowType: 'review-pr',
    lane: 'comparison',
    summary: 'Needs operator review',
  });
  const wrongProject = run('2', { project: 'project-b', status: 'failed' });
  const wrongFamily = run('3', { familyId: 'family-b', status: 'failed' });
  const done = run('4', { status: 'done', summary: 'Needs operator review' });

  assert.deepEqual(
    filter({
      runs: [wrongProject],
      familyFilter: 'family-a',
      familyRuns: [matching, wrongFamily, done],
      globalFilters: { projects: ['project-a'], machines: [] },
      tab: 'all',
      statusFilter: 'failed',
      flowFilter: 'review-pr',
      laneFilter: 'comparison',
      searchQuery: 'operator',
    }).map((item) => item.id),
    ['1'],
  );
});

test('filterRunList active and history tabs preserve legacy terminal-status semantics', () => {
  const active = run('active', { status: 'monitoring' });
  const failed = run('failed', { status: 'failed' });
  const done = run('done', { status: 'done' });

  assert.deepEqual(
    filter({ runs: [active, failed, done], tab: 'active', statusFilter: 'done' }).map(
      (item) => item.id,
    ),
    ['active', 'failed'],
  );
  assert.deepEqual(
    filter({ runs: [active, failed, done], tab: 'history' }).map((item) => item.id),
    ['failed', 'done'],
  );
});

test('filterRunList preserves the original run list reference when no filters or sort apply', () => {
  const runs = [run('one'), run('two')];

  assert.equal(filter({ runs }), runs);
});

test('filterRunList sorts by oldest, duration, and grade', () => {
  const low = run('low', {
    createdAt: '2026-05-14T02:00:00.000Z',
    metrics: { nudgeCount: 0, runner: 'codex', model: 'gpt-5', durationMs: 10 },
    humanGrade: { recipe_semantic: 'bad' } as Run['humanGrade'],
  });
  const high = run('high', {
    createdAt: '2026-05-14T01:00:00.000Z',
    metrics: { nudgeCount: 0, runner: 'codex', model: 'gpt-5', durationMs: 30 },
    humanGrade: { recipe_semantic: 'good' } as Run['humanGrade'],
  });
  const mid = run('mid', {
    createdAt: '2026-05-14T03:00:00.000Z',
    metrics: { nudgeCount: 0, runner: 'codex', model: 'gpt-5', durationMs: 20 },
    humanGrade: { recipe_semantic: 'ok' } as Run['humanGrade'],
  });

  assert.deepEqual(
    filter({ runs: [low, high, mid], sortBy: 'oldest' }).map((item) => item.id),
    ['high', 'low', 'mid'],
  );
  assert.deepEqual(
    filter({ runs: [low, high, mid], sortBy: 'duration' }).map((item) => item.id),
    ['high', 'mid', 'low'],
  );
  assert.deepEqual(
    filter({ runs: [low, high, mid], sortBy: 'grade' }).map((item) => item.id),
    ['high', 'mid', 'low'],
  );
});

test('filterRunList sorts inventory columns deterministically', () => {
  const zeta = run('zeta', {
    project: 'zeta-farm',
    flowType: 'review-pr',
    status: 'monitoring',
  });
  const alpha = run('alpha', {
    project: 'alpha-farm',
    flowType: 'dev',
    status: 'failed',
  });

  assert.deepEqual(
    filter({ runs: [zeta, alpha], sortBy: 'project' }).map((item) => item.id),
    ['alpha', 'zeta'],
  );
  assert.deepEqual(
    filter({ runs: [zeta, alpha], sortBy: 'flow' }).map((item) => item.id),
    ['alpha', 'zeta'],
  );
  assert.deepEqual(
    filter({ runs: [zeta, alpha], sortBy: 'status' }).map((item) => item.id),
    ['alpha', 'zeta'],
  );
  assert.deepEqual(
    filter({ runs: [zeta, alpha], sortBy: 'project-desc' }).map((item) => item.id),
    ['zeta', 'alpha'],
  );
  assert.deepEqual(
    filter({ runs: [zeta, alpha], sortBy: 'flow-desc' }).map((item) => item.id),
    ['zeta', 'alpha'],
  );
  assert.deepEqual(
    filter({ runs: [zeta, alpha], sortBy: 'status-desc' }).map((item) => item.id),
    ['zeta', 'alpha'],
  );
});

test('filterRunList sorts ref/slot/runner inventory columns (not newest)', () => {
  const a = run('a', {
    ticketOrPr: 'BUG-2',
    slotId: 'mini-ff-2',
    metrics: { nudgeCount: 0, runner: 'codex', model: 'gpt-5', durationMs: 0 },
  });
  const b = run('b', {
    ticketOrPr: 'BUG-1',
    slotId: 'mini-ff-1',
    metrics: { nudgeCount: 0, runner: 'claude', model: 'opus', durationMs: 0 },
  });
  assert.deepEqual(
    filter({ runs: [a, b], sortBy: 'ref' }).map((item) => item.id),
    ['b', 'a'],
  );
  assert.deepEqual(
    filter({ runs: [a, b], sortBy: 'slot' }).map((item) => item.id),
    ['b', 'a'],
  );
  assert.deepEqual(
    filter({ runs: [a, b], sortBy: 'runner' }).map((item) => item.id),
    ['b', 'a'],
  );
  assert.deepEqual(
    filter({ runs: [a, b], sortBy: 'ref-desc' }).map((item) => item.id),
    ['a', 'b'],
  );
});

test('filterRunList sorts Updated column by updatedAt not createdAt', () => {
  const olderUpdate = run('older-update', {
    createdAt: '2026-07-20T00:00:00.000Z',
    updatedAt: '2026-07-21T00:00:00.000Z',
  });
  const newerUpdate = run('newer-update', {
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
  });
  assert.deepEqual(
    filter({ runs: [olderUpdate, newerUpdate], sortBy: 'updated-desc' }).map((item) => item.id),
    ['newer-update', 'older-update'],
  );
  assert.deepEqual(
    filter({ runs: [olderUpdate, newerUpdate], sortBy: 'updated' }).map((item) => item.id),
    ['older-update', 'newer-update'],
  );
});

test('filterRunList applies exact tag filters and includes tags in text search', () => {
  const demo = run('demo', { tags: ['demo', 'launch-review'] });
  const other = run('other', { tags: ['regression'] });

  assert.deepEqual(
    filter({ runs: [demo, other], tagFilter: 'demo' }).map((item) => item.id),
    ['demo'],
  );
  assert.deepEqual(
    filter({ runs: [demo, other], searchQuery: 'launch' }).map((item) => item.id),
    ['demo'],
  );
});

test('isArchivableRun accepts terminal runs and settled blocked runs only', () => {
  const settledBlocked = {
    status: 'blocked' as const,
    steps: [{ name: 'monitor', status: 'done' as const }],
    decisions: [],
  };
  assert.equal(isArchivableRun(settledBlocked), true);
  assert.equal(isArchivableRun({ ...settledBlocked, status: 'done' }), true);
  assert.equal(
    isArchivableRun({
      ...settledBlocked,
      decisions: [
        {
          id: 'd',
          type: 'engine_human_gate',
          title: 't',
          description: 'd',
          actions: [],
          createdAt: '2026-09-19T00:00:00.000Z',
        },
      ],
    }),
    false,
    'a gate-blocked run is a live wait',
  );
  assert.equal(isArchivableRun({ ...settledBlocked, status: 'monitoring' }), false);
});

test('run progress: a pending gate names its primary action, however old', () => {
  const now = Date.parse('2026-05-14T05:00:00.000Z');
  const summary = runProgressSummary(
    run('gate', {
      status: 'blocked',
      steps: [{ name: 'ci-watch', status: 'running', startedAt: '2026-05-14T00:10:00.000Z' }],
      decisions: [
        {
          id: 'd1',
          type: 'engine_ci_timeout',
          title: 'CI made no progress',
          description: '',
          createdAt: '2026-05-14T01:00:00.000Z',
          actions: [
            { id: 'stop', label: 'Stop watching', style: 'secondary' },
            { id: 'keep', label: 'Keep watching', style: 'primary' },
          ],
        },
      ],
    } as Partial<Run>),
    now,
  );
  assert.equal(summary.kind, 'gate');
  assert.equal(summary.text, 'CI made no progress → Keep watching');
  assert.equal(summary.lastProgressAgo, '4h ago');
});

test('run progress: stale only after an hour with nothing pending', () => {
  const started = Date.parse('2026-05-14T01:00:00.000Z');
  const watching = run('watch', {
    status: 'ci-watching',
    // updatedAt moves on unrelated writes; it is not progress.
    updatedAt: '2026-05-14T01:59:00.000Z',
    steps: [
      {
        name: 'complete',
        status: 'done',
        startedAt: '2026-05-14T00:55:00.000Z',
        completedAt: '2026-05-14T01:00:00.000Z',
      },
      {
        name: 'ci-watch',
        status: 'running',
        detail: 'waiting for checks',
        startedAt: '2026-05-14T01:00:00.000Z',
      },
    ],
  } as Partial<Run>);
  const before = runProgressSummary(watching, started + RUN_STALE_AFTER_MS - 60_000);
  assert.equal(before.kind, 'step');
  assert.equal(before.text, 'ci-watch: waiting for checks');
  assert.equal(before.lastProgressAgo, '59m ago');
  const after = runProgressSummary(watching, started + RUN_STALE_AFTER_MS);
  assert.equal(after.kind, 'stale');
  assert.equal(after.text, 'Stale: no progress for 1h and nothing pending');
  const ciProgress = runProgressSummary(
    {
      ...watching,
      ciWatchState: {
        lastProgressAt: '2026-05-14T01:30:00.000Z',
        consecutiveAttempts: 0,
        totalAttempts: 0,
        skips: 0,
      },
    },
    started + RUN_STALE_AFTER_MS,
  );
  assert.equal(ciProgress.kind, 'step', 'CI-watch progress counts');
  assert.equal(ciProgress.lastProgressAgo, '30m ago');
});

test('run progress: a restart re-entering a step is not progress; a Resume is', () => {
  const now = Date.parse('2026-05-14T03:00:00.000Z');
  const ciWatch = (statusChangedAt: string) =>
    run('ci', {
      status: 'ci-watching',
      statusChangedAt,
      steps: [
        { name: 'complete', status: 'done', completedAt: '2026-05-14T01:00:00.000Z' },
        // Re-entered at 02:59, by a gateway restart or by a Resume.
        { name: 'ci-watch', status: 'running', startedAt: '2026-05-14T02:59:00.000Z' },
      ],
      ciWatchState: {
        lastProgressAt: '2026-05-14T01:30:00.000Z',
        consecutiveAttempts: 0,
        totalAttempts: 0,
        skips: 0,
      },
    });
  // A restart re-applies the same status, so the status clock stays put.
  const restarted = runProgressSummary(ciWatch('2026-05-14T01:00:00.000Z'), now);
  assert.equal(restarted.kind, 'stale');
  assert.equal(restarted.lastProgressAgo, '1h ago');
  // A Resume after a two-hour pause changes the status.
  const resumed = runProgressSummary(ciWatch('2026-05-14T02:59:00.000Z'), now);
  assert.equal(resumed.kind, 'step');
  assert.equal(resumed.lastProgressAgo, '1m ago');
});

test('run progress: only runs that can still move show it', () => {
  assert.equal(showsRunProgress(run('active', { status: 'monitoring' })), true);
  assert.equal(showsRunProgress(run('done', { status: 'done' })), false);
  assert.equal(showsRunProgress(run('failed', { status: 'failed' })), false);
  // Blocked with nothing running or pending: the worker settled on blocked.
  assert.equal(
    showsRunProgress(
      run('settled', {
        status: 'blocked',
        steps: [{ name: 'monitor', status: 'done', completedAt: '2026-05-14T01:00:00.000Z' }],
      }),
    ),
    false,
  );
  assert.equal(
    showsRunProgress(
      run('gated', {
        status: 'blocked',
        decisions: [
          {
            id: 'd',
            type: 'engine_human_gate',
            title: 'Approve',
            description: '',
            createdAt: '2026-05-14T01:00:00.000Z',
            actions: [],
          },
        ],
      }),
    ),
    true,
  );
});

test('run progress: a finished interactive worker or a pause waits on the operator', () => {
  const now = Date.parse('2026-05-14T03:00:00.000Z');
  const held = runProgressSummary(
    run('held', {
      status: 'paused',
      steps: [
        {
          name: 'monitor',
          status: 'running',
          startedAt: '2026-05-14T00:00:00.000Z',
          // Held at 01:30, after a 90-minute task.
          durationMs: 90 * 60_000,
          detail: 'Worker finished; waiting for operator action',
          outputs: { awaitingOperator: true },
        },
      ],
    }),
    now,
  );
  assert.equal(held.kind, 'gate');
  assert.equal(held.text, 'Worker finished; waiting for operator action');
  assert.equal(held.lastProgressAgo, '1h ago');
  const paused = runProgressSummary(
    run('paused', {
      status: 'paused',
      steps: [{ name: 'monitor', status: 'running', startedAt: '2026-05-14T00:00:00.000Z' }],
    }),
    now,
  );
  assertMatchKind(paused, 'gate', 'Paused');
});

function assertMatchKind(
  summary: ReturnType<typeof runProgressSummary>,
  kind: string,
  text: string,
): void {
  assert.equal(summary.kind, kind);
  assert.equal(summary.text, text);
}
