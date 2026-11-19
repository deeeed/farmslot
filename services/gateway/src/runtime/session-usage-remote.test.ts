import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { mock, test } from 'node:test';

import type { Run } from '@farmslot/protocol';

import type { SlotVars } from '../core/config.js';
import type { RecoveredUsageSession } from '../runners/session-usage-provider.js';

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

test('remote receipt limits preserve totals and prefer an available verified archive', async (t) => {
  const vars = { host: 'remote.example', machine: 'remote-test', resourceVars: {} } as SlotVars;
  const root = await mkdtemp(path.join(os.tmpdir(), 'remote-receipt-archive-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'worker.jsonl');
  const archived = path.join(root, 'archive.jsonl');
  const sessions = [source, '/worker/sibling.jsonl'].map((runnerSessionPath, index) => ({
    contextId: 'dev',
    runnerSessionId: String(index),
    runnerSessionPath,
  }));
  t.mock.method(claudeSessionUsageProvider, 'recoverSessions', async () => sessions);
  const totalsOnly = {
    attribution: 'issuedAt',
    toolCalls: 5,
    toolCallsByName: { shell: 5 },
    toolCallsBeforeFirstMark: null,
    untimedToolCalls: 0,
    steps: [],
  };
  result = {
    stdout: `turns=1\ntotal_tokens=9\ntool_usage=${JSON.stringify(totalsOnly)}\nreceipt_detail_limited=yes\n`,
    stderr: '',
    exitCode: 0,
  };
  const run = makeRun({
    flowType: 'dev',
    slotId: 'remote-test',
    metrics: { nudgeCount: 0, runner: 'claude', model: 'claude-opus-5-5' },
  });
  const step = {
    segment: 'before-first-mark',
    stepNumber: 1,
    title: 'Parent',
    markedAt: '2026-11-19T00:00:05.000Z',
    startedAt: '2026-11-19T00:00:00.000Z',
    endedAt: '2026-11-19T00:00:05.000Z',
    wallMs: 5000,
    toolCalls: 1,
    toolCallsByName: { shell: 1 },
    totalTokens: 9,
  };
  t.mock.method(
    claudeSessionUsageProvider,
    'recoverArchive',
    async (_run: Run, session: RecoveredUsageSession) => {
      if (session.runnerSessionPath === source) return undefined;
      return path.join(root, 'missing.jsonl');
    },
  );
  const bounded = await extractRunWorkerSessionUsage(run, vars);
  assert.equal(bounded?.totalTokens, 18);
  assert.equal(bounded?.toolUsage?.toolCalls, 10);
  assert.equal(bounded?.toolUsage?.toolCallsBeforeFirstMark, null);

  await writeFile(
    archived,
    JSON.stringify({
      type: 'assistant',
      timestamp: step.startedAt,
      message: {
        id: 'message',
        model: 'claude-opus-5-5',
        usage: { input_tokens: 3, output_tokens: 6 },
        content: Array.from({ length: 5 }, (_, index) => ({
          type: 'tool_use',
          id: 'tool-' + index,
          name: 'shell',
          input: {},
        })),
      },
    }) + '\n',
  );
  const archiveMock = t.mock.method(
    claudeSessionUsageProvider,
    'recoverArchive',
    async (_run: Run, session: RecoveredUsageSession) =>
      session.runnerSessionPath === source ? archived : undefined,
  );
  run.metrics.checklistTiming = {
    schemaVersion: 1,
    events: [{ stepNumber: 1, label: step.title, checkedAt: step.endedAt }],
  };
  const measured: Array<{ detail: number; path: string | null | undefined }> = [];
  const detailed = await extractRunWorkerSessionUsage(run, vars, (_session, usage) => {
    measured.push({ detail: usage.toolUsage?.steps.length ?? 0, path: usage.runnerSessionPath });
  });
  assert.equal(archiveMock.mock.callCount(), 2);
  assert.equal(detailed?.totalTokens, 18);
  assert.equal(detailed?.toolUsage?.toolCalls, 10);
  assert.ok(measured.some((receipt) => receipt.path === source && receipt.detail > 0));
  assert.equal(detailed?.toolUsage?.toolCallsBeforeFirstMark, null);
  assert.deepEqual(detailed?.toolUsage?.steps, []);
});
