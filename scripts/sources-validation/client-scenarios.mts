/** Manual client proof. Delay real packets; never replace gateway responses or client state. */
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createServer, request as proxyRequest } from 'node:http';
import path from 'node:path';

import { WebSocket, WebSocketServer } from 'ws';

import type {
  RequestFrame,
  ResponseFrame,
  SourcesPinParams,
  SourcesPinResult,
  SourcesSyncParams,
  SourcesSyncResult,
} from '@farmslot/protocol';

type Scenario = 'web-partial' | 'native-partial' | 'native-stale';
interface ScenarioEvidence {
  request: RequestFrame;
  response?: ResponseFrame;
  freshRequest?: RequestFrame;
  freshResponse?: ResponseFrame;
}
interface PendingScenario {
  scenario: Scenario;
  fresh?: boolean;
  recover?: () => Promise<void>;
}
interface SourceClientScenarioOptions {
  output: string;
  gatewayPort: number;
  /** Disconnect a real owned execution node, returning its recovery operation. */
  interruptSync(): Promise<() => Promise<void>>;
  /** Publish a real competing pin before the prepared client command reaches the gateway. */
  racePin(command: SourcesPinParams): Promise<void>;
}

export async function startSourceClientScenarios(options: SourceClientScenarioOptions) {
  let armed: Scenario | undefined;
  let failure: string | undefined;
  const evidence: Partial<Record<Scenario, ScenarioEvidence>> = {};
  const sockets = new Set<WebSocket>();
  const work = new Set<Promise<void>>();
  const recoveries = new Set<() => Promise<void>>();
  let closing = false;
  const observe = (task: Promise<void>) => {
    work.add(task);
    void task.then(() => work.delete(task));
  };
  const persist = () =>
    writeFile(
      path.join(options.output, 'client-scenarios-evidence.json'),
      JSON.stringify({ evidence, failure }, null, 2) + '\n',
    );
  const server = createServer((request, response) => {
    const scenario = request.url?.slice('/arm/'.length) as Scenario;
    if (
      request.method === 'POST' &&
      request.url?.startsWith('/arm/') &&
      ['web-partial', 'native-partial', 'native-stale'].includes(scenario) &&
      !armed &&
      !failure
    ) {
      armed = scenario;
      delete evidence[scenario];
      response.end(JSON.stringify({ armed }));
    } else if (request.method === 'GET' && request.url === '/evidence') {
      response.end(JSON.stringify({ armed, evidence, failure }));
    } else if (request.url?.startsWith('/arm/')) {
      response.statusCode = 409;
      response.end('Unknown scenario, or another scenario is still armed or failed');
    } else {
      const upstream = proxyRequest(
        `http://127.0.0.1:${options.gatewayPort}${request.url}`,
        { method: request.method, headers: request.headers },
        (result) => {
          response.writeHead(result.statusCode ?? 502, result.headers);
          result.pipe(response);
        },
      );
      upstream.on('error', (error) => {
        failure = error.message;
        response.destroy(error);
      });
      request.pipe(upstream);
    }
  });
  const wss = new WebSocketServer({ server });
  wss.on('connection', (downstream) => {
    const upstream = new WebSocket(`ws://127.0.0.1:${options.gatewayPort}`);
    sockets.add(downstream);
    sockets.add(upstream);
    const ready = new Promise<void>((resolve, reject) => {
      upstream.once('open', resolve);
      upstream.once('error', reject);
      upstream.once('close', () =>
        reject(new Error('Client proof upstream closed before opening')),
      );
    });
    const pending = new Map<string, PendingScenario>();
    const fail = (error: unknown) => {
      if (!closing) failure = error instanceof Error ? error.message : String(error);
      downstream.terminate();
      upstream.terminate();
    };
    void ready.catch(fail);
    for (const [socket, peer] of [
      [downstream, upstream],
      [upstream, downstream],
    ]) {
      socket.on('error', fail);
      socket.on('close', () => {
        sockets.delete(socket);
        peer.terminate();
      });
    }
    // Each direction preserves packet order, including requests queued behind a delayed mutation.
    let incoming = Promise.resolve();
    downstream.on('message', (data, binary) => {
      incoming = incoming
        .then(async () => {
          await ready;
          if (!binary) {
            const command = JSON.parse(data.toString()) as RequestFrame;
            if (
              command.type === 'req' &&
              armed &&
              command.method === (armed === 'native-stale' ? 'sources.pin' : 'sources.sync')
            ) {
              const scenario = armed;
              armed = undefined;
              evidence[scenario] = { request: command };
              if (scenario === 'native-stale') {
                await options.racePin(command.params as SourcesPinParams);
                pending.set(command.id, { scenario });
              } else {
                const recover = await options.interruptSync();
                recoveries.add(recover);
                pending.set(command.id, { scenario, recover });
              }
            } else if (
              command.type === 'req' &&
              command.method === 'sources.pin' &&
              evidence['native-stale']?.response?.error?.code === 'SOURCE_STATE_STALE' &&
              !evidence['native-stale'].freshResponse
            ) {
              evidence['native-stale'].freshRequest = command;
              pending.set(command.id, { scenario: 'native-stale', fresh: true });
            }
          }
          if (upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary });
        })
        .catch(fail);
      observe(incoming);
    });
    let outgoing = Promise.resolve();
    upstream.on('message', (data, binary) => {
      outgoing = outgoing
        .then(async () => {
          if (!binary) {
            const frame = JSON.parse(data.toString()) as ResponseFrame;
            const operation = frame.type === 'res' ? pending.get(frame.id) : undefined;
            if (operation) {
              pending.delete(frame.id);
              const record = evidence[operation.scenario]!;
              if (operation.fresh) record.freshResponse = frame;
              else record.response = frame;
              // Recovery finishes before the untouched acknowledgement reaches the UI's refresh.
              if (operation.recover) {
                await operation.recover();
                recoveries.delete(operation.recover);
              }
              await persist();
            }
          }
          if (downstream.readyState === WebSocket.OPEN) downstream.send(data, { binary });
        })
        .catch(fail);
      observe(outgoing);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  await writeFile(
    path.join(options.output, 'client-scenario-control.json'),
    JSON.stringify({ origin: `http://127.0.0.1:${port}` }) + '\n',
  );
  return {
    port,
    async close() {
      closing = true;
      for (const socket of sockets) socket.terminate();
      try {
        await Promise.all(work);
        for (const recover of recoveries) await recover();
        await persist();
      } finally {
        await new Promise<void>((resolve) => wss.close(() => resolve()));
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      }
    },
  };
}

async function scenarioCommand(action: string): Promise<void> {
  const output = process.env.SOURCE_PROOF_ROOT;
  assert(output, 'SOURCE_PROOF_ROOT must identify the owned fleet proof');
  // This file contains only a localhost control origin, never gateway credentials.
  const { origin } = JSON.parse(
    await readFile(path.join(output, 'client-scenario-control.json'), 'utf8'),
  ) as { origin: string };
  assert(/^http:\/\/127\.0\.0\.1:\d+$/.test(origin));
  if (action.startsWith('arm-')) {
    const response = await fetch(`${origin}/arm/${action.slice(4)}`, { method: 'POST' });
    assert.equal(response.status, 200, await response.text());
  } else {
    const response = await fetch(`${origin}/evidence`);
    const state = (await response.json()) as {
      failure?: string;
      evidence: Partial<Record<Scenario, ScenarioEvidence>>;
    };
    assert.equal(state.failure, undefined);
    const scenario = action === 'assert-native-fresh' ? 'native-stale' : action.slice(7);
    const record = state.evidence[scenario as Scenario];
    assert(record?.response, 'The real gateway must have answered the client operation');
    if (scenario.endsWith('partial')) {
      assert.equal(record.response.ok, true);
      const result = record.response.payload as SourcesSyncResult;
      assert(result.errors.length > 0, 'The real node failure must produce sync diagnostics');
      assert.equal(result.operationId, (record.request.params as SourcesSyncParams).operationId);
    } else {
      assert.equal(record.response.error?.code, 'SOURCE_STATE_STALE');
      if (action === 'assert-native-fresh') {
        assert.equal(record.freshResponse?.ok, true);
        const stale = record.request.params as SourcesPinParams;
        const fresh = record.freshRequest?.params as SourcesPinParams;
        assert(fresh);
        assert.notEqual(fresh.operationId, stale.operationId);
        assert(fresh.expectedPinRevision > stale.expectedPinRevision);
        assert.equal(
          (record.freshResponse.payload as SourcesPinResult).operationId,
          fresh.operationId,
        );
      }
    }
  }
  console.log(JSON.stringify({ result: 'PASS', action }));
}

if (process.argv[1]?.endsWith('/client-scenarios.mts'))
  scenarioCommand(process.argv[2]).catch((error: Error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
