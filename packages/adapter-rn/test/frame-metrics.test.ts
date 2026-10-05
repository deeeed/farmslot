import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { summarizeFrames } from '../src/frame-metrics.js';

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
