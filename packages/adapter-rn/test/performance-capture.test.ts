import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { type ActionExecutionContext, RecipeExecutionError } from '@farmslot/recipe-runner';
import { summarizeFrames } from '@farmslot/recipe-runner/runtime/cdp-trace';

import type {
  AndroidFrameSample,
  AndroidGfxinfoCaptureResult,
  AndroidGfxinfoPerformanceBackend,
} from '../src/android-gfxinfo-performance.js';
import {
  createPerformanceCaptureSession,
  lowestSustainedFps,
  measurePress,
  renderPerformanceReport,
  summarizeWindow,
} from '../src/performance-capture.js';

import { matchesObject } from './_helpers.js';

const BUDGET_MS = 1000 / 90;

function frame(
  startedAtEpochMs: number,
  durationMs: number,
  extra: { input?: true; uiThreadMs?: number } = {},
): AndroidFrameSample {
  return {
    startedAtEpochMs,
    completedAtEpochMs: startedAtEpochMs + durationMs,
    durationMs,
    frameBudgetMs: BUDGET_MS,
    overBudget: durationMs > BUDGET_MS * 1.01,
    ...extra,
  };
}

// `count` consecutive frames every `intervalMs` from `fromMs`.
function cadence(fromMs: number, count: number, intervalMs: number, durationMs = 8) {
  return Array.from({ length: count }, (_, index) =>
    frame(fromMs + index * intervalMs, durationMs, { uiThreadMs: 2 }),
  );
}

function capture(samples: AndroidFrameSample[]): AndroidGfxinfoCaptureResult {
  return {
    platform: 'android',
    javascript: {
      applicability: 'not_applicable',
      status: 'unavailable',
      kind: 'not-applicable-mobile-js-tasks',
      unavailableReasons: [],
      coverageGapReasons: [],
      samples: [],
      summary: {},
    },
    nativeUi: {
      status: samples.length > 0 ? 'complete' : 'unavailable',
      kind: 'android-gfxinfo-framestats',
      unavailableReasons: [],
      coverageGapReasons: [],
      samples,
      summary: summarizeFrames(samples),
    },
    trace: {
      beginFrameCount: samples.length,
      dataLossOccurred: false,
      drawFrameCount: samples.length,
      overflow: false,
      profileChunkCount: 0,
      runTaskCount: 0,
      scope: 'mobile-host',
      totalEventCount: 0,
    },
  };
}

describe('press latency', () => {
  const press = {
    nodeId: 'tab',
    action: 'ui.press',
    target: 'tab-terminals',
    startedAtEpochMs: 900,
    endedAtEpochMs: 1_300,
  };

  it('runs from the input frame to the frame that mounts the new screen', () => {
    const samples = [
      frame(1_000, 6, { input: true, uiThreadMs: 2 }),
      frame(1_011, 5, { uiThreadMs: 1 }),
      frame(1_100, 30, { uiThreadMs: 24 }),
      frame(1_140, 9, { uiThreadMs: 6 }),
    ];
    assert.deepEqual(measurePress(samples, press, 600, 5_000), {
      nodeId: 'tab',
      action: 'ui.press',
      target: 'tab-terminals',
      latencyMs: 130,
      answer: 'mount',
    });
  });

  it('ignores frames after the response window and frames that handled input', () => {
    const samples = [
      frame(1_000, 6, { input: true, uiThreadMs: 2 }),
      frame(1_020, 30, { input: true, uiThreadMs: 28 }),
      frame(1_030, 5, { uiThreadMs: 1 }),
      frame(1_040, 5, { uiThreadMs: 1 }),
      frame(1_050, 20, { uiThreadMs: 14 }),
      frame(1_700, 40, { uiThreadMs: 20 }),
    ];
    assert.equal(measurePress(samples, press, 600, 5_000).latencyMs, 70);
  });

  it('finds an answer that lands after the press node ends', () => {
    const samples = [
      frame(1_000, 6, { input: true }),
      frame(1_011, 5, { uiThreadMs: 1 }),
      frame(1_022, 5, { uiThreadMs: 1 }),
      frame(1_500, 20, { uiThreadMs: 12 }),
    ];
    assert.equal(measurePress(samples, press, 600, 5_000).latencyMs, 520);
  });

  it('times an already mounted screen to the first frame after the touch', () => {
    const samples = [
      frame(1_000, 6, { input: true, uiThreadMs: 3 }),
      frame(1_011, 5, { uiThreadMs: 1.3 }),
      frame(1_100, 5, { uiThreadMs: 1.2 }),
      frame(1_188, 6, { uiThreadMs: 1.5 }),
    ];
    assert.deepEqual(measurePress(samples, press, 600, 5_000), {
      nodeId: 'tab',
      action: 'ui.press',
      target: 'tab-terminals',
      latencyMs: 16,
      answer: 'first-frame',
    });
  });

  it('leaves a press untimed without an input frame or an answer', () => {
    assert.match(
      measurePress([frame(1_100, 9)], press, 600, 5_000).unmeasuredReason ?? '',
      /no frame handled input/u,
    );
    assert.match(
      measurePress([frame(1_000, 6, { input: true }), frame(2_500, 9)], press, 600, 5_000)
        .unmeasuredReason ?? '',
      /within 600 ms/u,
    );
  });
});

describe('sustained FPS', () => {
  it('reports the slowest stretch of continuous rendering', () => {
    const smooth = cadence(0, 60, BUDGET_MS);
    const slow = cadence(1_000, 20, 40, 38);
    const fps = lowestSustainedFps([...smooth, ...slow], 500);
    assert.ok(fps !== undefined && fps < 30, `expected < 30 fps, got ${fps}`);
    assert.ok((lowestSustainedFps(smooth, 500) ?? 0) > 85);
  });

  it('does not let one long frame read as a sustained drop', () => {
    const samples = [...cadence(0, 20, BUDGET_MS), frame(222, 150), ...cadence(380, 20, BUDGET_MS)];
    assert.ok((lowestSustainedFps(samples, 500) ?? 0) > 30);
  });

  it('is absent when nothing rendered continuously', () => {
    assert.equal(lowestSustainedFps([frame(0, 8), frame(5_000, 8)], 500), undefined);
  });
});

describe('window budget', () => {
  const base = {
    id: 'tabs',
    startedAtEpochMs: 0,
    endedAtEpochMs: 3_000,
    maxDurationMs: 60_000,
    sustainedWindowMs: 500,
    responseWindowMs: 1_000,
  };
  const presses = [
    {
      nodeId: 'a',
      action: 'ui.press',
      target: 'tab-review',
      startedAtEpochMs: 900,
      endedAtEpochMs: 1_200,
    },
    {
      nodeId: 'b',
      action: 'ui.press',
      target: 'tab-terminals',
      startedAtEpochMs: 1_900,
      endedAtEpochMs: 2_200,
    },
    { nodeId: 'wait', action: 'wait', startedAtEpochMs: 2_300, endedAtEpochMs: 2_400 },
  ];
  const samples = [
    frame(1_000, 6, { input: true, uiThreadMs: 2 }),
    frame(1_011, 5, { uiThreadMs: 1 }),
    frame(1_022, 5, { uiThreadMs: 1 }),
    frame(1_080, 40, { uiThreadMs: 30 }),
    frame(2_000, 6, { input: true, uiThreadMs: 2 }),
    frame(2_011, 5, { uiThreadMs: 1 }),
    frame(2_022, 5, { uiThreadMs: 1 }),
    frame(2_150, 60, { uiThreadMs: 50 }),
  ];

  it('fails a press over the limit and reports the targets', () => {
    const summary = summarizeWindow({
      ...base,
      result: capture(samples),
      spans: presses,
      budget: { max_press_p95_ms: 130, max_press_ms: 150 },
      targets: { fps: 60, press_ms: 100 },
    });
    assert.deepEqual(summary.press, {
      count: 2,
      timed: 2,
      firstFrame: 0,
      p50Ms: 165,
      p95Ms: 205.5,
      maxMs: 210,
    });
    assert.deepEqual(summary.pressByTarget['tab-terminals'], {
      count: 1,
      timed: 1,
      firstFrame: 0,
      p50Ms: 210,
      p95Ms: 210,
      maxMs: 210,
    });
    assert.equal(summary.budget?.verdict, 'fail');
    assert.deepEqual(summary.budget?.failures, [
      'press p95 206 ms > 130 ms (tabs; slowest tab-terminals 210 ms)',
      'press 210 ms > 150 ms (tab-terminals, node b)',
    ]);
    assert.equal(summary.targets?.press?.met, false);
  });

  it('fails closed on an untimed press', () => {
    const summary = summarizeWindow({
      ...base,
      result: capture(samples.slice(0, 4)),
      spans: presses,
      budget: { max_press_ms: 150 },
    });
    assert.deepEqual(summary.budget?.failures, [
      'press untimed (tab-terminals, node b): no frame handled input during the press',
    ]);
  });

  it('passes an idle window that rendered nothing', () => {
    const summary = summarizeWindow({
      ...base,
      result: capture([]),
      spans: [],
      budget: { min_sustained_fps: 30, max_press_ms: 150 },
    });
    assert.equal(summary.budget?.verdict, 'pass');
  });
});

describe('app.performance_capture session', () => {
  function context(nodeId: string, artifactsDir: string) {
    const registered: unknown[] = [];
    const value: ActionExecutionContext = {
      nodeId,
      recipe: {},
      projectRoot: artifactsDir,
      artifactsDir,
      env: {},
      outputs: new Map(),
      getOutput: () => undefined,
      resolveProjectPath: (relative) => path.join(artifactsDir, relative),
      resolveArtifactPath: (relative) => path.join(artifactsDir, relative),
      getRunFileOffset: () => undefined,
      registerArtifact: (entry) => registered.push(entry),
      logger: { info() {}, warn() {}, error() {} },
    };
    return { value, registered };
  }

  it('measures a window and fails the report on a broken budget', async () => {
    const artifactsDir = await mkdtemp(path.join(os.tmpdir(), 'adapter-rn-perf-'));
    let clock = 0;
    const calls: string[] = [];
    const backend: AndroidGfxinfoPerformanceBackend = {
      async start(id) {
        calls.push(`start:${id}`);
      },
      async end(id) {
        calls.push(`end:${id}`);
        return capture([
          frame(1_000, 6, { input: true, uiThreadMs: 2 }),
          frame(1_200, 30, { uiThreadMs: 25 }),
        ]);
      },
      async close() {
        calls.push('close');
      },
    };
    const session = createPerformanceCaptureSession({
      env: {},
      createBackend: () => backend,
      now: () => clock,
    });
    const run = async (nodeId: string, node: Record<string, unknown>) => {
      const { value, registered } = context(nodeId, artifactsDir);
      session.recordNodeEvent({ nodeId, action: 'app.performance_capture', status: 'running' });
      const result = await session.handler.execute(node, value);
      session.recordNodeEvent({ nodeId, action: 'app.performance_capture', status: 'passed' });
      return { result, registered };
    };
    try {
      await run('start', { phase: 'start', id: 'tabs' });
      clock = 900;
      session.recordNodeEvent({
        nodeId: 'press',
        action: 'ui.press',
        target: 'companion-tab-review',
        status: 'running',
      });
      clock = 1_100;
      session.recordNodeEvent({ nodeId: 'press', action: 'ui.press', status: 'passed' });
      clock = 2_000;
      const { result } = await run('end', {
        phase: 'end',
        id: 'tabs',
        budget: { max_press_ms: '150' },
        targets: { fps: 60, press_ms: 100 },
      });
      assert.ok(
        matchesObject(result.output, { press: { maxMs: 230 }, budget: { verdict: 'fail' } }),
      );
      const summary: unknown = JSON.parse(
        await readFile(path.join(artifactsDir, 'performance/tabs-summary.json'), 'utf8'),
      );
      assert.ok(
        matchesObject(summary, { id: 'tabs', presses: [{ nodeId: 'press', latencyMs: 230 }] }),
      );

      await assert.rejects(
        run('report', { phase: 'report', title: 'Companion jank' }),
        (error: unknown) =>
          error instanceof RecipeExecutionError &&
          error.causeClass === 'subject' &&
          /press 230 ms > 150 ms \(companion-tab-review, node press\)/u.test(error.message),
      );
      const report = await readFile(path.join(artifactsDir, 'performance/report.md'), 'utf8');
      assert.match(report, /^# Companion jank/u);
      assert.match(report, /\| tabs \| fail \|/u);
      await session.close();
      assert.deepEqual(calls, ['start:tabs', 'end:tabs', 'close']);
    } finally {
      await rm(artifactsDir, { recursive: true, force: true });
    }
  });

  it('refuses an overlapping window and an unknown phase', async () => {
    const backend: AndroidGfxinfoPerformanceBackend = {
      async start() {},
      async end() {
        return capture([]);
      },
      async close() {},
    };
    const session = createPerformanceCaptureSession({ env: {}, createBackend: () => backend });
    const { value: ctx } = context('n', os.tmpdir());
    await session.handler.execute({ phase: 'start', id: 'one' }, ctx);
    await assert.rejects(
      session.handler.execute({ phase: 'start', id: 'two' }, ctx),
      /still open/u,
    );
    await assert.rejects(
      session.handler.execute({ phase: 'pause', id: 'one' }, ctx),
      /phase=start/u,
    );
    await session.close();
  });

  it('needs an Android device', async () => {
    const session = createPerformanceCaptureSession({ env: { PLATFORM: 'ios' } });
    const { value } = context('n', os.tmpdir());
    await assert.rejects(
      session.handler.execute({ phase: 'start', id: 'x' }, value),
      /PLATFORM=android/u,
    );
  });
});

describe('report', () => {
  it('renders one row per window with the distance to the targets', () => {
    const summary = summarizeWindow({
      id: 'scroll',
      startedAtEpochMs: 0,
      endedAtEpochMs: 2_000,
      maxDurationMs: 60_000,
      result: capture(cadence(0, 90, BUDGET_MS)),
      spans: [],
      sustainedWindowMs: 500,
      responseWindowMs: 1_000,
      budget: { min_sustained_fps: 30 },
      targets: { fps: 60 },
    });
    const markdown = renderPerformanceReport('Jank', [summary]);
    assert.match(markdown, /\| scroll \| pass \| \d+(\.\d)? \| \d+(\.\d)? \| 100% of 60 \|/u);
  });
});
