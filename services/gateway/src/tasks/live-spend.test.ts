import assert from 'node:assert/strict';
import test from 'node:test';

import type { SlotLocality } from '../core/slot-io.js';

import { LIVE_SPEND_READ_INTERVAL_MS, liveSpendFor, resetLiveSpend } from './live-spend.js';

/** A remote slot whose node serves fs.readChunk from a transcript that grows, counting requests. */
function remoteTranscript() {
  let content = '';
  let requests = 0;
  const io: SlotLocality = {
    host: 'node.invalid',
    machine: 'live-spend-node',
    sshTarget: 'node.invalid',
    nodeRequest: async (method, params) => {
      requests++;
      assert.equal(method, 'fs.readChunk');
      const { offset, length } = params as { offset: number; length: number };
      const bytes = Buffer.from(content).subarray(offset, offset + length);
      return {
        content: bytes.toString('base64'),
        size: Buffer.byteLength(content),
        offset,
        bytesRead: bytes.length,
        eof: offset + bytes.length >= Buffer.byteLength(content),
        fileIdentity: '1:1',
      };
    },
  };
  return {
    io,
    write: (text: string) => (content += text),
    requests: () => requests,
  };
}

const at = (seconds: number) => new Date(Date.UTC(2026, 10, 16, 0, 0, seconds)).toISOString();
const assistant = (seconds: number, cost: number, tool = 'bash') =>
  `${JSON.stringify({
    type: 'message',
    id: `m${seconds}`,
    timestamp: at(seconds),
    message: {
      role: 'assistant',
      content: [{ type: 'toolCall', id: `c${seconds}`, name: tool }],
      usage: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0, cost: { total: cost } },
    },
  })}\n`;

test('live spend reads only appended bytes, at most once per interval, and splits by marks', async () => {
  resetLiveSpend();
  const node = remoteTranscript();
  const marks = [{ stepNumber: 1, label: '1. Read', checkedAt: at(10) }];
  const source = { key: 'run\u0000ctx\u0000/s.jsonl', runner: 'pi', path: '/s.jsonl', marks };
  node.write(assistant(1, 0.01));
  // A partial last line waits for the next read.
  const half = assistant(12, 0.02);
  node.write(half.slice(0, 40));
  const first = await liveSpendFor(node.io, source, 0);
  assert.equal(node.requests(), 1);
  assert.equal(first.toolCalls, 1);
  assert.equal(first.totalTokens, 110);
  // Three viewers polling within the interval cost no node request.
  for (const now of [1000, 5000, 14_000]) await liveSpendFor(node.io, source, now);
  assert.equal(node.requests(), 1);
  node.write(half.slice(40));
  node.write(assistant(13, 0.03, 'edit'));
  const second = await liveSpendFor(node.io, source, LIVE_SPEND_READ_INTERVAL_MS);
  assert.equal(node.requests(), 2);
  assert.equal(second.toolCalls, 3);
  assert.equal(second.compactions, 0);
  assert.ok(Math.abs((second.costUsd ?? 0) - 0.06) < 1e-9);
  assert.deepEqual(
    second.steps.map((step) => [step.segment, step.stepNumber ?? null, step.toolCalls]),
    [
      ['before-first-mark', 1, 1],
      ['after-last-mark', null, 2],
    ],
  );
});

test('a transcript not written yet is reported, and read on the next interval', async () => {
  resetLiveSpend();
  const io: SlotLocality = {
    host: 'node.invalid',
    machine: 'live-spend-node',
    sshTarget: 'node.invalid',
    nodeRequest: async () => {
      throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    },
  };
  const spend = await liveSpendFor(
    io,
    { key: 'k', runner: 'pi', path: '/none.jsonl', marks: [] },
    0,
  );
  assert.equal(spend.unavailable, 'The session transcript is not written yet');
});

test('a runner without one appendable transcript says so instead of reading', async () => {
  resetLiveSpend();
  const node = remoteTranscript();
  const spend = await liveSpendFor(
    node.io,
    { key: 'g', runner: 'grok', path: '/dir', marks: [] },
    0,
  );
  assert.equal(node.requests(), 0);
  assert.match(spend.unavailable ?? '', /not one appendable transcript/);
});
