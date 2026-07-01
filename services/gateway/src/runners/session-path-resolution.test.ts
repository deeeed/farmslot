import assert from 'node:assert/strict';
import test from 'node:test';

import { PipelineSteps } from '@farmslot/protocol';

import {
  chooseRunnerSessionPath,
  dispatchStartedAtMs,
  findSessionStartFromHooks,
  RUNNER_SESSION_DISPATCH_SLACK_MS,
  sessionPathStartedAfterDispatch,
} from './session-path-resolution.js';

test('dispatchStartedAtMs prefers the dispatch step timestamp', () => {
  const ms = dispatchStartedAtMs({
    startedAt: '2026-06-30T19:57:19.515Z',
    steps: [
      { name: PipelineSteps.DISPATCH, startedAt: '2026-06-30T19:58:40.642Z', status: 'done' },
    ],
  });
  assert.equal(ms, Date.parse('2026-06-30T19:58:40.642Z'));
});

test('chooseRunnerSessionPath prefers a fresh session after dispatch', () => {
  const dispatchMs = Date.parse('2026-06-30T19:58:40.642Z');
  const stale = '/home/.claude/projects/repo/stale.jsonl';
  const fresh = '/home/.claude/projects/repo/fresh.jsonl';
  const chosen = chooseRunnerSessionPath({
    candidates: [stale, fresh],
    mtimeMsByPath: new Map([
      [stale, dispatchMs - 24 * 60 * 60 * 1000],
      [fresh, dispatchMs + 5_000],
    ]),
    beforePaths: [stale, fresh],
    sinceMs: dispatchMs,
  });
  assert.equal(chosen, fresh);
});

test('chooseRunnerSessionPath rejects stale fallback when sinceMs is set', () => {
  const dispatchMs = Date.parse('2026-06-30T19:58:40.642Z');
  const stale = '/home/.claude/projects/repo/stale.jsonl';
  const chosen = chooseRunnerSessionPath({
    candidates: [stale],
    mtimeMsByPath: new Map([[stale, dispatchMs - 24 * 60 * 60 * 1000]]),
    beforePaths: [stale],
    sinceMs: dispatchMs,
  });
  assert.equal(chosen, null);
});

test('chooseRunnerSessionPath keeps existing bound session when still eligible', () => {
  const dispatchMs = Date.parse('2026-06-30T19:58:40.642Z');
  const existing = '/home/.claude/projects/repo/existing.jsonl';
  const newer = '/home/.claude/projects/repo/newer.jsonl';
  const chosen = chooseRunnerSessionPath({
    candidates: [newer, existing],
    mtimeMsByPath: new Map([
      [newer, dispatchMs + 60_000],
      [existing, dispatchMs + 10_000],
    ]),
    sinceMs: dispatchMs,
    existingPath: existing,
  });
  assert.equal(chosen, existing);
});

test('findSessionStartFromHooks ignores other-pane SessionStart when paneId is set', () => {
  const dispatchMs = Date.parse('2026-06-30T19:58:40.642Z');
  const binding = findSessionStartFromHooks(
    [
      {
        hook_event_name: 'SessionStart',
        observedAt: dispatchMs + 1_000,
        session_id: 'fresh-id',
        transcript_path: '/tmp/fresh.jsonl',
        tmuxPane: '%0',
        slotId: 'slot-a',
      },
      {
        hook_event_name: 'SessionStart',
        observedAt: dispatchMs + 2_000,
        session_id: 'other-pane',
        transcript_path: '/tmp/other.jsonl',
        tmuxPane: '%1',
        slotId: 'slot-a',
      },
    ],
    { paneId: '%0', slotId: 'slot-a', sinceMs: dispatchMs },
  );
  assert.equal(binding?.transcriptPath, '/tmp/fresh.jsonl');
  assert.equal(binding?.sessionId, 'fresh-id');
});

test('sessionPathStartedAfterDispatch honors slack before dispatch', () => {
  const dispatchMs = Date.parse('2026-06-30T19:58:40.642Z');
  assert.equal(
    sessionPathStartedAfterDispatch(dispatchMs - RUNNER_SESSION_DISPATCH_SLACK_MS + 1, dispatchMs),
    true,
  );
  assert.equal(
    sessionPathStartedAfterDispatch(dispatchMs - RUNNER_SESSION_DISPATCH_SLACK_MS - 1, dispatchMs),
    false,
  );
});
