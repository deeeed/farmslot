// Exercise the production authenticated create route in a disposable gateway.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';

import type { RunCreateResult } from '@farmslot/protocol';
import type { GatewayConnection } from '../../../packages/cli/src/gateway-client.js';

const home = await mkdtemp(path.join(os.tmpdir(), 'ticket-data-rpc-'));
const output = path.resolve(process.env.FARMSLOT_PROOF_OUTPUT_DIR ?? 'temp/ticket-data-proof');
Object.assign(process.env, {
  NODE_TEST_CONTEXT: '1',
  FARMSLOT_DISABLE_RUN_ENGINE_START: '1',
  FARMSLOT_HOME: home,
  FARMSLOT_RUNS_DIR: path.join(home, 'runs'),
  FARMSLOT_PROJECTS_DIR: path.join(home, 'projects'),
  FARMSLOT_POOL_DIR: path.join(home, 'pool'),
  FARMSLOT_TEST_STATUS_FILE: path.join(home, 'status.json'),
});
await mkdir(path.join(home, 'projects', 'ticket-proof'), { recursive: true });
await mkdir(path.join(home, 'pool'));
await mkdir(output, { recursive: true });
await writeFile(path.join(home, 'status.json'), JSON.stringify({ slots: [] }));
await writeFile(path.join(output, 'scratch.json'), JSON.stringify({ home }) + '\n');
await writeFile(
  path.join(home, 'projects', 'ticket-proof', 'project.json'),
  JSON.stringify({ name: 'ticket-proof', default_branch: 'main', hooks: {} }),
);
const { createGatewayAuthRuntime } = await import('../../../services/gateway/src/security/auth.js');
const auth = createGatewayAuthRuntime({ FARMSLOT_HOME: home });
const person = auth.writer.createPrincipal({ type: 'person', displayName: 'Ticket proof' }, [
  { role: 'admin', scope: { kind: 'global' } },
]);
const secret = auth.writer.issueCredential(person.id, 'Disposable proof');
const grant = auth.writer.exchangePersonCredential(secret.secret, {
  deviceName: 'Proof',
  deviceKind: 'cli',
});
const store = await import('../../../services/gateway/src/runs/store.js');
const { mergeInitialContextIntoTicketData } =
  await import('../../../services/gateway/src/run-engine/task-steps.js');
const { createWebSocketServer } = await import('../../../services/gateway/src/server.js');
const { GatewayClient: Client } = await import('../../../packages/cli/src/gateway-client.js');
const server = createServer();
const wss = createWebSocketServer(server, auth);
let client: GatewayConnection | undefined;
const ticket = {
  source: 'manual',
  title: 'Caller-supplied task',
  description: '',
  acceptanceCriteria: [],
  affectedArea: '',
  stepsToReproduce: [],
  screenshots: [],
  labels: [],
};
const params = {
  project: 'ticket-proof',
  flowType: 'pr-complete',
  mode: 'autonomous',
  transport: 'tmux',
  ticketOrPr: 'example-org/ticket-proof#136',
  branch: 'fixture-published-branch',
};
try {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address !== 'string');
  client = await new Client({
    url: `ws://127.0.0.1:${address.port}/ws`,
    credential: { token: grant.accessToken },
    timeout: 30000,
  }).connect();
  const { description: _description, ...withoutDescription } = ticket;
  const missingDescription = {
    ...withoutDescription,
    acceptanceCriteria: ['Keep the caller-supplied criterion.'],
  };
  let accepted: RunCreateResult | undefined;
  let refusal: unknown;
  try {
    accepted = await client.call<RunCreateResult>('run.create', {
      ...params,
      ticketData: missingDescription,
    });
  } catch (error) {
    refusal = error;
  }
  if (accepted) {
    assert(accepted.run.ticketData);
    let writerError = '';
    try {
      mergeInitialContextIntoTicketData(accepted.run.ticketData, 'Retain the caller context.');
    } catch (error) {
      writerError = error instanceof Error ? error.message : String(error);
    }
    await writeFile(
      path.join(output, 'legacy-accepted.json'),
      JSON.stringify({ malformedTicketAccepted: true, writerError, modelTurns: 0 }, null, 2) + '\n',
    );
  }
  assert(
    refusal instanceof Error &&
      /Missing required field: ticketData\.description/.test(refusal.message),
  );
  assert.equal(store.getAllRuns().length, 0, 'Invalid input never registers a run');
  await assert.rejects(
    client.call('run.createNative', {
      ...params,
      transport: 'native',
      ticketData: missingDescription,
    }),
    /Missing required field: ticketData\.description/,
  );
  const valid = await client.call<RunCreateResult>('run.create', { ...params, ticketData: ticket });
  assert.deepEqual(valid.run.ticketData, ticket);
  assert.equal(valid.run.status, 'created');
  store.updateRun(valid.run.id, { status: 'done' });
  await store.deleteRun(valid.run.id);
  const omitted = await client.call<RunCreateResult>('run.create', params);
  assert.equal(
    omitted.run.ticketData,
    undefined,
    'Omitted ticket data keeps source-fetch behavior',
  );
  assert.equal(omitted.run.status, 'created');
  const result = {
    status: 'PASS',
    methods: ['run.create', 'run.createNative'],
    missingDescriptionNamedBeforeRegistration: true,
    validEmptyDescriptionAndArraysPreserved: true,
    omittedTicketDataSupported: true,
    modelTurns: 0,
    slotOperations: [],
    boundary:
      'Authenticated production gateway create route and store. Run-engine startup disabled in this private fixture; no worker delivery or product-run claim.',
  };
  await writeFile(path.join(output, 'result.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result));
} finally {
  client?.close();
  for (const connection of wss.clients) connection.terminate();
  await new Promise<void>((resolve) => wss.close(() => resolve()));
  await new Promise<void>((resolve) => server.close(() => resolve()));
  for (const run of store.getAllRuns()) {
    store.updateRun(run.id, { status: 'done' });
    await store.deleteRun(run.id);
  }
  await rm(home, { recursive: true, force: true });
  await writeFile(
    path.join(output, 'cleanup.json'),
    JSON.stringify({ home, removed: true }) + '\n',
  );
}
process.exit(0);
