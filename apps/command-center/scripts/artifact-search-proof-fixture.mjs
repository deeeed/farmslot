// Isolated gateway over a supported import of a real retained run. No worker is launched.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const source = fileURLToPath(new URL('../../../', import.meta.url));
const bundle = process.env.ARTIFACT_SEARCH_PROOF_BUNDLE;
const output = process.env.ARTIFACT_SEARCH_PROOF_OUTPUT;
const port = Number(process.env.GATEWAY_PORT);
assert(bundle && output && Number.isSafeInteger(port) && port > 0);
const root = await mkdtemp(path.join(os.tmpdir(), 'artifact-search-proof-'));
for (const key of Object.keys(process.env))
  if (/TOKEN|API_KEY|PASSWORD/.test(key) || /^(FARMSLOT_|GATEWAY_)/.test(key))
    delete process.env[key];
Object.assign(process.env, {
  NODE_TEST_CONTEXT: '1',
  FARMSLOT_ROOT: root,
  FARMSLOT_HOME: path.join(root, 'home'),
  FARMSLOT_RUNS_DIR: path.join(root, 'runs'),
  FARMSLOT_POOL_DIR: path.join(root, 'pool'),
  FARMSLOT_PROJECTS_DIR: path.join(root, 'projects'),
  FARMSLOT_DISABLE_ORCHESTRATION: '1',
  FARMSLOT_DISABLE_RUN_ENGINE_START: '1',
});
for (const dir of ['home', 'runs', 'pool', 'projects', 'client'])
  await mkdir(path.join(root, dir), { recursive: true });
for (const dir of ['scripts', 'services', 'packages', 'node_modules', 'schemas'])
  await symlink(path.join(source, dir), path.join(root, dir));
await writeFile(path.join(root, 'CLAUDE.md'), '# Isolated artifact search proof\n');
const load = (file) => import(pathToFileURL(path.join(source, file)).href);
const { createGatewayAuthRuntime, authorizeHttpRequest } = await load(
  'services/gateway/src/security/auth.ts',
);
const auth = createGatewayAuthRuntime({ FARMSLOT_HOME: path.join(root, 'home') });
const person = auth.writer.createPrincipal(
  { type: 'service', displayName: 'Artifact search proof' },
  [{ role: 'admin', scope: { kind: 'global' } }],
);
const credential = auth.writer.issueCredential(person.id, 'Disposable artifact search proof');
const { runBundleStore } = await load('services/gateway/src/run-completion/retained-artifacts.ts');
await runBundleStore(true);
const { runBundleImport } = await load('services/gateway/src/methods/run-bundle.ts');
const imported = await runBundleImport({ bundlePath: bundle, mode: 'reference-only' });
const { getAllRuns } = await load('services/gateway/src/runs/store.ts');
const runs = getAllRuns();
assert(runs.length === 1, 'Use a single-run source bundle');
const run = runs[0];
await mkdir(path.join(root, 'projects', run.project), { recursive: true });
await writeFile(
  path.join(root, 'projects', run.project, 'project.json'),
  JSON.stringify({ name: run.project }),
);
const { serveRunArtifact } = await load('services/gateway/src/methods/filesystem.ts');
const { createWebSocketServer } = await load('services/gateway/src/server.ts');
const server = createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200);
    res.end('ok');
    return;
  }
  if (!req.url?.startsWith('/api/run-artifact?')) {
    res.writeHead(404);
    res.end();
    return;
  }
  void authorizeHttpRequest({ runtime: auth, req, res, resource: 'run-artifact' })
    .then((ok) => (ok ? serveRunArtifact(req, res) : undefined))
    .catch((e) => res.destroy(e));
});
const wss = createWebSocketServer(server, auth);
await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
const url = `ws://127.0.0.1:${port}/ws`;
await writeFile(
  path.join(root, 'client/gateways.json'),
  JSON.stringify({
    active: 'artifact-search-proof',
    gateways: { 'artifact-search-proof': { url, authMode: 'token', secret: credential.secret } },
  }),
  { mode: 0o600 },
);
await mkdir(output, { recursive: true });
await writeFile(
  path.join(output, 'fixture.json'),
  JSON.stringify(
    {
      root,
      runId: run.id,
      sourceRunId: run.importProvenance?.importedFromRunId,
      clientHome: path.join(root, 'client'),
      url,
      pid: process.pid,
      imported,
    },
    null,
    2,
  ),
);
console.log(
  JSON.stringify({
    ready: true,
    runId: run.id,
    sourceRunId: run.importProvenance?.importedFromRunId,
    port,
  }),
);
let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM'])
  process.once(signal, async () => {
    if (stopping) return;
    stopping = true;
    for (const client of wss.clients) client.terminate();
    wss.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    process.exit(0);
  });
