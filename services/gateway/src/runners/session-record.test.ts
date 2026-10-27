import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import type { AgentContext, AgentRole, Run } from '@farmslot/protocol';

import type { upsertAgentContext } from '../agents/contexts.js';

import type { RunnerSessionMetadata } from './session-process.js';
import {
  captureAndRecordRunnerSession,
  type CaptureAndRecordRunnerSessionDeps,
  clearedRunnerSessionContextPatch,
  recordRunnerSessionForRole,
  runnerSessionContextPatch,
  runnerSessionContextTarget,
} from './session-record.js';

type UpsertCall = { runId: string; role: AgentRole; patch: Partial<AgentContext> };

function recordingUpsert(): { calls: UpsertCall[]; upsert: typeof upsertAgentContext } {
  const calls: UpsertCall[] = [];
  const upsert = (async (runId: string, role: AgentRole, patch: Partial<AgentContext>) => {
    calls.push({ runId, role, patch });
    return { id: `${role}-ctx`, role, ...patch } as AgentContext;
  }) as unknown as typeof upsertAgentContext;
  return { calls, upsert };
}

const FIXED_NOW = new Date('2026-09-04T10:00:00.000Z');

test('runnerSessionContextPatch stamps capture time for a complete binding', () => {
  const patch = runnerSessionContextPatch(
    { runnerSessionId: 'sess-1', runnerSessionPath: '/home/.codex/sessions/sess-1.jsonl' },
    'dispatch launch',
    FIXED_NOW,
  );

  assert.deepEqual(patch, {
    runnerSessionId: 'sess-1',
    runnerSessionPath: '/home/.codex/sessions/sess-1.jsonl',
    runnerSessionCapturedAt: '2026-09-04T10:00:00.000Z',
  });
});

test('runnerSessionContextPatch refuses half a binding rather than writing an unusable id', () => {
  assert.equal(
    runnerSessionContextPatch({ runnerSessionId: 'sess-1', runnerSessionPath: null }, 'launch'),
    null,
  );
  assert.equal(
    runnerSessionContextPatch({ runnerSessionId: null, runnerSessionPath: '/p.jsonl' }, 'launch'),
    null,
  );
  assert.equal(
    runnerSessionContextPatch({ runnerSessionId: null, runnerSessionPath: null }, 'launch'),
    null,
  );
});

test('recordRunnerSessionForRole writes the binding onto the requested role', async () => {
  const { calls, upsert } = recordingUpsert();

  await recordRunnerSessionForRole(
    {
      runId: 'run-1',
      role: 'review-fix',
      session: { runnerSessionId: 'sess-2', runnerSessionPath: '/sessions/sess-2.jsonl' },
      captureLabel: 'review fix relaunch',
      now: FIXED_NOW,
    },
    { upsert },
  );

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.runId, 'run-1');
  assert.equal(calls[0]?.role, 'review-fix');
  assert.deepEqual(calls[0]?.patch, {
    runnerSessionId: 'sess-2',
    runnerSessionPath: '/sessions/sess-2.jsonl',
    runnerSessionCapturedAt: '2026-09-04T10:00:00.000Z',
  });
});

test('recordRunnerSessionForRole writes nothing when capture produced no binding', async () => {
  const { calls, upsert } = recordingUpsert();

  const result = await recordRunnerSessionForRole(
    {
      runId: 'run-1',
      role: 'primary',
      session: { runnerSessionId: null, runnerSessionPath: null },
      captureLabel: 'dispatch launch',
    },
    { upsert },
  );

  assert.equal(result, null);
  assert.equal(calls.length, 0);
});

test('an exact launch pane is retained even before the transcript is available', async () => {
  const { run, fix } = aliasFixture();
  fix.runnerSessionId = null;
  fix.runnerSessionPath = null;
  const { calls, upsert } = recordingUpsert();
  await recordRunnerSessionForRole(
    {
      runId: run.id,
      role: 'review-fix',
      contextId: fix.id,
      session: { runnerSessionId: null, runnerSessionPath: null },
      paneId: '%42',
      captureLabel: 'launch before transcript creation',
    },
    { upsert, readRun: () => run },
  );
  assert.deepEqual(
    calls.map((call) => call.patch),
    [{ id: fix.id, target: { ...fix.target, paneId: '%42' } }],
  );
});

function aliasFixture() {
  const primary = {
    id: 'dev',
    role: 'dev',
    slotId: 'slot-1',
    runner: 'claude',
    runnerSessionId: 'worker-session',
    runnerSessionPath: '/sessions/worker.jsonl',
    target: { session: 'slot-session', window: 'dev', paneId: '%41', target: 'slot-session:dev' },
  } as AgentContext;
  const fix = {
    ...primary,
    id: 'review-fix',
    role: 'review-fix',
    target: { session: 'slot-session', window: 'dev', pane: null, target: 'slot-session:dev' },
  } as AgentContext;
  const run = {
    id: 'run-1',
    slotId: 'slot-1',
    flowType: 'dev',
    agentContexts: [primary, fix],
  } as Run;
  return { run, primary, fix };
}

test('the session recorder preserves the primary exact pane when a fix role adopts its binding', async () => {
  const { run, fix } = aliasFixture();
  fix.runnerSessionId = null;
  fix.runnerSessionPath = null;
  const { calls, upsert } = recordingUpsert();
  await recordRunnerSessionForRole(
    {
      runId: run.id,
      role: 'review-fix',
      session: { runnerSessionId: 'worker-session', runnerSessionPath: '/sessions/worker.jsonl' },
      captureLabel: 'retained worker',
    },
    { upsert, readRun: () => run },
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].patch.target?.paneId, '%41');
});

test('exact-pane capture records a relaunched fix pane with its newly captured conversation', async () => {
  const { run } = aliasFixture();
  const { calls, upsert } = recordingUpsert();
  const capture = async () => ({
    runnerSessionId: 'new-worker',
    runnerSessionPath: '/sessions/new-worker.jsonl',
  });
  await captureAndRecordRunnerSession(
    {
      vars: { slotId: 'slot-1' } as never,
      runner: 'claude',
      runId: run.id,
      role: 'review-fix',
      captureLabel: 'relaunch',
      capture: { paneId: '%42' },
    },
    { upsert, capture, readRun: () => run },
  );
  assert.equal(calls[0].patch.runnerSessionId, 'new-worker');
  assert.equal(calls[0].patch.target?.paneId, '%42');
});

test('session target resolution refuses partial or ambiguous alias evidence', () => {
  const { run, primary, fix } = aliasFixture();
  primary.runnerSessionPath = null;
  assert.equal(runnerSessionContextTarget(run, fix), null);
  primary.runnerSessionPath = fix.runnerSessionPath;
  run.agentContexts!.push({
    ...primary,
    id: 'other',
    target: { ...primary.target!, paneId: '%43' },
  });
  assert.equal(runnerSessionContextTarget(run, fix), null);
});

test('captureAndRecordRunnerSession captures once and records the captured pair', async () => {
  const { calls, upsert } = recordingUpsert();
  const captured: RunnerSessionMetadata = {
    runnerSessionId: 'sess-3',
    runnerSessionPath: '/sessions/sess-3.jsonl',
  };
  let captureCount = 0;
  const capture = (async () => {
    captureCount += 1;
    return captured;
  }) as unknown as CaptureAndRecordRunnerSessionDeps['capture'];

  const result = await captureAndRecordRunnerSession(
    {
      vars: { slotId: 'macpro-mm-1' } as never,
      runner: 'codex',
      runId: 'run-2',
      role: 'ci-fix',
      captureLabel: 'ci fix relaunch',
      capture: { paneId: '%7', slotId: 'macpro-mm-1' },
      now: FIXED_NOW,
    },
    { capture, upsert },
  );

  assert.equal(captureCount, 1);
  assert.deepEqual(result, captured);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.role, 'ci-fix');
  assert.equal(calls[0]?.patch.runnerSessionId, 'sess-3');
  assert.equal(calls[0]?.patch.runnerSessionCapturedAt, '2026-09-04T10:00:00.000Z');
});

test('captureAndRecordRunnerSession leaves the role untouched when nothing was captured', async () => {
  const { calls, upsert } = recordingUpsert();
  const capture = (async () => ({
    runnerSessionId: null,
    runnerSessionPath: null,
  })) as unknown as CaptureAndRecordRunnerSessionDeps['capture'];

  const result = await captureAndRecordRunnerSession(
    {
      vars: { slotId: 'macpro-mm-1' } as never,
      runner: 'codex',
      runId: 'run-2',
      role: 'ci-fix',
      captureLabel: 'ci fix relaunch',
    },
    { capture, upsert },
  );

  assert.deepEqual(result, { runnerSessionId: null, runnerSessionPath: null });
  assert.equal(calls.length, 0);
});

test('a non-canonical context id targets that exact reviewer context', async () => {
  const { calls, upsert } = recordingUpsert();

  await recordRunnerSessionForRole(
    {
      runId: 'run-1',
      role: 'review',
      contextId: 'rev2-codex',
      label: 'Reviewer 2',
      session: { runnerSessionId: 'sess-9', runnerSessionPath: '/sessions/sess-9.jsonl' },
      captureLabel: 'reviewer live session bind',
      now: FIXED_NOW,
    },
    { upsert },
  );

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.role, 'review');
  // Without the id the hook would collapse every reviewer generation onto the
  // canonical `review` context and lose the individual sessions.
  assert.equal(calls[0]?.patch.id, 'rev2-codex');
  assert.equal(calls[0]?.patch.label, 'Reviewer 2');
  assert.equal(calls[0]?.patch.runnerSessionId, 'sess-9');
});

test('clearing a session drops the capture timestamp with the id and path', () => {
  const cleared = clearedRunnerSessionContextPatch();

  assert.deepEqual(cleared, {
    runnerSessionId: null,
    runnerSessionPath: null,
    runnerSessionCapturedAt: undefined,
  });
  // upsertAgentContext merges patches: leaving capturedAt out would date a
  // session the respawn already destroyed.
  assert.ok('runnerSessionCapturedAt' in cleared);
});

/**
 * The spec requires ONE hook to own session identity. These guard the call
 * sites that previously wrote the fields by hand (and so silently skipped the
 * capture stamp) or did not record at all.
 */
const GATEWAY_SRC = path.resolve(import.meta.dirname, '..');

function gatewaySource(relativePath: string): string {
  return readFileSync(path.join(GATEWAY_SRC, relativePath), 'utf8');
}

test('the branch-affinity nudge records its retained binding through the hook', () => {
  const source = gatewaySource('methods/dispatch/nudge.ts');

  assert.match(source, /runnerSessionContextPatch\(/);
  assert.match(source, /'branch-affinity nudge retained session'/);
  // The nudged run used to inherit the worker but not its session, so
  // `run session` reported session-not-captured for a live worker.
  assert.doesNotMatch(source, /nudgeCount: priorNudgeCount \+ 1,\n\s+\}\);/);
});

test('every runner-respawn site clears the session identity as one unit', () => {
  for (const file of [
    'methods/dispatch/execute.ts',
    'ci-monitor/inline-fix.ts',
    'review/orchestrator.ts',
  ]) {
    const source = gatewaySource(file);
    assert.match(source, /clearedRunnerSessionContextPatch\(\)/, `${file} must clear via the hook`);
    // A bare id/path null pair next to an agent-context write leaves the stale
    // capture timestamp behind, because upsertAgentContext merges patches.
    assert.doesNotMatch(
      source,
      /runnerSessionId: null,\n\s+runnerSessionPath: null,\n\s+target:/,
      `${file} still nulls id/path without the capture stamp`,
    );
  }
});
