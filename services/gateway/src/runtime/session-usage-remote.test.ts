import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

import type { SlotVars } from '../core/config.js';

const nativeExec = await import('../core/exec.js');
const calls: unknown[][] = [];
let result = { stdout: 'turns=3\ntotal_tokens=124\n', stderr: '', exitCode: 0 };
mock.module('../core/exec.js', {
  namedExports: {
    ...nativeExec,
    isLocal: () => false,
    execOnSlot: async (...args: unknown[]) => {
      calls.push(args);
      return result;
    },
  },
});
const { extractRunnerSessionUsage, extractRunWorkerSessionUsage } =
  await import('./session-usage.js');
const { makeRun } = await import('../run-completion/test-fixtures.js');
const { claudeSessionUsageProvider } = await import('../runners/session-usage-provider.js');

test('remote usage uses supported node execution and preserves slot support selection', async () => {
  const vars = { host: 'remote.example', machine: 'remote-test', resourceVars: {} } as SlotVars;
  const parent = { stepNumber: 1, label: 'Parent step', checkedAt: '2026-11-19T00:00:00.000Z' };
  const child = { ...parent, label: 'Child rule' };
  const usage = await extractRunnerSessionUsage({
    slotId: 'slot-1',
    vars,
    runner: 'codex',
    runnerSessionId: 'conversation',
    runnerSessionPath: "/tmp/native session's.jsonl",
    checklistMarks: [child],
    parentChecklistMarks: [parent],
  });
  assert.equal(usage.turns, 3);
  assert.equal(usage.totalTokens, 124);
  assert.equal(usage.runnerSessionId, 'conversation');
  assert.equal(calls[0][0], vars);
  assert.match(String(calls[0][1]), /runSessionUsage/);
  assert.ok(
    String(calls[0][1]).includes(
      JSON.stringify({ maxBytes: 64 * 1024, parentChecklistMarks: [parent] }),
    ),
  );
  assert.equal(String(calls[0][1]).includes('scripts/session-usage.sh'), false);
  assert.deepEqual(calls[0][2], {
    timeout: 30_000,
    maxBuffer: 64 * 1024,
    selectNodeSupport: false,
  });
  result = { stdout: '', stderr: 'node transcript unavailable', exitCode: 1 };
  const failed = await extractRunnerSessionUsage({
    slotId: 'slot-1',
    vars,
    runner: 'codex',
    runnerSessionPath: '/tmp/native.jsonl',
  });
  assert.equal(failed.source, 'unavailable');
  assert.match(failed.error ?? '', /node transcript unavailable/);
  assert.equal(failed.turns, undefined);
});

test('successful limited receipts keep fresh totals and skip stored detail and archive reads', async (t) => {
  const vars = { host: 'remote.example', machine: 'remote-test', resourceVars: {} } as SlotVars;
  const sessions = ['/worker/remote.jsonl', '/worker/sibling.jsonl'].map(
    (runnerSessionPath, index) => ({
      contextId: 'dev',
      runnerSessionId: String(index),
      runnerSessionPath,
    }),
  );
  t.mock.method(claudeSessionUsageProvider, 'recoverSessions', async () => sessions);
  const archive = t.mock.method(
    claudeSessionUsageProvider,
    'recoverArchive',
    async () => undefined,
  );
  const totalsOnly = {
    attribution: 'issuedAt',
    toolCalls: 5,
    compactions: 1,
    toolCallsByName: { shell: 5 },
    toolCallsBeforeFirstMark: null,
    untimedToolCalls: 0,
    steps: [],
  };
  result = {
    stdout: `turns=1\ntotal_tokens=9\ncost_usd=0.02\nmodel=remote-priced-model\ntool_usage=${JSON.stringify(totalsOnly)}\nreceipt_detail_limited=yes\n`,
    stderr: '',
    exitCode: 0,
  };
  const run = makeRun({
    flowType: 'dev',
    slotId: 'remote-test',
    metrics: { nudgeCount: 0, runner: 'claude', model: 'claude-opus-5-5' },
  });
  const detail = {
    ...totalsOnly,
    attribution: 'issuedAt' as const,
    toolCallsBeforeFirstMark: 5,
    steps: [
      {
        segment: 'before-first-mark' as const,
        startedAt: '2026-11-19T00:00:00.000Z',
        endedAt: '2026-11-19T00:00:01.000Z',
        wallMs: 1000,
        stepNumber: 1,
        title: 'Obsolete checklist row',
        markedAt: '2026-11-19T00:00:01.000Z',
        toolCalls: 5,
        toolCallsByName: { shell: 5 },
        totalTokens: 9,
      },
    ],
  };
  run.sessionUsage = sessions.map((session) => ({
    runner: 'claude',
    runnerSessionPath: session.runnerSessionPath,
    runnerSessionId: session.runnerSessionId,
    measuredAt: '2026-11-19T00:00:00.000Z',
    source: 'runner-transcript',
    scope: 'session-total',
    totalTokens: 9,
    costUsd: 0.02,
    actualModel: 'remote-priced-model',
    toolUsage: detail,
  }));
  for (let read = 0; read < 2; read++) {
    const usage = await extractRunWorkerSessionUsage(run, vars);
    assert.equal(usage?.totalTokens, 18);
    assert.equal(usage?.actualModel, 'remote-priced-model');
    assert.equal(usage?.costUsd, 0.04);
    assert.equal(usage?.toolUsage?.toolCalls, 10);
    assert.deepEqual(usage?.toolUsage?.steps, []);
    assert.equal(usage?.toolUsage?.toolCallsBeforeFirstMark, null);
    assert.match(usage?.captureGaps?.[0] ?? '', /exceeds the remote receipt limit/);
  }
  assert.equal(archive.mock.callCount(), 0);
});
