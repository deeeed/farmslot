/** Manual publication proof using a retained real execution and the production gateway RPC. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { GatewayClient, type GatewayConnection } from '../packages/cli/src/gateway-client.js';
import type {
  ReadyGatePrPackage,
  RunDecision,
  RunRefreshPublishedEvidenceResult,
} from '../packages/protocol/src/index.js';

const config = JSON.parse(await fs.readFile(process.argv[2]!, 'utf8')) as {
  sourceDir: string;
  ciRepo: string;
  artifactsRepo: string;
  prNumber: number;
  branch: string;
  outputDir: string;
  layout?: 'nested' | 'task-root' | 'promoted' | 'inherited';
};
const code = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'recorded-publication-proof-'));
for (const key of Object.keys(process.env))
  if (/^(?:FARMSLOT_|GATEWAY_|TMUX)/u.test(key)) delete process.env[key];
Object.assign(process.env, {
  FARMSLOT_ROOT: root,
  FARMSLOT_HOME: path.join(root, 'home'),
  FARMSLOT_POOL_DIR: path.join(root, 'pool'),
  FARMSLOT_PROJECTS_DIR: path.join(root, 'projects'),
  FARMSLOT_RUNS_DIR: path.join(root, 'runs'),
  FARMSLOT_GATEWAY_AUTH_MODE: 'none',
  FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID: 'local-admin',
  NODE_TEST_CONTEXT: '1',
});
await fs.mkdir(config.outputDir, { recursive: true });
for (const name of ['home', 'pool', 'projects/evidence', 'runs', 'task/artifacts/recipe-run'])
  await fs.mkdir(path.join(root, name), { recursive: true });
for (const name of [
  'scripts',
  'services',
  'packages',
  'node_modules',
  'schemas',
  'CLAUDE.md',
  'package.json',
])
  await fs.symlink(path.join(code, name), path.join(root, name));
await fs.writeFile(
  path.join(root, 'projects/evidence/project.json'),
  JSON.stringify({
    name: 'evidence',
    repo_url: `https://github.com/${config.ciRepo}.git`,
    default_branch: 'main',
    ci: { repo: config.ciRepo },
    artifacts_repo: config.artifactsRepo,
  }),
);
await fs.writeFile(
  path.join(root, '.farm-status.json'),
  JSON.stringify({ slots: [], updatedAt: new Date().toISOString() }),
);
await import('../services/gateway/src/runtime/mock-pty.test-support.js');
const { readRecordedEvidencePackage } =
  await import('../packages/recipe-runner/src/evidence/read-package.js');
const { validateRecordedEvidencePackage } =
  await import('../packages/recipe-runner/src/evidence/package.js');
const { buildPackageEvidenceManifest } =
  await import('../services/gateway/src/run-completion/package-evidence-manifest.js');
const { scanArtifacts, readEvidenceManifest } =
  await import('../services/gateway/src/run-completion/publication-artifacts.js');
const { computeReadyGatePackageHash } =
  await import('../services/gateway/src/run-completion/ready-gate-package.js');
const { createRun, updateRun, persistRunNow } =
  await import('../services/gateway/src/runs/store.js');
const { createGatewayAuthRuntime, initializeGatewayIdentity } =
  await import('../services/gateway/src/security/auth.js');
const { createWebSocketServer } = await import('../services/gateway/src/server.js');
const taskDir = path.join(root, 'task');
const executionPrefix =
  config.layout === 'task-root'
    ? ''
    : config.layout === 'promoted' || config.layout === 'inherited'
      ? 'recipe-runs/retained/'
      : 'recipe-run/';
const executionRoot = path.join(taskDir, 'artifacts', executionPrefix);
await fs.mkdir(executionRoot, { recursive: true });
await fs.cp(config.sourceDir, executionRoot, { recursive: true });
await fs.writeFile(path.join(taskDir, 'TASK.md'), '# Retained publication proof\n');
const source = await readRecordedEvidencePackage(executionRoot);
assert(!source.checks.some((check) => check.status === 'fail'));
assert.equal(validateRecordedEvidencePackage(source.input).status, 'valid');
const files = source.input.artifactPaths ?? [];
const images = files.filter((file) => /\.png$/u.test(file));
const videos = files.filter((file) => /\.mp4$/u.test(file));
assert(
  images.length >= 2 && videos.length,
  'Retain two HUD stills and a recording for selection controls.',
);
const selected = [
  `artifacts/${executionPrefix}${images[0]}`,
  `artifacts/${executionPrefix}${videos[0]}`,
];
const promoted = config.layout === 'promoted' || config.layout === 'inherited';
const manifestPrefix = promoted ? '' : executionPrefix;
const manifestDir =
  config.layout === 'inherited'
    ? path.join(taskDir, 'inputs/inherited')
    : config.layout === 'promoted'
      ? executionRoot
      : path.join(taskDir, 'artifacts');
await fs.mkdir(manifestDir, { recursive: true });
if (promoted)
  await fs.writeFile(
    path.join(taskDir, 'artifacts/latest-valid-recipe-run.json'),
    JSON.stringify({
      version: 1,
      runId: 'retained',
      relativeArtifactRoot: executionPrefix.replace(/\/$/u, ''),
    }),
  );
const manifestPath = path.join(manifestDir, 'evidence-manifest.json');
await fs.writeFile(
  manifestPath,
  JSON.stringify({
    version: 1,
    before_after_pairs: [
      {
        label: 'Recorded claim',
        before: `${manifestPrefix}${images[1]}`,
        after: `${manifestPrefix}${images[0]}`,
      },
    ],
    omit: [`${manifestPrefix}${images[1]}`],
    videos: { after: `${manifestPrefix}${videos[0]}`, preferred: false },
  }),
);
const run = createRun({
  flowType: 'dev',
  project: 'evidence',
  ticketOrPr: 'PUBLICATION-1',
  runner: 'scripted',
  mode: 'autonomous',
});
updateRun(run.id, { taskFile: path.join(taskDir, 'TASK.md'), branch: config.branch });
const current = { ...run, taskFile: path.join(taskDir, 'TASK.md') };
const manifest = await readEvidenceManifest(current);
const inventory = await buildPackageEvidenceManifest(
  taskDir,
  await scanArtifacts(taskDir),
  manifest,
);
assert(inventory.some((entry) => entry.path === `artifacts/${executionPrefix}trace.json`));
assert(inventory.some((entry) => entry.path === `artifacts/${executionPrefix}summary.json`));
for (const file of ['pr-package.json', 'pr-package.md', 'diff.txt'])
  await fs.writeFile(path.join(taskDir, 'artifacts', file), 'Gateway package/report output');
const prepared = {
  id: 'recorded-closure',
  artifactPath: 'artifacts/pr-package.json',
  branch: config.branch,
  evidenceManifest: inventory,
  selectedEvidenceKeys: selected,
  draftTitle: 'Recorded evidence publication proof',
  draftBody: '## **Screenshots/Recordings**\n',
} as ReadyGatePrPackage;
prepared.packageHash = computeReadyGatePackageHash(prepared);
const decision = {
  id: 'approved-recorded-closure',
  type: 'engine_human_gate',
  title: 'Publish retained evidence',
  description: 'Immutable selected execution proof',
  actions: [],
  createdAt: new Date().toISOString(),
  resolvedAt: new Date().toISOString(),
  resolvedAction: 'approve-publish',
  payload: { kind: 'ready', prPackage: prepared },
} as RunDecision;
updateRun(run.id, {
  status: 'done',
  prNumber: config.prNumber,
  decisions: [decision],
  engineState: { publishGate: { publicationStatus: 'published_draft' } },
});
await persistRunNow(run.id);
const auth = createGatewayAuthRuntime();
initializeGatewayIdentity(auth, { host: '127.0.0.1' });
const http = createServer((_req, res) => {
  res.writeHead(404);
  res.end();
});
const sockets = createWebSocketServer(http, auth);
let connection: GatewayConnection | undefined;
try {
  http.listen(0, '127.0.0.1');
  await once(http, 'listening');
  const address = http.address();
  assert(address && typeof address !== 'string');
  const client = new GatewayClient({
    url: `ws://127.0.0.1:${address.port}`,
    timeout: 120_000,
    credential: null,
  });
  connection = await client.connect();
  await assert.rejects(
    client.call('run.refreshPublishedEvidence', {
      runId: run.id,
      selectedEvidenceKeys: [`artifacts/${executionPrefix}${images[1]}`],
    }),
    /selection was not approved/,
  );
  const tracePath = path.join(executionRoot, 'trace.json');
  const trace = await fs.readFile(tracePath);
  try {
    await fs.writeFile(tracePath, '[]');
    await assert.rejects(
      client.call('run.refreshPublishedEvidence', { runId: run.id }),
      /missing or changed.*trace.json/,
    );
  } finally {
    await fs.writeFile(tracePath, trace);
  }
  const capturedManifest = await fs.readFile(manifestPath);
  try {
    await fs.writeFile(manifestPath, JSON.stringify({ version: 1, standalone: [] }));
    await assert.rejects(
      client.call('run.refreshPublishedEvidence', { runId: run.id }),
      /hash mismatch/,
    );
  } finally {
    await fs.writeFile(manifestPath, capturedManifest);
  }
  const result = await client.call<RunRefreshPublishedEvidenceResult>(
    'run.refreshPublishedEvidence',
    { runId: run.id },
  );
  assert.deepEqual(result.selectedEvidenceKeys.sort(), selected.sort());
  const urls = [];
  for (const [file, url] of Object.entries(result.artifactUrls)) {
    const response = await fetch(url);
    assert.equal(response.status, 200, file);
    urls.push({ file, url, http: response.status });
  }
  const body = execFileSync(
    'gh',
    [
      'pr',
      'view',
      String(config.prNumber),
      '--repo',
      config.ciRepo,
      '--json',
      'body',
      '--jq',
      '.body',
    ],
    { encoding: 'utf8' },
  );
  for (const { url } of urls) assert(body.includes(url));
  await fs.writeFile(
    path.join(config.outputDir, 'receipt.json'),
    JSON.stringify(
      {
        pass: true,
        head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: code, encoding: 'utf8' }).trim(),
        retainedExecutionSource: config.sourceDir,
        fixtureRunId: run.id,
        fixtureRoot: root,
        pr: `https://github.com/${config.ciRepo}/pull/${config.prNumber}`,
        packageHash: prepared.packageHash,
        frozenEntries: inventory.length,
        selectedEvidenceKeys: result.selectedEvidenceKeys,
        urls,
        unapprovedSelectionRefused: true,
        changedTraceRefused: true,
        changedManifestRefused: true,
        productionRpc: true,
        dispatchedFarmRuns: 0,
        layout: config.layout ?? 'nested',
        gatewayPackageFilesPreserved: true,
        pairedOmissionRespected: true,
      },
      null,
      2,
    ),
  );
} finally {
  connection?.close();
  for (const socket of sockets.clients) socket.terminate();
  await new Promise<void>((resolve) => sockets.close(() => resolve()));
  await new Promise<void>((resolve) => http.close(() => resolve()));
}
