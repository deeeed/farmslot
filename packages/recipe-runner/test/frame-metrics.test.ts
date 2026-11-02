import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { clockMidpoint } from '../src/runtime/cdp-trace.js';
import {
  estimateRefreshBudgetMs,
  type FrameSample,
  lowestWindowedFps,
  percentile,
  round,
  summarizeFrames,
} from '../src/runtime/frame-metrics.js';

const BUDGET_90 = 1000 / 90;

// `count` frames every `intervalMs` from `fromMs`, each lasting `durationMs`.
function frames(fromMs: number, count: number, intervalMs: number, durationMs = 8): FrameSample[] {
  return Array.from({ length: count }, (_, index) => {
    const startedAtEpochMs = fromMs + index * intervalMs;
    return {
      startedAtEpochMs,
      completedAtEpochMs: startedAtEpochMs + durationMs,
      durationMs,
      frameBudgetMs: BUDGET_90,
    };
  });
}

describe('shared frame helpers', () => {
  it('interpolates percentiles and rounds to three decimals', () => {
    assert.equal(percentile([10, 20, 30, 40], 0.5), 25);
    assert.equal(percentile([7], 0.95), 7);
    assert.equal(percentile([], 0.5), 0);
    assert.equal(round(1.23456), 1.235);
  });

  it('snaps the observed cadence to a refresh-rate budget', () => {
    const at90 = Array.from({ length: 10 }, (_, index) => index * (1000 / 90));
    assert.equal(estimateRefreshBudgetMs(at90), 1000 / 90);
    assert.equal(estimateRefreshBudgetMs(at90.slice(0, 5)), undefined);
    assert.equal(estimateRefreshBudgetMs([0, 100, 200, 300, 400, 500, 600]), undefined);
  });

  it('places a clock marker at the midpoint of its write', async () => {
    const realNow = Date.now;
    const clock = [10_000, 10_020];
    Date.now = () => clock.shift() ?? 0;
    try {
      assert.deepEqual(await clockMidpoint(async () => 'written'), {
        hostEpochMs: 10_010,
        uncertaintyMs: 10,
        value: 'written',
      });
    } finally {
      Date.now = realNow;
    }
  });
});

describe('lowest windowed fps', () => {
  it('reads steady smooth rendering at the refresh rate', () => {
    assert.equal(lowestWindowedFps(frames(0, 90, BUDGET_90), { windowMs: 500 }), 90);
  });

  it('counts a slow cadence within the max gap as rendering', () => {
    // Every fourth vsync at 90 Hz: the default 3.01-budget gap leaves it out.
    const slow = frames(0, 25, BUDGET_90 * 4);
    assert.equal(lowestWindowedFps(slow, { windowMs: 500 }), undefined);
    assert.equal(lowestWindowedFps(slow, { windowMs: 500, maxGapMs: 100 }), 22.5);
  });

  it('reads continuous slow frames however few fit in a window', () => {
    // 195 ms frames every 200 ms: about 5 fps, two intervals per window.
    assert.equal(lowestWindowedFps(frames(0, 11, 200, 195), { windowMs: 500, maxGapMs: 100 }), 5);
  });

  it('needs a whole window of rendering', () => {
    const tail = [...frames(0, 50, BUDGET_90), ...frames(50 * BUDGET_90 + 40, 6, 40)];
    assert.ok((lowestWindowedFps(tail, { windowMs: 500, maxGapMs: 100 }) ?? 0) > 50);
    assert.equal(lowestWindowedFps(frames(0, 6, 40), { windowMs: 500, maxGapMs: 100 }), undefined);
  });

  it('keeps one long frame from reading as a sustained drop', () => {
    const hitch = [
      ...frames(0, 20, BUDGET_90),
      ...frames(222, 1, 150, 150),
      ...frames(380, 20, BUDGET_90),
    ];
    assert.ok((lowestWindowedFps(hitch, { windowMs: 500, maxGapMs: 100 }) ?? 0) > 30);
  });
});

describe('frame metric summaries', () => {
  it('excludes idle gaps from cadence-based active FPS', () => {
    const samples = Array.from({ length: 12 }, (_, index) => ({
      cadenceInterval: true,
      completedAtEpochMs: 1_000 + index * 16.667,
      durationMs: index === 6 ? 5_000 : 16.667,
      frameBudgetMs: 16.667,
      overBudget: index === 6,
    }));

    const result = summarizeFrames(samples);
    assert.equal(result.fpsUnavailableReason, 'unclassified_cadence_gap');
    assert.equal(result.cadenceGapCount, 1);
    assert.equal(result.longestCadenceGapMs, 5_000);
    assert.equal(result.overBudgetFrameCount, 0);
    assert.equal(result.longestFrameMs, 16.667);
    assert.ok(!('activeFps' in result), 'activeFps should not be present');
  });

  it('summarizes distributions without inventing active FPS', () => {
    const result1 = summarizeFrames([
      { completedAtEpochMs: 1_000, durationMs: 10, frameBudgetMs: 16.667, overBudget: false },
      { completedAtEpochMs: 1_016, durationMs: 16, frameBudgetMs: 16.667, overBudget: false },
      { completedAtEpochMs: 1_050, durationMs: 34, frameBudgetMs: 16.667, overBudget: true },
    ]);
    assert.deepEqual(result1, {
      fpsUnavailableReason: 'insufficient_active_frames',
      frameBudgetMs: 16.667,
      frameCount: 3,
      overBudgetFrameCount: 1,
      overBudgetFramePercent: 33.333,
      longestFrameMs: 34,
      p50FrameMs: 16,
      p95FrameMs: 32.2,
      p99FrameMs: 33.64,
      refreshRateHz: 59.999,
    });

    const result2 = summarizeFrames([{ completedAtEpochMs: 1_000, durationMs: 20 }]);
    assert.deepEqual(result2, {
      fpsUnavailableReason: 'refresh_rate_unavailable',
      frameCount: 1,
      longestFrameMs: 20,
      p50FrameMs: 20,
      p95FrameMs: 20,
      p99FrameMs: 20,
    });
  });
});
