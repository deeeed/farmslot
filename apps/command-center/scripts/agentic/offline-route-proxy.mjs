import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { Methods } from '@farmslot/protocol';
import { GATEWAY_READ_EXCEPTIONS, RESOURCE_QUERY_DEFINITIONS, resourceQuery } from '@farmslot/protocol/client-cache';

import { createOfflineSnapshotProxy } from '../../../../services/gateway/scripts/visual-reply-proxy.mjs';

assert.equal(process.env.FARMSLOT_OFFLINE_PROOF, '1');
const port = Number(process.env.FARMSLOT_OFFLINE_ROUTE_PROXY_PORT);
const upstreamPort = Number(process.env.FARMSLOT_OFFLINE_ROUTE_UPSTREAM_PORT);
const receipt = process.env.FARMSLOT_OFFLINE_ROUTE_PROXY_RECEIPT;
assert(Number.isSafeInteger(port) && port > 0 && port !== 7801 && port !== 5175);
assert(Number.isSafeInteger(upstreamPort) && upstreamPort > 0 && upstreamPort !== port);
assert(receipt && path.isAbsolute(receipt));
const exceptions = new Set(Object.values(GATEWAY_READ_EXCEPTIONS).flat());
const proxy = await createOfflineSnapshotProxy({
  upstreamPort,
  port,
  allowRequest(frame) {
    if (exceptions.has(frame.method) || [Methods.AUTH_CONNECT, Methods.AUTH_SESSION_EXCHANGE, Methods.RESOURCE_OBSERVERS_REPLACE].includes(frame.method))
      return true;
    if (!Object.hasOwn(RESOURCE_QUERY_DEFINITIONS, frame.method)) return false;
    try {
      // Shape validation only. Actual authority remains the upstream gateway's authenticated principal.
      resourceQuery(frame.method, frame.params, 'snapshot-shape-check');
      return true;
    } catch {
      // Imperative variants of read methods are outside a read-only snapshot fixture.
      return false;
    }
  },
});
await mkdir(path.dirname(receipt), { recursive: true });
const checkpoint = () => writeFile(receipt, JSON.stringify({ pid: process.pid, port, upstreamPort, ...proxy.state() }, null, 2));
await checkpoint();
console.log(JSON.stringify({ ready: true, pid: process.pid, port, upstreamPort }));
process.on('SIGUSR2', () => {
  proxy.setOffline(!proxy.state().offline);
  void checkpoint().catch((error) => { console.error(error); process.exitCode = 1; });
});
let closing = false;
const close = async () => {
  if (closing) return;
  closing = true;
  await checkpoint();
  await proxy.close();
};
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
  void close().catch((error) => { console.error(error); process.exitCode = 1; });
});
