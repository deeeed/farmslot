import assert from 'node:assert/strict';
import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import type { WorkerSessionHistoryMessage } from '../../../packages/protocol/src/index.js';

import { type CanaryTurnReceipt, firstBlindTool, readCanaryTurns } from './blind-dispatch-proof.js';

test('blind dispatch needs an assistant tool in structured provider evidence', () => {
  const claimed: WorkerSessionHistoryMessage = {
    id: 'text',
    role: 'assistant',
    text: 'I called bash and reached the model.',
  };
  const user: WorkerSessionHistoryMessage = {
    id: 'user',
    role: 'user',
    text: '',
    tools: [{ name: 'bash' }],
  };
  const tool: WorkerSessionHistoryMessage = {
    id: 'call',
    role: 'assistant',
    text: '',
    tools: [{ name: 'exec_command' }],
  };
  assert.equal(firstBlindTool({ source: 'transcript', messages: [claimed, user] }), undefined);
  for (const source of ['pane-degraded', 'unavailable', 'transcript-archive'] as const)
    assert.equal(firstBlindTool({ source, messages: [tool] }), undefined);
  assert.equal(firstBlindTool({ source: 'transcript', messages: [claimed, tool] }), tool);
  assert.equal(firstBlindTool({ source: 'structured-hook', messages: [tool] }), tool);
});

test('turn receipts keep normal usage counts and fence concurrent smoke reads', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'canary-turns-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'turns.jsonl');
  const cwd = '/fixture/owned-slot';
  assert.deepEqual(await readCanaryTurns(file, cwd), []);
  const current: CanaryTurnReceipt = {
    at: '2026-11-15T00:00:02Z',
    cwd,
    role: 'assistant',
    stopReason: 'toolUse',
    usage: { totalTokens: 10 },
    tools: [{ id: 'call-1', name: 'bash' }],
  };
  const old: CanaryTurnReceipt = { at: '2026-11-15T00:00:00Z', cwd, usage: { totalTokens: 5 } };
  const foreign = { ...current, cwd: '/fixture/other-slot' };
  await writeFile(
    file,
    [old, foreign, current].map((row) => JSON.stringify(row) + '\n').join('') +
      JSON.stringify(current),
  );
  assert.deepEqual(await readCanaryTurns(file, cwd), [old, current]);
  const since = Date.parse('2026-11-15T00:00:01Z');
  assert.deepEqual(await readCanaryTurns(file, cwd, since), [current]);
  await appendFile(file, '\n');
  assert.deepEqual(await readCanaryTurns(file, cwd, since), [current, current]);
});
