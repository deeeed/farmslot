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
  measurePress,
  renderPerformanceReport,
  summarizeWindow,
} from '../src/performance-capture.js';

import { matchesObject } from './_helpers.js';

const BUDGET_MS = 1000 / 90;

function frame(
  startedAtEpochMs: number,
  durationMs: number,
  {
    frameBudgetMs = BUDGET_MS,
    ...extra
  }: { input?: true; uiThreadMs?: number; frameBudgetMs?: number } = {},
): AndroidFrameSample {
  return {
    startedAtEpochMs,
    completedAtEpochMs: startedAtEpochMs + durationMs,
    durationMs,
    frameBudgetMs,
    overBudget: durationMs > frameBudgetMs * 1.01,
    ...extra,
  };
}

// `count` consecutive frames every `intervalMs` from `fromMs`.
function cadence(
  fromMs: number,
  count: number,
  intervalMs: number,
  durationMs = 8,
  budgetMs = BUDGET_MS,
) {
  return Array.from({ length: count }, (_, index) =>
    frame(fromMs + index * intervalMs, durationMs, { uiThreadMs: 2, frameBudgetMs: budgetMs }),
  );
}

function capture(
  samples: AndroidFrameSample[],
  {
    coverageGapReasons = [],
    unavailableReasons = [],
    inputEvents = 'available',
  }: {
    coverageGapReasons?: string[];
    unavailableReasons?: string[];
    inputEvents?: 'available' | 'missing';
  } = {},
): AndroidGfxinfoCaptureResult {
  return {
    inputEvents,
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
      status:
        samples.length === 0
          ? 'unavailable'
          : coverageGapReasons.length > 0
            ? 'partial'
            : 'complete',
      kind: 'android-gfxinfo-framestats',
      unavailableReasons,
      coverageGapReasons,
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

  it('takes a mount among few frames instead of the first light frame', () => {
    const mount = [
      frame(1_000, 6, { input: true, uiThreadMs: 2 }),
      frame(1_011, 5, { uiThreadMs: 1 }),
      frame(1_100, 30, { uiThreadMs: 24 }),
    ];
    assert.equal(measurePress(mount, press, 600, 5_000).latencyMs, 130);
    const withLayout = [...mount, frame(1_140, 20, { uiThreadMs: 16 })];
    assert.equal(measurePress(withLayout, press, 600, 5_000).latencyMs, 130);
  });

  it('reads a mount just past the window behind light frames as slow', () => {
    const light = Array.from({ length: 58 }, (_, index) =>
      frame(1_011 + index * BUDGET_MS, 5, { uiThreadMs: 1 }),
    );
    const samples = [
      frame(1_000, 6, { input: true, uiThreadMs: 2 }),
      ...light,
      frame(1_655, 30, { uiThreadMs: 24 }),
    ];
    assert.deepEqual(measurePress(samples, press, 600, 5_000), {
      nodeId: 'tab',
      action: 'ui.press',
      target: 'tab-terminals',
      latencyMs: 685,
      answer: 'mount',
    });
  });

  it('times a mount that a JavaScript stall delays past the window', () => {
    // Light feedback at +11 ms, then nothing until the mount at +650 ms.
    const samples = [
      frame(1_000, 6, { input: true, uiThreadMs: 2 }),
      frame(1_011, 5, { uiThreadMs: 1 }),
      frame(1_650, 30, { uiThreadMs: 24 }),
    ];
    assert.deepEqual(measurePress(samples, press, 600, 5_000), {
      nodeId: 'tab',
      action: 'ui.press',
      target: 'tab-terminals',
      latencyMs: 680,
      answer: 'mount',
    });
  });

  it('leaves a live update on an already-mounted screen to another cause', () => {
    // A cheap Review return, then a routine 6.9 ms live-run update at +800 ms.
    const samples = [
      frame(1_000, 6, { input: true, uiThreadMs: 3 }),
      frame(1_011, 5, { uiThreadMs: 1.3 }),
      frame(1_466, 5, { uiThreadMs: 1.2 }),
      frame(1_800, 9, { uiThreadMs: 6.9 }),
    ];
    assert.deepEqual(measurePress(samples, press, 600, 5_000), {
      nodeId: 'tab',
      action: 'ui.press',
      target: 'tab-terminals',
      latencyMs: 16,
      answer: 'first-frame',
    });
  });

  it('leaves an update beyond reach to another cause', () => {
    // Main's release capture: a cheap Review return, then a 6.9 ms update at +1076 ms.
    const samples = [
      frame(1_000, 6, { input: true, uiThreadMs: 3 }),
      frame(1_011, 5, { uiThreadMs: 1.3 }),
      frame(1_466, 5, { uiThreadMs: 1.2 }),
      frame(2_076, 9, { uiThreadMs: 6.9 }),
    ];
    assert.equal(measurePress(samples, press, 600, 5_000).answer, 'first-frame');
  });

  it('times a late mount when nothing answered in the window', () => {
    const samples = [frame(1_000, 6, { input: true }), frame(1_800, 20, { uiThreadMs: 30 })];
    assert.equal(measurePress(samples, press, 600, 5_000).latencyMs, 820);
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
  it('enforces the floor on a capture without refresh budgets', () => {
    // Legacy framestats: no FrameInterval, and a 50 ms cadence the estimator rejects.
    const legacy = cadence(0, 41, 50).map(({ frameBudgetMs: _budget, ...sample }) => sample);
    const summary = summarizeWindow({
      id: 'scroll',
      startedAtEpochMs: 0,
      endedAtEpochMs: 2_100,
      maxDurationMs: 60_000,
      result: capture(legacy),
      spans: [],
      sustainedWindowMs: 500,
      responseWindowMs: 600,
      budget: { min_sustained_fps: 30 },
    });
    assert.equal(summary.sustainedFps, 20);
    assert.equal(summary.budget?.verdict, 'fail');
    assert.match(summary.notes.join(';'), /no refresh budget/u);
  });

  it('counts a slow cadence up to 100 ms apart against the floor', () => {
    const summary = summarizeWindow({
      id: 'scroll',
      startedAtEpochMs: 0,
      endedAtEpochMs: 2_000,
      maxDurationMs: 60_000,
      // Every fourth vsync at 90 Hz.
      result: capture(cadence(0, 25, BUDGET_MS * 4)),
      spans: [],
      sustainedWindowMs: 500,
      responseWindowMs: 600,
      budget: { min_sustained_fps: 30 },
    });
    assert.equal(summary.sustainedFps, 22.5);
    assert.equal(summary.budget?.verdict, 'fail');
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
      baseline: { label: 'main abc123 @90Hz', press_p95_ms: 159, press_max_ms: 192 },
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
      'press p95 (gfxinfo input->mount frame) 206 ms > 130 ms (tabs; slowest tab-terminals 210 ms); main abc123 @90Hz baseline p95 159 ms',
      'press (gfxinfo input->mount frame) 210 ms > 150 ms (tab-terminals, node b); main abc123 @90Hz baseline max 192 ms',
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
      'press (gfxinfo input->mount frame) untimed, counted over 150 ms (tab-terminals, node b): no frame handled input during the press',
    ]);
  });

  it('lets a coverage gap take precedence over what the partial capture failed', () => {
    const gap = ['Android gfxinfo poll failed: device offline'];
    const empty = summarizeWindow({
      ...base,
      result: capture([], { coverageGapReasons: gap }),
      spans: [],
      budget: { min_frames: 10 },
    });
    assert.equal(empty.budget?.verdict, 'inconclusive');
    assert.equal(empty.budget?.failures.length, 1);
    const untimed = summarizeWindow({
      ...base,
      result: capture(samples.slice(0, 4), { coverageGapReasons: gap }),
      spans: presses,
      budget: { max_press_ms: 150 },
    });
    assert.equal(untimed.budget?.verdict, 'inconclusive');
  });

  it('is inconclusive with a coverage gap, never a pass', () => {
    const summary = summarizeWindow({
      ...base,
      result: capture([], { coverageGapReasons: ['Android gfxinfo poll failed: timeout'] }),
      spans: [],
      budget: { min_sustained_fps: 30 },
    });
    assert.equal(summary.budget?.verdict, 'inconclusive');
    assert.deepEqual(summary.budget?.inconclusive, [
      'coverage gap: Android gfxinfo poll failed: timeout',
    ]);
  });

  it('prints a value over its limit so it reads over it', () => {
    const summary = summarizeWindow({
      ...base,
      result: capture([
        frame(1_000, 6, { input: true, uiThreadMs: 2 }),
        frame(1_011, 5, { uiThreadMs: 1 }),
        frame(1_220, 30.4, { uiThreadMs: 25 }),
      ]),
      spans: presses.slice(0, 1),
      budget: { max_press_ms: 250 },
    });
    assert.deepEqual(summary.budget?.failures, [
      'press (gfxinfo input->mount frame) 250.4 ms > 250 ms (tab-review, node a)',
    ]);
  });

  it('times no press on a device without input events and says why', () => {
    const summary = summarizeWindow({
      ...base,
      result: capture(samples, { inputEvents: 'missing' }),
      spans: presses,
    });
    assert.match(summary.presses[0]?.unmeasuredReason ?? '', /Android 12 or later/u);
  });

  it('notes a refresh rate unlike the baseline', () => {
    const summary = summarizeWindow({
      ...base,
      result: capture(cadence(0, 60, 1000 / 60, 8, 1000 / 60)),
      spans: [],
      baseline: { label: 'main abc123 @90Hz', refresh_hz: 90 },
    });
    assert.deepEqual(summary.notes, ['measured 60 Hz; the baseline was recorded at 90 Hz']);
  });

  it('passes an idle window that rendered nothing', () => {
    const summary = summarizeWindow({
      ...base,
      // What the gfxinfo backend returns for a capture with no frames.
      result: capture([], {
        unavailableReasons: ['No Android gfxinfo frame samples were recorded.'],
      }),
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
          /press \(gfxinfo input->mount frame\) 230 ms > 150 ms \(companion-tab-review, node press\)/u.test(
            error.message,
          ),
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

  it('reports a lost device as inconclusive with an environment cause', async () => {
    const artifactsDir = await mkdtemp(path.join(os.tmpdir(), 'adapter-rn-perf-'));
    const gap = ['Android gfxinfo poll failed: device offline'];
    const results = [
      capture([], { coverageGapReasons: gap }),
      capture([frame(1_000, 6, { uiThreadMs: 1 })], { coverageGapReasons: gap }),
    ];
    const backend: AndroidGfxinfoPerformanceBackend = {
      async start() {},
      async end() {
        return results.shift() ?? capture([]);
      },
      async close() {},
    };
    let clock = 0;
    const session = createPerformanceCaptureSession({
      env: {},
      createBackend: () => backend,
      now: () => clock,
    });
    const ctx = context('n', artifactsDir).value;
    try {
      await session.handler.execute({ phase: 'start', id: 'scroll' }, ctx);
      await session.handler.execute(
        { phase: 'end', id: 'scroll', budget: { min_frames: 10 } },
        ctx,
      );
      await session.handler.execute({ phase: 'start', id: 'tabs' }, ctx);
      clock = 900;
      session.recordNodeEvent({ nodeId: 'press', action: 'ui.press', status: 'running' });
      clock = 1_100;
      session.recordNodeEvent({ nodeId: 'press', action: 'ui.press', status: 'passed' });
      clock = 2_000;
      await session.handler.execute(
        { phase: 'end', id: 'tabs', budget: { max_press_ms: 250 } },
        ctx,
      );
      await assert.rejects(
        session.handler.execute({ phase: 'report' }, ctx),
        (error: unknown) =>
          error instanceof RecipeExecutionError &&
          error.causeClass === 'environment' &&
          error.code === 'PERFORMANCE_INCONCLUSIVE',
      );
      const report: unknown = JSON.parse(
        await readFile(path.join(artifactsDir, 'performance/report.json'), 'utf8'),
      );
      assert.ok(
        matchesObject(report, {
          verdict: 'inconclusive',
          windows: [
            { id: 'scroll', budget: { verdict: 'inconclusive' } },
            { id: 'tabs', budget: { verdict: 'inconclusive' } },
          ],
        }),
      );
    } finally {
      await rm(artifactsDir, { recursive: true, force: true });
    }
  });

  it('names the checkout in the report and warns only when git itself fails', async () => {
    const backend: AndroidGfxinfoPerformanceBackend = {
      async start() {},
      async end() {
        return capture([]);
      },
      async close() {},
    };
    const report = async (projectRoot: string, env?: Record<string, string>) => {
      const warnings: string[] = [];
      const session = createPerformanceCaptureSession({
        env: {},
        createBackend: () => backend,
        logger: { warn: (message: string) => warnings.push(message) },
      });
      const artifactsDir = await mkdtemp(path.join(os.tmpdir(), 'adapter-rn-perf-'));
      const ctx = { ...context('n', artifactsDir).value, projectRoot };
      const savedPath = process.env.PATH;
      try {
        await session.handler.execute({ phase: 'start', id: 'idle' }, ctx);
        await session.handler.execute({ phase: 'end', id: 'idle' }, ctx);
        if (env?.PATH !== undefined) process.env.PATH = env.PATH;
        const result = await session.handler.execute({ phase: 'report' }, ctx);
        return { result, warnings };
      } finally {
        process.env.PATH = savedPath;
        await rm(artifactsDir, { recursive: true, force: true });
      }
    };
    const outside = await mkdtemp(path.join(os.tmpdir(), 'adapter-rn-not-a-repo-'));
    try {
      const notARepo = await report(outside);
      assert.deepEqual(notARepo.warnings, []);
      assert.ok(matchesObject(notARepo.result.output, { verdict: 'pass' }));
      const noGit = await report(outside, { PATH: outside });
      assert.equal(noGit.warnings.length, 1);
      assert.match(noGit.warnings[0] ?? '', /could not read the checkout/u);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
    const inRepo = await report(process.cwd());
    assert.match(
      JSON.stringify(inRepo.result.output),
      /"checkout":\{"head":"[0-9a-f]{40}","dirty":(true|false)\}/u,
    );
  });

  it('logs a window it could not end when the run closes', async () => {
    const warnings: string[] = [];
    const backend: AndroidGfxinfoPerformanceBackend = {
      async start() {},
      async end() {
        throw new Error('adb: device offline');
      },
      async close() {},
    };
    const session = createPerformanceCaptureSession({
      env: {},
      createBackend: () => backend,
      logger: { warn: (message: string) => warnings.push(message) },
    });
    await session.handler.execute({ phase: 'start', id: 'open' }, context('n', os.tmpdir()).value);
    await session.close();
    assert.deepEqual(warnings, ['Performance window open did not end: adb: device offline']);
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
