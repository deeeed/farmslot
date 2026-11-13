import assert from 'node:assert/strict';
import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import test from 'node:test';

import {
  PerformanceRecorder,
  renderPrometheus,
  slowestActions,
} from '@farmslot/protocol/performance';

import {
  GATEWAY_HTTP_METHODS,
  measureGatewayHttpRequest,
  measureManagedOperation,
  recordGatewayHttpRoute,
} from './performance.js';

test('HTTP routes count outcomes once and carry managed work without URL labels', async (t) => {
  const metrics = new PerformanceRecorder('gateway', { methods: new Set(GATEWAY_HTTP_METHODS) });
  const server = createServer((req, res) =>
    measureGatewayHttpRequest(
      res,
      () => {
        recordGatewayHttpRoute(
          req.url?.startsWith('/api/run-artifact?') ? 'http.run-artifact' : 'http.other',
        );
        void measureManagedOperation('exec', 'git', async () => 1).then(() => {
          res.writeHead(req.url?.includes('missing') ? 404 : 200);
          res.end('done');
        });
      },
      metrics,
    ),
  );
  t.after(() => {
    server.closeAllConnections();
    return new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}`;
  await Promise.all(
    [
      '/api/run-artifact?runId=private-run&path=private-path',
      '/api/run-artifact?path=missing',
      '/unknown?token=private-token',
    ].map(async (url) => {
      const response = await fetch(base + url);
      await response.text();
    }),
  );
  const snapshot = metrics.snapshot();
  const counts = snapshot.counters.filter((row) => row.name === 'farmslot_http_requests_total');
  assert.equal(
    counts.reduce((sum, row) => sum + row.value, 0),
    3,
  );
  assert.equal(
    counts.find(
      (row) => row.labels.method === 'http.run-artifact' && row.labels.status_class === '2xx',
    )?.value,
    1,
  );
  assert.equal(
    counts.find(
      (row) => row.labels.method === 'http.run-artifact' && row.labels.status_class === '4xx',
    )?.value,
    1,
  );
  const duration = snapshot.histograms.find(
    (row) =>
      row.name === 'farmslot_http_duration_seconds' && row.labels.method === 'http.run-artifact',
  );
  assert.equal(duration?.count, 2);
  assert.equal(
    duration?.labels.action_class,
    undefined,
    'older Doctor readers must skip unfamiliar HTTP histograms',
  );
  assert.equal(
    snapshot.counters.find(
      (row) =>
        row.name === 'farmslot_exec_calls_total' && row.labels.method === 'http.run-artifact',
    )?.value,
    2,
  );
  assert.equal(
    slowestActions(snapshot).find((row) => row.method === 'http.run-artifact')?.phase,
    'HTTP',
  );
  assert.doesNotMatch(
    renderPrometheus(snapshot),
    /private-run|private-path|private-token|\/api\/run-artifact/,
  );
});

test(
  'closing a streaming HTTP response records one aborted request',
  { timeout: 2000 },
  async (t) => {
    const metrics = new PerformanceRecorder('gateway', { methods: new Set(GATEWAY_HTTP_METHODS) });
    let closed!: () => void;
    const close = new Promise<void>((resolve) => {
      closed = resolve;
    });
    const server = createServer((_req, res) =>
      measureGatewayHttpRequest(
        res,
        () => {
          recordGatewayHttpRoute('http.file');
          res.once('close', closed);
          res.write('partial');
        },
        metrics,
      ),
    );
    t.after(() => {
      server.closeAllConnections();
      return new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const controller = new AbortController();
    t.after(() => controller.abort());
    const response = await fetch(`http://127.0.0.1:${address.port}/api/file?path=private`, {
      signal: controller.signal,
    });
    assert.equal(response.status, 200);
    controller.abort();
    await close;
    assert.equal(
      metrics
        .snapshot()
        .counters.find(
          (row) =>
            row.name === 'farmslot_http_requests_total' && row.labels.status_class === 'aborted',
        )?.value,
      1,
    );
  },
);

test('HTTP accounting preserves synchronous handler exceptions', () => {
  const metrics = new PerformanceRecorder('gateway', { methods: new Set(GATEWAY_HTTP_METHODS) });
  const socket = new Socket();
  const req = new IncomingMessage(socket);
  const res = new ServerResponse(req);
  const error = new Error('original');
  try {
    assert.throws(
      () =>
        measureGatewayHttpRequest(
          res,
          () => {
            throw error;
          },
          metrics,
        ),
      (caught) => caught === error,
    );
    assert.equal(
      metrics.snapshot().counters.find((row) => row.name === 'farmslot_http_requests_total')?.value,
      1,
    );
  } finally {
    socket.destroy();
  }
});
