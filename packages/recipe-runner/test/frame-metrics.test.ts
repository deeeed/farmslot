import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { clockMidpoint } from '../src/runtime/cdp-trace.js';
import {
  estimateRefreshBudgetMs,
  percentile,
  round,
  summarizeFrames,
} from '../src/runtime/frame-metrics.js';

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
    const sync = await clockMidpoint(async () => 'written');
    assert.equal(sync.value, 'written');
    assert.ok(sync.uncertaintyMs >= 0);
    assert.ok(Math.abs(sync.hostEpochMs - Date.now()) < 1_000);
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
