import assert from 'node:assert/strict';
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http';
import test from 'node:test';

import { mimeForPath, serveBufferWithRange } from './range-serving.js';

function makeRequest(headers: IncomingHttpHeaders = {}): IncomingMessage {
  return { headers } as IncomingMessage;
}

function makeResponse(): {
  res: ServerResponse;
  status: () => number | undefined;
  headers: () => Record<string, string | number> | undefined;
  body: () => Buffer | string | undefined;
} {
  let writtenStatus: number | undefined;
  let writtenHeaders: Record<string, string | number> | undefined;
  let writtenBody: Buffer | string | undefined;

  return {
    res: {
      writeHead(status: number, headers: Record<string, string | number>) {
        writtenStatus = status;
        writtenHeaders = headers;
        return this as ServerResponse;
      },
      end(chunk?: Buffer | string) {
        writtenBody = chunk;
        return this as ServerResponse;
      },
    } as ServerResponse,
    status: () => writtenStatus,
    headers: () => writtenHeaders,
    body: () => writtenBody,
  };
}

test('mimeForPath maps known media extensions and falls back to octet-stream', () => {
  assert.equal(mimeForPath('proof.PNG'), 'image/png');
  assert.equal(mimeForPath('clip.webm'), 'video/webm');
  assert.equal(mimeForPath('archive.bin'), 'application/octet-stream');
});

test('serveBufferWithRange serves full buffers without a range header', () => {
  const response = makeResponse();

  serveBufferWithRange(makeRequest(), response.res, Buffer.from('abcdef'), 'text/plain');

  assert.equal(response.status(), 200);
  assert.equal(response.headers()?.['Content-Length'], 6);
  assert.equal(response.body()?.toString(), 'abcdef');
});

test('serveBufferWithRange serves inclusive byte ranges', () => {
  const response = makeResponse();

  serveBufferWithRange(
    makeRequest({ range: 'bytes=2-4' }),
    response.res,
    Buffer.from('abcdef'),
    'text/plain',
  );

  assert.equal(response.status(), 206);
  assert.equal(response.headers()?.['Content-Range'], 'bytes 2-4/6');
  assert.equal(response.body()?.toString(), 'cde');
});

test('serveBufferWithRange serves suffix byte ranges', () => {
  const response = makeResponse();

  serveBufferWithRange(
    makeRequest({ range: 'bytes=-2' }),
    response.res,
    Buffer.from('abcdef'),
    'text/plain',
  );

  assert.equal(response.status(), 206);
  assert.equal(response.headers()?.['Content-Range'], 'bytes 4-5/6');
  assert.equal(response.body()?.toString(), 'ef');
});

test('serveBufferWithRange rejects unsatisfiable byte ranges', () => {
  const response = makeResponse();

  serveBufferWithRange(
    makeRequest({ range: 'bytes=99-100' }),
    response.res,
    Buffer.from('abcdef'),
    'text/plain',
  );

  assert.equal(response.status(), 416);
  assert.equal(response.headers()?.['Content-Range'], 'bytes */6');
  assert.equal(response.body(), 'Requested Range Not Satisfiable');
});
