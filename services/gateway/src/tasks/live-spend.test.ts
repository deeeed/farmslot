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

test('catching up reads several chunks in one read and still waits the interval', async () => {
  resetLiveSpend();
  const node = remoteTranscript();
  // More than one 512 KB chunk of records.
  for (let i = 0; i < 6000; i++)
    node.write(assistant(1 + (i % 50), 0.001).replace(/"id":"m\d+"/, `"id":"u${i}"`));
  const source = { key: 'catch', runner: 'pi', path: '/s.jsonl', marks: [] };
  const first = await liveSpendFor(node.io, source, 0);
  const afterFirst = node.requests();
  assert.ok(afterFirst > 1 && afterFirst <= 8, `one read took ${afterFirst} chunks`);
  assert.equal(first.toolCalls, 6000);
  assert.equal(first.behindBytes, undefined);
  for (const now of [10, 20, 14_000]) await liveSpendFor(node.io, source, now);
  assert.equal(node.requests(), afterFirst, 'polls inside the interval read nothing');
});

test('a replaced transcript is read again from its start within the same read', async () => {
  resetLiveSpend();
  let identity = '1:1';
  let content = assistant(1, 0.01) + assistant(2, 0.01);
  const io: SlotLocality = {
    host: 'node.invalid',
    machine: 'live-spend-node',
    sshTarget: 'node.invalid',
    nodeRequest: async (_method, params) => {
      const { offset, length } = params as { offset: number; length: number };
      const bytes = Buffer.from(content).subarray(offset, offset + length);
      return {
        content: bytes.toString('base64'),
        size: Buffer.byteLength(content),
        offset,
        bytesRead: bytes.length,
        eof: true,
        fileIdentity: identity,
      };
    },
  };
  const source = { key: 'rot', runner: 'pi', path: '/s.jsonl', marks: [] };
  assert.equal((await liveSpendFor(io, source, 0)).toolCalls, 2);
  identity = '1:2';
  content = assistant(3, 0.01);
  assert.equal((await liveSpendFor(io, source, LIVE_SPEND_READ_INTERVAL_MS)).toolCalls, 1);
});

function flakyNode() {
  let content = assistant(1, 0.01) + assistant(2, 0.01);
  let down = false;
  const offsets: number[] = [];
  const io: SlotLocality = {
    host: 'node.invalid',
    machine: 'live-spend-node',
    sshTarget: 'node.invalid',
    nodeRequest: async (_method, params) => {
      const { offset, length } = params as { offset: number; length: number };
      offsets.push(offset);
      if (down) throw new Error('node request timed out');
      const size = Buffer.byteLength(content);
      if (offset > size) throw new Error(`fs.readChunk offset ${offset} beyond file size ${size}`);
      const bytes = Buffer.from(content).subarray(offset, offset + length);
      return {
        content: bytes.toString('base64'),
        size,
        offset,
        bytesRead: bytes.length,
        eof: true,
        fileIdentity: '1:1',
      };
    },
  };
  return {
    io,
    offsets,
    setDown: (value: boolean) => (down = value),
    truncate: (text: string) => (content = text),
  };
}

test('transport failures keep the reader and its offset', async () => {
  resetLiveSpend();
  const node = flakyNode();
  const source = { key: 'flaky', runner: 'pi', path: '/s.jsonl', marks: [] };
  const first = await liveSpendFor(node.io, source, 0);
  const offset = node.offsets.at(-1)! + Buffer.byteLength(assistant(1, 0.01) + assistant(2, 0.01));
  node.setDown(true);
  for (const step of [1, 2, 3]) {
    const spend = await liveSpendFor(node.io, source, step * LIVE_SPEND_READ_INTERVAL_MS);
    assert.match(spend.unavailable ?? '', /could not be read/);
    assert.equal(spend.toolCalls, first.toolCalls, 'numbers are kept through the outage');
  }
  node.setDown(false);
  await liveSpendFor(node.io, source, 4 * LIVE_SPEND_READ_INTERVAL_MS);
  assert.equal(node.offsets.at(-1), offset, 'the read resumes at its offset, not byte 0');
});

test('a transcript truncated below the offset is found by a probe and read again from 0', async () => {
  resetLiveSpend();
  const node = flakyNode();
  const source = { key: 'trunc', runner: 'pi', path: '/s.jsonl', marks: [] };
  assert.equal((await liveSpendFor(node.io, source, 0)).toolCalls, 2);
  node.truncate(assistant(3, 0.01).slice(0, 10));
  const after = await liveSpendFor(node.io, source, LIVE_SPEND_READ_INTERVAL_MS);
  assert.equal(after.unavailable, undefined);
  assert.equal(after.toolCalls, 0, 'the short file starts the count again');
});

test('a native session waits for its journal receipt and reads nothing', async () => {
  resetLiveSpend();
  const node = remoteTranscript();
  const spend = await liveSpendFor(
    node.io,
    {
      key: 'n',
      runner: 'codex',
      path: '/r.jsonl',
      marks: [],
      unavailable: 'Native sessions are counted from the node journal when the session ends',
    },
    0,
  );
  assert.equal(node.requests(), 0);
  assert.match(spend.unavailable ?? '', /node journal/);
});
