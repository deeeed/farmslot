// analytics.test.ts — pipeline-ops analytics record builder + sink round-trip
// Usage: tsx services/gateway/src/runs/analytics.test.ts

import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import type { Run, RunStep } from '@farmslot/protocol';

process.env.NODE_ENV = 'test';
const testRoot = mkdtempSync(path.join(tmpdir(), 'farmslot-analytics-test-'));
process.env.FARMSLOT_ANALYTICS_DIR = path.join(testRoot, 'analytics');

const {
  buildAnalyticsRecord,
  appendAnalyticsRecord,
  readAllAnalyticsRecords,
  emitAnalyticsForTerminalRun,
  aggregateAnalytics,
} = await import('./analytics.js');

function step(
  name: string,
  status: RunStep['status'],
  startMs: number,
  endMs?: number,
  outputs?: Record<string, unknown>,
): RunStep {
  return {
    name,
    status,
    startedAt: new Date(startMs).toISOString(),
    completedAt: endMs != null ? new Date(endMs).toISOString() : undefined,
    durationMs: endMs != null ? endMs - startMs : undefined,
    outputs,
  };
}

function makeRun(overrides: Partial<Run> = {}): Run {
  const base = Date.parse('2026-06-22T10:00:00.000Z');
  return {
    id: 'run-1',
    familyId: 'fam-1',
    lane: 'production',
    flowType: 'fix-bug',
    status: 'done',
    project: 'demo-farm',
    ticketOrPr: 'DEMO-1',
    slotId: 'hostA-demo-1',
    branch: 'feature/x',
    taskFile: '.task/TASK.md',
    steps: [
      step('prepare', 'done', base, base + 60_000),
      step('monitor', 'done', base + 60_000, base + 660_000),
      step('self-review', 'done', base + 660_000, base + 960_000, { attempts: [{}, {}] }),
      step('ci-watch', 'done', base + 960_000, base + 1_560_000, {
        result: 'passed',
        pollCount: 3,
        inlineFixAttempts: 1,
      }),
    ],
    decisions: [],
    metrics: { nudgeCount: 2, model: 'opus', runner: 'claude', outcome: 'success' },
    createdAt: new Date(base).toISOString(),
    updatedAt: new Date(base + 1_800_000).toISOString(),
    completedAt: new Date(base + 1_800_000).toISOString(), // 30 min wall
    templateProvenance: {
      kind: 'task-template',
      flowType: 'fix-bug',
      project: 'demo-farm',
      role: 'worker',
      templatePath: 't.md',
      templateName: 'fix-bug',
      templateVariant: 'v2',
    },
    ...overrides,
  } as Run;
}

test('buildAnalyticsRecord flattens a clean done run', () => {
  const rec = buildAnalyticsRecord(makeRun());
  assert.equal(rec.status, 'done');
  assert.equal(rec.host, 'hostA');
  assert.equal(rec.failedStep, null);
  assert.equal(rec.failureReason, null);
  assert.equal(rec.wallMs, 1_800_000);
  // wall 1.8M − Σ steps (60k+600k+300k+600k = 1.56M) = 240k idle
  assert.equal(rec.idleMs, 240_000);
  assert.equal(rec.nudgeCount, 2);
  assert.equal(rec.selfReviewLoops, 2);
  assert.equal(rec.ciResult, 'passed');
  assert.equal(rec.ciPollCount, 3);
  assert.equal(rec.ciInlineFixAttempts, 1);
  assert.equal(rec.templateKey, 'fix-bug@v2');
  assert.equal(rec.steps.length, 4);
});

test('buildAnalyticsRecord captures worker tokens (by actual model); absent usage → null', () => {
  const withTokens = buildAnalyticsRecord(
    makeRun({
      id: 'tok-1',
      metrics: {
        nudgeCount: 0,
        model: 'opus',
        actualModel: 'claude-opus-4-8',
        runner: 'claude',
        outcome: 'success',
        sessionTotalTokens: 1260,
      },
    }),
  );
  assert.equal(withTokens.totalTokens, 1260);
  assert.deepEqual(withTokens.tokensByModel, { 'claude-opus-4-8': 1260 });

  // No usage reported → null total, empty by-model map.
  const noTokens = buildAnalyticsRecord(makeRun({ id: 'tok-0' }));
  assert.equal(noTokens.totalTokens, null);
  assert.deepEqual(noTokens.tokensByModel, {});
});

test('aggregateAnalytics rolls up token distribution and tokens-by-model', () => {
  const recs = [
    buildAnalyticsRecord(
      makeRun({
        id: 'agg-1',
        metrics: { nudgeCount: 0, model: 'opus', actualModel: 'opus', runner: 'claude' },
      }),
    ),
    buildAnalyticsRecord(
      makeRun({
        id: 'agg-2',
        metrics: {
          nudgeCount: 0,
          model: 'opus',
          actualModel: 'opus',
          runner: 'claude',
          sessionTotalTokens: 1000,
        },
      }),
    ),
    buildAnalyticsRecord(
      makeRun({
        id: 'agg-3',
        metrics: {
          nudgeCount: 0,
          model: 'sonnet',
          actualModel: 'sonnet',
          runner: 'claude',
          sessionTotalTokens: 500,
        },
      }),
    ),
  ];
  const res = aggregateAnalytics(recs, {}, '2026-06-22T00:00:00.000Z');
  // Distribution counts only runs that reported usage (n=2).
  assert.equal(res.tokens.n, 2);
  assert.equal(res.tokens.max, 1000);
  assert.deepEqual(res.tokensByModel, { opus: 1000, sonnet: 500 });
});

test('failure attribution: failed step + keyword-classified reason', () => {
  const base = Date.parse('2026-06-22T10:00:00.000Z');
  const rec = buildAnalyticsRecord(
    makeRun({
      status: 'failed',
      error: 'metro bundler timed out waiting for first response',
      steps: [step('prepare', 'failed', base, base + 30_000)],
      completedAt: new Date(base + 30_000).toISOString(),
    }),
  );
  assert.equal(rec.status, 'failed');
  assert.equal(rec.failedStep, 'prepare');
  assert.equal(rec.failureReason, 'metro-timeout');
});

test('failure attribution: explicit reason on step outputs wins over heuristic', () => {
  const base = Date.parse('2026-06-22T10:00:00.000Z');
  const rec = buildAnalyticsRecord(
    makeRun({
      status: 'failed',
      error: 'something about metro',
      steps: [step('prepare', 'failed', base, base + 30_000, { failureReason: 'dep-install' })],
      completedAt: new Date(base + 30_000).toISOString(),
    }),
  );
  assert.equal(rec.failureReason, 'dep-install');
});

test('failure attribution: invalid explicit reason falls back to heuristic, not the stray value', () => {
  const base = Date.parse('2026-06-22T10:00:00.000Z');
  const rec = buildAnalyticsRecord(
    makeRun({
      status: 'failed',
      error: 'metro bundler hung',
      steps: [step('prepare', 'failed', base, base + 30_000, { failureReason: 'not-a-real-code' })],
      completedAt: new Date(base + 30_000).toISOString(),
    }),
  );
  // The stray code is rejected; classification falls through to the keyword heuristic.
  assert.equal(rec.failureReason, 'metro-timeout');
});

test('cancelled run is attributed operator-cancelled', () => {
  const rec = buildAnalyticsRecord(makeRun({ status: 'cancelled' }));
  assert.equal(rec.failureReason, 'operator-cancelled');
});

test('sink append + read round-trips', async () => {
  await appendAnalyticsRecord(buildAnalyticsRecord(makeRun({ id: 'rt-1' })));
  const { records } = await readAllAnalyticsRecords();
  assert.ok(records.some((r) => r.runId === 'rt-1'));
});

test('emit is idempotent via analyticsEmittedAt', async () => {
  const run = makeRun({ id: 'idem-1' });
  const first = emitAnalyticsForTerminalRun(run);
  assert.ok(first); // returns an awaitable append promise on first emit
  await first;
  assert.ok(run.analyticsEmittedAt);
  assert.equal(emitAnalyticsForTerminalRun(run), null); // already emitted
});

test('non-terminal run is not emitted', () => {
  const run = makeRun({ id: 'active-1', status: 'monitoring', completedAt: undefined });
  assert.equal(emitAnalyticsForTerminalRun(run), null);
  assert.equal(run.analyticsEmittedAt, undefined);
});

test('aggregateAnalytics computes bottleneck, failures, filters, and dimensions', () => {
  const recs = [
    buildAnalyticsRecord(makeRun({ id: 'a1', project: 'p1', slotId: 'hostA-p1-1' })),
    buildAnalyticsRecord(makeRun({ id: 'a2', project: 'p2', slotId: 'hostB-p2-1' })),
    buildAnalyticsRecord(
      makeRun({
        id: 'a3',
        project: 'p1',
        slotId: 'hostA-p1-2',
        status: 'failed',
        error: 'merge conflict on rebase',
        steps: [
          {
            name: 'prepare',
            status: 'failed',
            startedAt: new Date(0).toISOString(),
            completedAt: new Date(10_000).toISOString(),
            durationMs: 10_000,
          },
        ],
        completedAt: new Date(10_000).toISOString(),
      }),
    ),
  ];
  const all = aggregateAnalytics(recs, {}, '2026-06-22T00:00:00.000Z', 2);
  assert.equal(all.matchedRuns, 3);
  assert.equal(all.byStatus.done, 2);
  assert.equal(all.byStatus.failed, 1);
  assert.equal(all.parseFailures, 2);
  assert.equal(all.byModel.opus, 3);
  assert.equal(all.byRunner.claude, 3);
  assert.equal(all.byTemplate['fix-bug@v2'], 3);
  assert.equal(all.failureByStep.prepare, 1);
  assert.equal(all.failureByReason['merge-conflict'], 1);
  assert.ok(all.bottleneck.find((b) => b.step === 'monitor'));
  assert.deepEqual(all.dimensions.projects, ['p1', 'p2']);
  assert.deepEqual(all.dimensions.hosts, ['hostA', 'hostB']);

  // Filter by project narrows the matched set but keeps full-corpus dimensions.
  const filtered = aggregateAnalytics(recs, { project: 'p1' }, '2026-06-22T00:00:00.000Z');
  assert.equal(filtered.matchedRuns, 2);
  assert.equal(filtered.scannedRuns, 3);
  assert.deepEqual(filtered.dimensions.projects, ['p1', 'p2']);
});

test('buildAnalyticsRecord tolerates a malformed run (missing steps/decisions/metrics)', () => {
  const bad = {
    id: 'bad-1',
    status: 'failed',
    project: 'p',
    flowType: 'fix-bug',
    lane: 'production',
    slotId: null,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(1000).toISOString(),
    completedAt: new Date(1000).toISOString(),
  } as unknown as Run;
  const rec = buildAnalyticsRecord(bad);
  assert.equal(rec.runId, 'bad-1');
  assert.equal(rec.nudgeCount, 0);
  assert.deepEqual(rec.steps, []);
  // The emit hook must never throw out of updateRun/archiveRun/deleteRun.
  assert.doesNotThrow(() => emitAnalyticsForTerminalRun(bad));
});

test('aggregateAnalytics dedups duplicate runId records (latest wins)', () => {
  const base = Date.parse('2026-06-22T10:00:00.000Z');
  const first = buildAnalyticsRecord(makeRun({ id: 'dup', status: 'done' }));
  const second = buildAnalyticsRecord(
    makeRun({
      id: 'dup',
      status: 'failed',
      steps: [step('prepare', 'failed', base, base + 1000)],
      completedAt: new Date(base + 1000).toISOString(),
    }),
  );
  const res = aggregateAnalytics([first, second], {}, '2026-06-22T00:00:00.000Z');
  assert.equal(res.matchedRuns, 1);
  assert.equal(res.scannedRuns, 1);
  assert.equal(res.byStatus.failed, 1);
  assert.equal(res.byStatus.done, undefined);
});

test('readAllAnalyticsRecords skips future-schema records and counts corrupt lines', async () => {
  const dir = process.env.FARMSLOT_ANALYTICS_DIR as string;
  await mkdir(dir, { recursive: true });
  const lines = [
    JSON.stringify(buildAnalyticsRecord(makeRun({ id: 'schema-cur' }))), // current schema
    JSON.stringify({
      ...buildAnalyticsRecord(makeRun({ id: 'schema-future' })),
      schemaVersion: 999,
    }),
    '{ not valid json', // corrupt
  ];
  await writeFile(path.join(dir, 'events-2099-01.ndjson'), `${lines.join('\n')}\n`, 'utf-8');
  const { records, parseFailures } = await readAllAnalyticsRecords();
  assert.ok(records.some((r) => r.runId === 'schema-cur'));
  assert.ok(!records.some((r) => r.runId === 'schema-future')); // newer schema skipped
  assert.ok(parseFailures >= 1); // corrupt line counted, not thrown
});

test('percentile uses nearest-rank (no high bias for small n)', () => {
  const base = Date.parse('2026-06-22T10:00:00.000Z');
  const recs = [10, 20, 30, 40].map((d, i) =>
    buildAnalyticsRecord(
      makeRun({
        id: `pct-${i}`,
        steps: [step('monitor', 'done', base, base + d)],
        completedAt: new Date(base + d).toISOString(),
      }),
    ),
  );
  const res = aggregateAnalytics(recs, {}, '2026-06-22T00:00:00.000Z');
  const monitor = res.bottleneck.find((b) => b.step === 'monitor');
  // nearest-rank p50 of [10,20,30,40] = rank ceil(0.5*4)=2 → 20 (not 30).
  assert.equal(monitor?.stats.p50, 20);
});
