import assert from 'node:assert/strict';
import net from 'node:net';
import test from 'node:test';

import { checkPortStatus, startResourceWatch, stopAllResourceWatches } from './resource-watch.js';

function listenOnLoopback(): Promise<{ server: net.Server; port: number }> {
  return new Promise((resolve, reject) => {
    const server = net.createServer((socket) => socket.end());
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('expected TCP address'));
        return;
      }
      resolve({ server, port: address.port });
    });
  });
}

test('checkPortStatus detects an open TCP listener', async () => {
  const { server, port } = await listenOnLoopback();
  try {
    assert.equal(await checkPortStatus(port), 'running');
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }
});

test('checkPortStatus reports stopped for an invalid port', async () => {
  assert.equal(await checkPortStatus(0), 'stopped');
});

test('startResourceWatch replaces the complete slot watch set, including with empty', () => {
  try {
    assert.equal(
      startResourceWatch(
        'slot-a',
        [
          { id: 'metro', watch: { type: 'port-listen', port: 1, intervalMs: 60_000 } },
          { id: 'cdp', watch: { type: 'port-listen', port: 2, intervalMs: 60_000 } },
        ],
        () => {},
      ),
      2,
    );
    assert.equal(
      startResourceWatch('slot-a', [], () => {}),
      0,
    );
  } finally {
    stopAllResourceWatches();
  }
});
