import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import type { AgentContext, AgentRole } from '@farmslot/protocol';

import type { upsertAgentContext } from '../agents/contexts.js';

import type { RunnerSessionMetadata } from './session-process.js';
import {
  captureAndRecordRunnerSession,
  type CaptureAndRecordRunnerSessionDeps,
  clearedRunnerSessionContextPatch,
  recordRunnerSessionForRole,
  runnerSessionContextPatch,
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
      role: 'self-review-fix',
      session: { runnerSessionId: 'sess-2', runnerSessionPath: '/sessions/sess-2.jsonl' },
      captureLabel: 'self-review fix relaunch',
      now: FIXED_NOW,
    },
    { upsert },
  );

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.runId, 'run-1');
  assert.equal(calls[0]?.role, 'self-review-fix');
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
      role: 'self-review',
      contextId: 'rev2-codex',
      label: 'Reviewer 2',
      session: { runnerSessionId: 'sess-9', runnerSessionPath: '/sessions/sess-9.jsonl' },
      captureLabel: 'reviewer live session bind',
      now: FIXED_NOW,
    },
    { upsert },
  );

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.role, 'self-review');
  // Without the id the hook would collapse every reviewer generation onto the
  // canonical `self-review` context and lose the individual sessions.
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

test('reviewer session binding goes through the hook with its allocated context id', () => {
  const source = gatewaySource('self-review/review-agent.ts');

  assert.match(source, /recordRunnerSessionForRole\(\{/);
  assert.match(source, /contextId: allocated\.id/);
  assert.match(source, /'reviewer live session bind'/);
});

test('every runner-respawn site clears the session identity as one unit', () => {
  for (const file of [
    'methods/dispatch/execute.ts',
    'ci-monitor/inline-fix.ts',
    'self-review/orchestrator.ts',
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
