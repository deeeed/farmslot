import assert from 'node:assert/strict';
import test from 'node:test';

import type { AgentContext, AgentRole } from '@farmslot/protocol';

import type { upsertAgentContext } from '../agents/contexts.js';

import type { RunnerSessionMetadata } from './session-process.js';
import {
  captureAndRecordRunnerSession,
  type CaptureAndRecordRunnerSessionDeps,
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
      label: 'self-review fix relaunch',
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
      label: 'dispatch launch',
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
      label: 'ci fix relaunch',
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
      label: 'ci fix relaunch',
    },
    { capture, upsert },
  );

  assert.deepEqual(result, { runnerSessionId: null, runnerSessionPath: null });
  assert.equal(calls.length, 0);
});
