import assert from 'node:assert/strict';
import test from 'node:test';

import { TEXT_PREVIEW_RANGE, textPreviewChunks, textPreviewTotalBytes } from './text-preview';

test('a long log is drawn in blocks of at most 50 lines, cut after a newline', () => {
  const log = 'fixture log line\n'.repeat(120);
  const chunks = textPreviewChunks(log);
  assert.deepEqual(
    chunks.map((chunk) => chunk.split('\n').length - 1),
    [50, 50, 20],
  );
  assert.ok(chunks.every((chunk) => chunk.endsWith('\n')));
  assert.equal(chunks.join(''), log);
});

test('a block holds at most 2,000 characters, even within one long line', () => {
  const line = 'x'.repeat(4_500);
  assert.deepEqual(
    textPreviewChunks(line).map((chunk) => chunk.length),
    [2_000, 2_000, 500],
  );
  const mixed = `${'a'.repeat(1_500)}\n${'b'.repeat(1_000)}\n`;
  assert.deepEqual(textPreviewChunks(mixed), [`${'a'.repeat(1_500)}\n`, `${'b'.repeat(1_000)}\n`]);
});

test('short and empty texts stay whole', () => {
  assert.deepEqual(textPreviewChunks('one line'), ['one line']);
  assert.deepEqual(textPreviewChunks(''), []);
});

test('the preview asks for the first 200,000 bytes only', () => {
  assert.equal(TEXT_PREVIEW_RANGE, 'bytes=0-199999');
});

test('a ranged answer carries the file total, truncated or not', () => {
  assert.equal(textPreviewTotalBytes(206, 'bytes 0-199999/262144'), 262_144);
  assert.equal(textPreviewTotalBytes(206, 'bytes 0-47/48'), 48);
});

test('an empty file answers the range as unsatisfiable', () => {
  assert.equal(textPreviewTotalBytes(416, 'bytes */0'), 0);
  assert.throws(() => textPreviewTotalBytes(416, 'bytes */10'), /HTTP 416/);
});

test('a whole-file answer is refused rather than decoded', () => {
  assert.throws(() => textPreviewTotalBytes(200, null), /ignored the byte range/);
});

test('errors and malformed ranges are reported', () => {
  assert.throws(() => textPreviewTotalBytes(404, null), /HTTP 404/);
  assert.throws(() => textPreviewTotalBytes(206, null), /Unexpected Content-Range: none/);
  assert.throws(
    () => textPreviewTotalBytes(206, 'bytes 10-20/30'),
    /Unexpected Content-Range: bytes 10-20\/30/,
  );
});
