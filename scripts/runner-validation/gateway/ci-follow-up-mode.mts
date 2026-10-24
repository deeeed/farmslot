// Manual authenticated CI-decision proof. Engine launch is suppressed after
// the production decision handler creates the follow-up run.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { mock } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
const code = fileURLToPath(new URL('../../../', import.meta.url));
const root = await mkdtemp(path.join(os.tmpdir(), 'ci-mode-proof-'));
const output = path.resolve(process.env.FARMSLOT_PROOF_OUTPUT_DIR ?? 'temp/ci-follow-up-mode');
Object.assign(process.env, {
  NODE_TEST_CONTEXT: '1',
  FARMSLOT_HOME: root,
  FARMSLOT_RUNS_DIR: path.join(root, 'runs'),
  FARMSLOT_PROJECTS_DIR: path.join(root, 'projects'),
  FARMSLOT_POOL_DIR: path.join(root, 'pool'),
  FARMSLOT_TEST_STATUS_FILE: path.join(root, 'status.json'),
});
for (const dir of ['pool', 'projects/proof', 'repo'])
  await mkdir(path.join(root, dir), { recursive: true });
await mkdir(output, { recursive: true });
await writeFile(
  path.join(root, 'pool/proof.json'),
  JSON.stringify({
    machine: 'local',
    host: 'localhost',
    ssh_user: os.userInfo().username,
    project: 'proof',
    platform: 'cli',
    slots: [{ id: 'mode-slot', repo: path.join(root, 'repo'), session: 'mode-slot' }],
  }),
);
await writeFile(
  path.join(root, 'projects/proof/project.json'),
  JSON.stringify({ name: 'proof', ci: { repo: 'owner/repo' }, hooks: {} }),
);
const load = (file: string) => import(pathToFileURL(path.join(code, file)).href);
const store = await load('services/gateway/src/runs/store.ts');
const engine = await load('services/gateway/src/run-engine/orchestrator.ts');
const started: string[] = [];
let notify: ((id: string) => void) | undefined;
mock.module(
  pathToFileURL(path.join(code, 'services/gateway/src/run-engine/orchestrator.ts')).href,
  {
    namedExports: {
      ...engine,
      startRun: async (id: string) => {
        started.push(id);
        notify?.(id);
      },
    },
  },
);
const { createGatewayAuthRuntime } = await load('services/gateway/src/security/auth.ts');
const auth = createGatewayAuthRuntime({ FARMSLOT_HOME: root });
const person = auth.writer.createPrincipal({ type: 'person', displayName: 'CI mode proof' }, [
  { role: 'admin', scope: { kind: 'global' } },
]);
const credential = auth.writer.issueCredential(person.id, 'Disposable proof');
const grant = auth.writer.exchangePersonCredential(credential.secret, {
  deviceName: 'Proof',
  deviceKind: 'cli',
});
const { createWebSocketServer } = await load('services/gateway/src/server.ts');
const { GatewayClient } = await load('packages/cli/src/gateway-client.ts');
const server = createServer(),
  wss = createWebSocketServer(server, auth);
let client;
const cases = [];
try {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address !== 'string');
  client = await new GatewayClient({
    url: `ws://127.0.0.1:${address.port}/ws`,
    credential: { token: grant.accessToken },
    timeout: 30000,
  }).connect();
  for (const mode of ['autonomous', 'interactive'] as const)
    for (const action of ['dispatch-update-branch', 'dispatch-pr-complete'] as const) {
      const parent = store.createRun(
        {
          project: 'proof',
          flowType: 'dev',
          mode,
          transport: 'tmux',
          runner: 'scripted',
          ticketOrPr: 'owner/repo#77',
          slotId: 'mode-slot',
          branch: 'fixture-branch',
        },
        { createdByPrincipalId: person.id, nativeOwnerPrincipalId: person.id },
      );
      const decisionId = randomUUID();
      store.updateRun(parent.id, {
        status: 'blocked',
        prNumber: 77,
        steps: [{ name: 'ci-watch', status: 'running' }],
        decisions: [
          {
            id: decisionId,
            type: action === 'dispatch-update-branch' ? 'ci_merge_conflict' : 'ci_ci_failed',
            title: 'Fixture CI gate',
            description: '',
            actions: [{ id: action, label: 'Continue', style: 'primary' }],
            createdAt: new Date().toISOString(),
          },
        ],
      });
      await writeFile(
        path.join(root, 'status.json'),
        JSON.stringify({
          slots: [
            { slot: 'mode-slot', current_run_id: parent.id, lifecycle: 'held', phase: 'ci-watch' },
          ],
        }),
      );
      const ready = new Promise<string>((resolve) => {
        notify = resolve;
      });
      await client.call('run.resolveDecision', { runId: parent.id, decisionId, actionId: action });
      let timer: ReturnType<typeof setTimeout> | undefined;
      let childId: string;
      try {
        childId = await Promise.race([
          ready,
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(
              () => reject(new Error('No suppressed child launch recorded')),
              10000,
            );
          }),
        ]);
      } finally {
        clearTimeout(timer);
        notify = undefined;
      }
      const { run: child } = await client.call('run.get', { runId: childId });
      const { run: settled } = await client.call('run.get', { runId: parent.id });
      assert.equal(child.mode, mode);
      assert.equal(child.parentRunId, parent.id);
      assert.equal(child.status, 'created');
      assert.equal(settled.status, 'done');
      assert.equal(settled.steps[0].outputs.chainedRunId, childId);
      cases.push({ mode, action, childFlow: child.flowType, childMode: child.mode });
    }
  assert.equal(started.length, 4);
  const result = {
    pass: true,
    methods: ['run.resolveDecision', 'run.get'],
    cases,
    scope:
      'Production authenticated decision/CI chain builder/store/family metadata. Only subsequent engine launch suppressed; no worker/model/slot preparation.',
    modelTurns: 0,
    productOperations: 0,
  };
  await writeFile(path.join(output, 'result.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result));
} finally {
  client?.close();
  for (const connection of wss.clients) connection.terminate();
  await new Promise<void>((resolve) => wss.close(() => resolve()));
  await new Promise<void>((resolve) => server.close(() => resolve()));
  for (const run of store.getAllRuns()) {
    engine.cancelRunEngine(run.id);
    store.updateRun(run.id, { status: 'done' });
    await store.deleteRun(run.id);
  }
  await rm(root, { recursive: true, force: true });
}
process.exit(0);
