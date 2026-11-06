import assert from 'node:assert/strict';
import test from 'node:test';

import type { RunRefreshMirrorResult } from '@farmslot/protocol';

import {
  LIVE_ARTIFACT_REFRESH_INTERVAL_MS,
  LiveArtifactRefresh,
  liveArtifactRefreshActive,
  type LiveArtifactRefreshRun,
  type LiveArtifactRefreshTarget,
} from './run-artifact-live-refresh.js';

/** A clock and timer queue the test advances by hand; no real sleeps. */
function harness() {
  let now = 1_000_000;
  const timers = new Map<number, { at: number; callback: () => void }>();
  let nextTimer = 1;
  const calls: string[] = [];
  const pending: Array<(result: RunRefreshMirrorResult) => void> = [];
  const errors: Array<string | null> = [];
  const refresh = new LiveArtifactRefresh({
    refresh: (runId) => {
      calls.push(runId);
      return new Promise((resolve) => pending.push(resolve));
    },
    onError: (error) => errors.push(error),
    now: () => now,
    setTimer: (callback, ms) => {
      const id = nextTimer++;
      timers.set(id, { at: now + ms, callback });
      return id;
    },
    clearTimer: (handle) => {
      timers.delete(handle as number);
    },
  });
  const advance = (ms: number) => {
    now += ms;
    for (const [id, timer] of [...timers].sort((a, b) => a[1].at - b[1].at)) {
      if (timer.at > now || !timers.has(id)) continue;
      timers.delete(id);
      timer.callback();
    }
  };
  const settle = async (result: RunRefreshMirrorResult = { ok: true, copied: 1 }) => {
    pending.shift()?.(result);
    // Let the awaited reply run its continuation.
    await new Promise<void>((resolve) => setImmediate(resolve));
  };
  return { refresh, calls, errors, timers, advance, settle };
}

const live: LiveArtifactRefreshTarget = {
  runId: 'ce1c5583',
  active: true,
  open: true,
  unavailable: false,
};

test('an open panel on an active run syncs at once, then at most every 20 s', async () => {
  const h = harness();
  h.refresh.update(live);
  assert.deepEqual(h.calls, ['ce1c5583']);
  // Re-renders while the request is out never start a second one.
  h.refresh.update(live);
  h.advance(LIVE_ARTIFACT_REFRESH_INTERVAL_MS * 2);
  assert.equal(h.calls.length, 1);
  await h.settle();
  // It settled after 40 s, so the next one is due now.
  assert.equal(h.calls.length, 2);
  await h.settle();
  h.refresh.update(live);
  h.advance(LIVE_ARTIFACT_REFRESH_INTERVAL_MS - 1);
  assert.equal(h.calls.length, 2, 'throttled to one request per 20 s');
  h.advance(1);
  assert.equal(h.calls.length, 3);
});

test('a collapsed panel never syncs', () => {
  const h = harness();
  h.refresh.update({ ...live, open: false });
  h.advance(LIVE_ARTIFACT_REFRESH_INTERVAL_MS * 5);
  assert.deepEqual(h.calls, []);
  assert.equal(h.timers.size, 0);
});

test('a finished run, or one whose slot no longer holds it, never syncs', () => {
  const h = harness();
  h.refresh.update({ ...live, active: false });
  h.refresh.update({ ...live, unavailable: true });
  h.advance(LIVE_ARTIFACT_REFRESH_INTERVAL_MS * 5);
  assert.deepEqual(h.calls, []);
});

test('closing the panel stops syncing, and reopening keeps the throttle', async () => {
  const h = harness();
  h.refresh.update(live);
  await h.settle();
  h.refresh.update({ ...live, open: false });
  assert.equal(h.timers.size, 0, 'the next sync is cancelled');
  h.advance(5_000);
  h.refresh.update(live);
  assert.equal(h.calls.length, 1, 'reopening within 20 s does not sync again at once');
  h.advance(LIVE_ARTIFACT_REFRESH_INTERVAL_MS - 5_000);
  assert.equal(h.calls.length, 2);
});

test('the run ending stops syncing', async () => {
  const h = harness();
  h.refresh.update(live);
  await h.settle();
  h.refresh.update({ ...live, active: false });
  h.advance(LIVE_ARTIFACT_REFRESH_INTERVAL_MS * 3);
  assert.equal(h.calls.length, 1);
});

test('unmounting stops syncing and drops a late reply', async () => {
  const h = harness();
  h.refresh.update(live);
  h.refresh.dispose();
  await h.settle({ ok: false, reason: 'late' });
  h.advance(LIVE_ARTIFACT_REFRESH_INTERVAL_MS * 3);
  assert.equal(h.calls.length, 1);
  assert.deepEqual(h.errors, [null], 'only the reset for the bound run reached the view');
});

test('a failed sync reports its reason and the next success clears it', async () => {
  const h = harness();
  h.refresh.update(live);
  await h.settle({ ok: false, reason: 'slot unreachable' });
  assert.equal(h.errors.at(-1), 'slot unreachable');
  h.advance(LIVE_ARTIFACT_REFRESH_INTERVAL_MS);
  await h.settle();
  assert.equal(h.errors.at(-1), null);
});

test('switching runs drops a late reply without disturbing the new run refresh', async () => {
  const h = harness();
  h.refresh.update(live);
  h.refresh.update({ ...live, runId: 'next-run' });
  assert.deepEqual(h.calls, ['ce1c5583', 'next-run']);
  await h.settle({ ok: false, reason: 'previous run failed' });
  assert.deepEqual(h.errors, [null, null]);
  h.refresh.update({ ...live, runId: 'next-run' });
  assert.equal(h.calls.length, 2, 'the new request is still in flight');
  await h.settle();
  h.advance(LIVE_ARTIFACT_REFRESH_INTERVAL_MS);
  assert.equal(h.calls.at(-1), 'next-run');
  assert.equal(h.calls.length, 3);
  h.refresh.dispose();
});

test('a rejected refresh keeps the mirror usable and remains throttled', async () => {
  let calls = 0;
  const errors: Array<string | null> = [];
  const refresh = new LiveArtifactRefresh({
    refresh: async () => {
      calls++;
      throw new Error('disconnected');
    },
    onError: (error) => errors.push(error),
    setTimer: () => 'timer',
    clearTimer: () => {},
  });
  refresh.update(live);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);
  assert.equal(errors.at(-1), 'disconnected');
  refresh.update(live);
  assert.equal(calls, 1);
  refresh.dispose();
});

test('automatic capture never runs while a result or human decision is held', () => {
  for (const status of ['needs-decision', 'human-gating', 'done', 'failed', 'cancelled'] as const) {
    const h = harness();
    h.refresh.update({ ...live, active: liveArtifactRefreshActive({ status, decisions: [] }) });
    h.advance(LIVE_ARTIFACT_REFRESH_INTERVAL_MS * 3);
    assert.deepEqual(h.calls, [], status);
  }
});

test('a pending output review stops capture even before its status catches up', () => {
  const run: LiveArtifactRefreshRun = {
    status: 'reviewing',
    decisions: [
      {
        id: 'output-review',
        type: 'engine_output_review',
        title: 'Review report',
        description: '',
        actions: [],
        createdAt: '2026-11-03T00:00:00Z',
        payload: {
          kind: 'output-review',
          manifestDigest: 'snapshot',
          reportPath: 'artifacts/report.md',
        },
      },
    ],
  };
  const h = harness();
  h.refresh.update({ ...live, active: liveArtifactRefreshActive(run) });
  assert.deepEqual(h.calls, []);
});

test('entering a held decision cancels the next automatic capture', async () => {
  const h = harness();
  h.refresh.update({
    ...live,
    active: liveArtifactRefreshActive({ status: 'monitoring', decisions: [] }),
  });
  await h.settle();
  h.refresh.update({
    ...live,
    active: liveArtifactRefreshActive({ status: 'needs-decision', decisions: [] }),
  });
  h.advance(LIVE_ARTIFACT_REFRESH_INTERVAL_MS * 3);
  assert.equal(h.calls.length, 1);
  assert.equal(h.timers.size, 0);
});

test('an open review-posting gate stops capture while worker progress changes its status', () => {
  for (const status of ['human-gating', 'reconciling', 'reviewing', 'blocked'] as const) {
    const run: LiveArtifactRefreshRun = {
      status,
      decisions: [
        {
          id: 'review-posting',
          type: 'engine_review_posting',
          title: 'Post review',
          description: '',
          actions: [],
          createdAt: '2026-11-06T00:00:00Z',
          payload: {
            kind: 'review',
            reviewMd: 'Saved review',
            recommendation: 'COMMENT',
            lineComments: [],
            repo: null,
            prNumber: null,
          },
        },
      ],
    };
    const h = harness();
    h.refresh.update({ ...live, active: liveArtifactRefreshActive(run) });
    h.advance(LIVE_ARTIFACT_REFRESH_INTERVAL_MS * 3);
    assert.deepEqual(h.calls, [], status);
    run.decisions[0].resolvedAt = '2026-11-06T00:01:00Z';
    if (status === 'reviewing') assert.equal(liveArtifactRefreshActive(run), true);
  }
});
