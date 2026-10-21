import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildCompanionTerminalTarget,
  matchesCompanionTerminalTarget,
  shouldUseBareTerminalSessionForRun,
} from './terminal-target';

test('opening a run reviewer keeps its exact context for subscribe, input and resize', () => {
  const selected = {
    slotId: 'review-slot',
    runId: 'run-1',
    contextId: 'rev-proof-3',
    role: 'review' as const,
    bareSession: false,
  };
  assert.deepEqual(buildCompanionTerminalTarget(selected), {
    slotId: 'review-slot',
    runId: 'run-1',
    contextId: 'rev-proof-3',
    role: 'review',
  });
});

test('an explicit reviewer pin cannot become a bare slot and rejects other actor events', () => {
  const target = buildCompanionTerminalTarget({
    slotId: 'review-slot',
    runId: 'run-1',
    contextId: 'rev-proof-3',
    role: 'review',
    bareSession: true,
  });
  assert.equal(target.bareSession, undefined);
  assert.equal(matchesCompanionTerminalTarget({ ...target }, target), true);
  assert.equal(matchesCompanionTerminalTarget({ ...target, contextId: 'worker' }, target), false);
  assert.equal(matchesCompanionTerminalTarget({ ...target, runId: 'other-run' }, target), false);
  assert.equal(matchesCompanionTerminalTarget({ ...target, role: 'dev' }, target), false);
});

test('an allocated worktree terminal retains its run without a slot or bare-session fallback', () => {
  const target = buildCompanionTerminalTarget({
    slotId: '',
    runId: 'worktree-run',
    bareSession: true,
  });
  assert.deepEqual(target, { slotId: '', runId: 'worktree-run' });
  assert.equal(matchesCompanionTerminalTarget({ slotId: '', runId: 'worktree-run' }, target), true);
  assert.equal(matchesCompanionTerminalTarget({ slotId: '', runId: 'other-run' }, target), false);
});

test('shouldUseBareTerminalSessionForRun keeps active run targets scoped by run id', () => {
  assert.equal(
    shouldUseBareTerminalSessionForRun({
      requestedRunId: 'run-1',
      requestedSlotId: 'runner-mobile-1',
      run: { slotId: 'runner-mobile-1', status: 'monitoring' },
    }),
    false,
  );
});

test('shouldUseBareTerminalSessionForRun uses bare session for completed or detached run pages', () => {
  assert.equal(
    shouldUseBareTerminalSessionForRun({
      requestedRunId: 'run-1',
      requestedSlotId: 'runner-mobile-1',
      run: { slotId: 'runner-mobile-1', status: 'done' },
    }),
    true,
  );
  assert.equal(
    shouldUseBareTerminalSessionForRun({
      requestedRunId: 'run-1',
      requestedSlotId: 'runner-mobile-1',
      run: { slotId: null, status: 'monitoring' },
    }),
    true,
  );
  assert.equal(
    shouldUseBareTerminalSessionForRun({
      requestedRunId: 'run-1',
      requestedSlotId: 'runner-mobile-1',
      run: null,
    }),
    true,
  );
});

test('buildCompanionTerminalTarget drops run id when routing to bare session', () => {
  assert.deepEqual(
    buildCompanionTerminalTarget({
      slotId: 'runner-mobile-1',
      runId: 'run-1',
      bareSession: true,
    }),
    { slotId: 'runner-mobile-1', bareSession: true },
  );
  assert.deepEqual(
    buildCompanionTerminalTarget({
      slotId: 'runner-mobile-1',
      runId: 'run-1',
      bareSession: false,
    }),
    { slotId: 'runner-mobile-1', runId: 'run-1' },
  );
});

test('matchesCompanionTerminalTarget accepts slot-only events for bare session targets', () => {
  const target = buildCompanionTerminalTarget({
    slotId: 'runner-mobile-1',
    runId: 'run-1',
    bareSession: true,
  });

  assert.equal(matchesCompanionTerminalTarget({ slotId: 'runner-mobile-1' }, target), true);
  assert.equal(
    matchesCompanionTerminalTarget({ slotId: 'runner-mobile-1', runId: 'other' }, target),
    true,
  );
  assert.equal(matchesCompanionTerminalTarget({ slotId: 'runner-mobile-2' }, target), false);
});
