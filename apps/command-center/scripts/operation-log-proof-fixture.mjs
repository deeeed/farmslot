// Disposable real gateway and files for the operation-log browser proof. No worker is launched.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const output = process.env.OPERATION_LOG_PROOF_OUTPUT;
const ledgerFailure = process.env.ACCEPTANCE_LEDGER_ERROR_PROOF === '1';
const port = Number(process.env.GATEWAY_PORT);
assert(output && Number.isSafeInteger(port) && port > 0);
const source = fileURLToPath(new URL('../../../', import.meta.url));
const root = await mkdtemp(path.join(os.tmpdir(), 'operation-log-proof-'));
for (const key of Object.keys(process.env))
  if (/TOKEN|API_KEY|PASSWORD/.test(key) || /^(FARMSLOT_|GATEWAY_)/.test(key))
    delete process.env[key];
Object.assign(process.env, {
  NODE_TEST_CONTEXT: '1',
  FARMSLOT_ROOT: root,
  FARMSLOT_HOME: path.join(root, 'home'),
  FARMSLOT_POOL_DIR: path.join(root, 'pool'),
  FARMSLOT_PROJECTS_DIR: path.join(root, 'projects'),
  FARMSLOT_RUNS_DIR: path.join(root, 'runs'),
  FARMSLOT_DISABLE_ORCHESTRATION: '1',
  FARMSLOT_DISABLE_RUN_ENGINE_START: '1',
});
for (const directory of ['home', 'pool', 'projects/log-proof', 'runs', 'client', 'repo'])
  await mkdir(path.join(root, directory), { recursive: true });
for (const directory of ['scripts', 'services', 'packages', 'node_modules', 'schemas'])
  await symlink(path.join(source, directory), path.join(root, directory));
await writeFile(path.join(root, 'CLAUDE.md'), '# Disposable operation log proof\n');
await writeFile(
  path.join(root, 'projects/log-proof/project.json'),
  JSON.stringify({ name: 'log-proof' }),
);
await writeFile(
  path.join(root, 'pool/local.json'),
  JSON.stringify({
    machine: 'log-proof',
    project: 'log-proof',
    platform: 'cli',
    os: 'darwin',
    host: 'localhost',
    slots: [{ id: 'log-proof-1', repo: path.join(root, 'repo'), session: 'not-launched' }],
  }),
);
const load = (file) => import(pathToFileURL(path.join(source, file)).href);
const config = await load('services/gateway/src/core/config.ts');
const { createGatewayAuthRuntime, authorizeHttpRequest } = await load(
  'services/gateway/src/security/auth.ts',
);
const auth = createGatewayAuthRuntime({ FARMSLOT_HOME: path.join(root, 'home') });
const person = auth.writer.createPrincipal({ type: 'person', displayName: 'Operation log proof' }, [
  { role: 'admin', scope: { kind: 'global' } },
]);
const credential = auth.writer.issueCredential(person.id, 'Disposable operation log proof');
const { createRun, updateRun } = await load('services/gateway/src/runs/store.ts');
const run = createRun(
  {
    project: 'log-proof',
    flowType: 'dev',
    ticketOrPr: 'Operation log proof',
    mode: 'interactive',
    slotId: 'log-proof-1',
  },
  { createdByPrincipalId: person.id, nativeOwnerPrincipalId: person.id },
);
const ids = [
  '11111111-1111-4111-8111-111111111111',
  '22222222-2222-4222-8222-222222222222',
  '33333333-3333-4333-8333-333333333333',
];
const paths = ids.map((id) => `artifacts/operations/${id}.log`);
const { taskDir } = await config.resolveTaskPaths('log-proof-1', 'proof');
await mkdir(path.join(taskDir, 'artifacts/operations'), { recursive: true });
await writeFile(path.join(taskDir, 'TASK.md'), '# Operation log proof\n');
await writeFile(path.join(taskDir, paths[0]), '');
await writeFile(path.join(taskDir, paths[1]), 'Recorded operation output\n');
updateRun(run.id, {
  status: ledgerFailure ? 'done' : 'monitoring',
  taskFile: path.join(config.getOrchestratorTaskRoot('log-proof'), 'proof/TASK.md'),
  steps: run.steps.map((step) => ({
    ...step,
    status: !ledgerFailure && step.name === 'monitor' ? 'running' : 'done',
    outputs:
      step.name === 'monitor'
        ? { artifacts: paths.map((file) => ({ path: file, purpose: 'other' })) }
        : {},
  })),
});
// Setup-time recorded progress uses the production task reader, which discovers
// operation records from disk. No progress payload is injected into the browser.
const recorded = path.join(config.getOrchestratorTaskRoot('log-proof'), 'proof');
await mkdir(path.join(recorded, 'artifacts/operations'), { recursive: true });
await writeFile(path.join(recorded, 'TASK.md'), '# Operation log proof\n');
const checklist = '# Worker\n\n- [x] **1. Inspect operation logs**\n';
await writeFile(path.join(recorded, 'CHECKLIST.md'), checklist);
await writeFile(path.join(recorded, 'CHECKLIST.md.worker'), checklist);
if (ledgerFailure)
  await writeFile(
    path.join(recorded, 'artifacts/acceptance-status.json'),
    '{ malformed ledger JSON',
  );
for (const id of ids) {
  await writeFile(
    path.join(recorded, 'artifacts/operations', `${id}.json`),
    JSON.stringify({
      schemaVersion: 1,
      id,
      command: 'run',
      target: 'Disposable proof',
      pid: 1,
      processStartedAt: new Date().toISOString(),
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      status: 'pass',
      exitCode: 0,
      logPath: `artifacts/operations/${id}.log`,
      finishedAt: new Date().toISOString(),
    }),
  );
}
const { statusFile } = await load('services/gateway/src/core/state.ts');
await writeFile(
  statusFile,
  JSON.stringify({
    slots: [{ slot: 'log-proof-1', lifecycle: 'held', current_run_id: run.id, task_file: 'proof' }],
  }),
);
const { serveRunArtifact } = await load('services/gateway/src/methods/filesystem.ts');
const { createWebSocketServer } = await load('services/gateway/src/server.ts');
const server = createServer((request, response) => {
  if (!request.url?.startsWith('/api/run-artifact?')) {
    response.writeHead(404);
    response.end();
    return;
  }
  void authorizeHttpRequest({
    runtime: auth,
    req: request,
    res: response,
    resource: 'run-artifact',
  })
    .then(async (authorized) => {
      if (authorized) await serveRunArtifact(request, response);
    })
    .catch((error) => {
      response.destroy(error);
    });
});
const wss = createWebSocketServer(server, auth);
await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
const url = `ws://127.0.0.1:${port}/ws`;
const cliSession = ledgerFailure
  ? await auth.writer.exchangePersonCredential(credential.secret, {
      deviceName: 'Ledger failure proof',
      deviceKind: 'cli',
    })
  : undefined;
await writeFile(
  path.join(root, 'client/gateways.json'),
  JSON.stringify({
    active: 'operation-log-proof',
    gateways: {
      'operation-log-proof': { url, authMode: 'token', secret: credential.secret },
      ...(cliSession
        ? { 'ledger-error-cli': { url, authMode: 'token', secret: cliSession.accessToken } }
        : {}),
    },
  }),
  { mode: 0o600 },
);
await mkdir(output, { recursive: true });
await writeFile(
  path.join(output, 'fixture.json'),
  JSON.stringify(
    { root, runId: run.id, paths, clientHome: path.join(root, 'client'), url, pid: process.pid },
    null,
    2,
  ),
);
console.log(JSON.stringify({ ready: true, runId: run.id, port }));
let stopping = false;
for (const signal of ['SIGTERM', 'SIGINT'])
  process.on(signal, async () => {
    if (stopping) return;
    stopping = true;
    for (const client of wss.clients) client.terminate();
    wss.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
    process.exit(0);
  });
