import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import test from 'node:test';
import { serveRemoteRange } from './remote-range-serving.js';

test('a tail of a large remote file requests only those bytes from the node', async () => {
  const size = 40 * 1024 * 1024;
  const reads: Array<{ offset: number; length: number }> = [];
  const server = createServer((req, res) => {
    void serveRemoteRange(
      req,
      res,
      { machine: 'node', root: '/allowed', relPath: 'build.log' },
      'text/plain',
      25 * 1024 * 1024,
      async (method, raw) => {
        const params = raw as { root: string; relPath: string; offset: number; length: number };
        assert.equal(params.root, '/allowed');
        assert.equal(params.relPath, 'build.log');
        if (method === 'fs.stat') return { size };
        assert.equal(method, 'fs.readChunk');
        reads.push({ offset: params.offset, length: params.length });
        return {
          offset: params.offset,
          size,
          bytesRead: params.length,
          content: Buffer.alloc(params.length, 'x').toString('base64'),
          eof: true,
        };
      },
    ).catch((error) => {
      res.writeHead(500);
      res.end(String(error));
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const address = server.address();
    assert(address && typeof address !== 'string');
    const response = await fetch(`http://127.0.0.1:${address.port}`, {
      headers: { Range: 'bytes=-65536' },
    });
    assert.equal(response.status, 206);
    assert.equal((await response.arrayBuffer()).byteLength, 65536);
    assert.equal(
      response.headers.get('Content-Range'),
      `bytes ${size - 65536}-${size - 1}/${size}`,
    );
    assert.deepEqual(reads, [{ offset: size - 65536, length: 65536 }]);
    const oversized = await fetch(`http://127.0.0.1:${address.port}`, {
      headers: { Range: 'bytes=-30000000' },
    });
    assert.equal(oversized.status, 413);
    await oversized.text();
    assert.equal(reads.length, 1);
  } finally {
    server.close();
    await once(server, 'close');
  }
});
