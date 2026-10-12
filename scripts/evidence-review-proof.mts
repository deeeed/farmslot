/** Manual review-client proof server backed by retained real recipe packages. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const code = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const configFile = process.argv[2];
assert(configFile, 'Pass a private proof config with sources and stateFile.');
const config = JSON.parse(await fs.readFile(configFile, 'utf8')) as {
  stateFile: string;
  uiPort: number;
  gatewayPort?: number;
  sources: Array<{ label: string; directory: string; mode?: 'ready' | 'legacy'; nested?: boolean }>;
};
assert(config.sources.length, 'At least one retained real recipe package is required.');
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'evidence-review-proof-'));
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
  GATEWAY_HOST: '127.0.0.1',
  NODE_TEST_CONTEXT: '1',
});
for (const dir of ['home', 'pool', 'projects/evidence', 'runs', 'repo'])
  await fs.mkdir(path.join(root, dir), { recursive: true });
for (const name of [
  'scripts',
  'services',
  'packages',
  'schemas',
  'node_modules',
  'CLAUDE.md',
  'package.json',
])
  await fs.symlink(path.join(code, name), path.join(root, name));
const write = (file: string, value: unknown) => fs.writeFile(file, JSON.stringify(value, null, 2));
await write(path.join(root, 'projects/evidence/project.json'), {
  name: 'evidence',
  repo_url: 'https://github.com/example/evidence.git',
  default_branch: 'main',
});
await write(path.join(root, 'pool/local.json'), {
  machine: os.hostname(),
  host: 'localhost',
  project: 'evidence',
  platform: 'cli',
  slots: [{ id: 'evidence-proof', repo: path.join(root, 'repo'), resources: {} }],
});
await write(path.join(root, '.farm-status.json'), {
  updatedAt: new Date().toISOString(),
  slots: [],
});
// Reject every tmux subprocess and prevent the PTY module's import-time changes.
await import('../services/gateway/src/runtime/mock-pty.test-support.js');
const { readRecordedEvidencePackage } =
  await import('../packages/recipe-runner/src/evidence/read-package.js');
const { validateRecordedEvidencePackage } =
  await import('../packages/recipe-runner/src/evidence/package.js');
const { getOrchestratorTaskRoot } = await import('../services/gateway/src/core/config.js');
const { createRun, updateRun, persistRunNow } =
  await import('../services/gateway/src/runs/store.js');
const { createGatewayAuthRuntime, initializeGatewayIdentity } =
  await import('../services/gateway/src/security/auth.js');
const { createWebSocketServer, broadcastEvent } = await import('../services/gateway/src/server.js');
const { watchSlot, unwatchSlot, onTaskProgress } =
  await import('../services/gateway/src/tasks/watcher.js');
onTaskProgress((slotId, progress, role, contextId, runId) =>
  broadcastEvent('task.progress.updated', { slotId, progress, role, contextId, runId }),
);
const { serveRunArtifact } = await import('../services/gateway/src/methods/filesystem.js');
const { computeReadyGatePackageHash } =
  await import('../services/gateway/src/run-completion/ready-gate-package.js');
const { outputManifestDigest, outputReviewDecisions } =
  await import('../services/gateway/src/run-completion/output.js');
const { createServer: createVite } = await import('vite');
const runs: Array<{ id: string; label: string; recipeRunId: string; claimIds: string[] }> = [];
for (const source of config.sources) {
  const retained = await readRecordedEvidencePackage(source.directory);
  assert(
    retained.checks.every((check) => check.status !== 'fail'),
    JSON.stringify(retained.checks),
  );
  const validation = validateRecordedEvidencePackage(retained.input);
  assert(
    !validation.findings.some((finding) => finding.severity === 'error'),
    JSON.stringify(validation),
  );
  const claims = retained.input.claims!;
  const run = createRun(
    {
      flowType: 'dev',
      project: 'evidence',
      ticketOrPr: source.label,
      mode: 'interactive',
      transport: 'native',
      slotId: 'evidence-proof',
      completionPolicy: 'artifact-only',
    },
    { nativeOwnerPrincipalId: 'local-admin' },
  );
  const task = path.join(getOrchestratorTaskRoot('evidence'), 'dev', run.id);
  const artifacts = path.join(task, 'artifacts');
  await fs.mkdir(task, { recursive: true });
  const retainedDir = source.nested
    ? path.join(artifacts, 'recipe-runs', claims.recipeRunId)
    : artifacts;
  await fs.cp(source.directory, retainedDir, { recursive: true });
  if (source.mode === 'legacy') {
    await fs.rm(path.join(artifacts, 'summary.json'));
    await fs.mkdir(path.join(task, 'inputs'), { recursive: true });
    await write(path.join(task, 'inputs/handoff.json'), {
      schemaVersion: 1,
      task: {
        title: 'Legacy acceptance review',
        acceptanceCriteria: ['The updated ledger is visible.'],
      },
    });
    await write(path.join(artifacts, 'acceptance-status.json'), {
      schemaVersion: 1,
      criteria: [
        {
          id: 'AC-1',
          text: 'The updated ledger is visible.',
          verdict: 'weak',
          recipeNodes: [],
          evidence: [],
          updatedAt: new Date().toISOString(),
        },
      ],
    });
  }
  await fs.writeFile(path.join(task, 'TASK.md'), '# Retained recipe proof\n');
  await fs.writeFile(
    path.join(task, 'CHECKLIST.md'),
    '# Worker: dev\n\n- [x] **1. execute retained recipe**\n',
  );
  const reportPath = 'artifacts/qa-report.md';
  await fs.writeFile(
    path.join(task, reportPath),
    '# Recipe output\n\n' +
      claims.criteria.map((claim) => `${claim.id}: ${claim.verdict}, ${claim.text}`).join('\n'),
  );
  const manifest = [];
  for (const relative of await fs.readdir(artifacts, { recursive: true })) {
    const file = path.join(artifacts, relative);
    if (!(await fs.stat(file)).isFile()) continue;
    manifest.push({
      path: 'artifacts/' + relative,
      purpose: /\.(mp4|png)$/u.test(relative) ? 'evidence' : 'supporting',
      sha256: createHash('sha256')
        .update(await fs.readFile(file))
        .digest('hex'),
    });
  }
  const manifestDigest = outputManifestDigest(manifest);
  const output = {
    capturedAt: new Date().toISOString(),
    workerFinished: true,
    artifactManifest: manifest,
    manifestDigest,
    reportPath,
  };
  const decision =
    source.mode === 'ready'
      ? (() => {
          const prPackage = {
            id: run.id,
            artifactPath: 'gate/pr-package.json',
            branch: 'proof',
            diffStat: { files: 0, additions: 0, deletions: 0 },
            draftTitle: source.label,
            draftBody: 'Retained recorded evidence review proof.',
            evidenceManifest: manifest,
            selectedEvidenceKeys: [],
            reviewArtifactIds: [],
            gatePolicy: {
              owner: 'human' as const,
              publishAuthority: 'human' as const,
              reason: 'Read-only review proof',
            },
            publicationTarget: 'draft' as const,
            publicationStatus: 'not_published' as const,
            createdAt: output.capturedAt,
            packageHash: '',
          };
          prPackage.packageHash = computeReadyGatePackageHash(prPackage);
          return [
            {
              id: run.id,
              type: 'engine_human_gate' as const,
              title: 'Review evidence',
              description: 'Read-only package proof. No publication actions.',
              actions: [],
              createdAt: output.capturedAt,
              payload: {
                kind: 'ready' as const,
                prNumber: null,
                repo: null,
                diffStat: prPackage.diffStat,
                workerReport: 'Retained recipe execution.',
                branch: 'proof',
                prPackage,
                acceptanceStatus: claims,
                acceptanceCriteria: claims.criteria.map((claim) => claim.text),
              },
            },
          ];
        })()
      : outputReviewDecisions(run, output);
  const updated = updateRun(run.id, {
    status: source.mode === 'legacy' ? 'monitoring' : source.mode === 'ready' ? 'blocked' : 'done',
    taskFile: path.join(task, 'TASK.md'),
    nativeOwnerPrincipalId: 'local-admin',
    ...(source.nested
      ? {
          liveRecipeContext: {
            source: 'recipe-run-live' as const,
            recipeRunId: claims.recipeRunId,
            artifactRoot: retainedDir,
            recipeJson: JSON.stringify(retained.input.recipe),
            selectionReason: 'latest-run' as const,
            isStale: false,
            artifactManifest: null,
            workerLearnings: null,
            recipeQualityArtifact: null,
            qualityReport: null,
          },
        }
      : {}),
    output: source.mode === 'legacy' ? null : output,
    decisions: source.mode === 'legacy' ? [] : decision,
  });
  await persistRunNow(updated);
  runs.push({
    id: run.id,
    label: source.label,
    recipeRunId: claims.recipeRunId,
    claimIds: source.mode === 'legacy' ? ['AC-1'] : claims.criteria.map((claim) => claim.id),
  });
  if (source.mode === 'legacy') {
    await fs.mkdir(path.join(root, 'repo/.task/dev'), { recursive: true });
    await fs.symlink(task, path.join(root, 'repo/.task/dev', run.id));
    await write(path.join(root, '.farm-status.json'), {
      updatedAt: new Date().toISOString(),
      slots: [
        {
          slot: 'evidence-proof',
          currentRunId: run.id,
          taskFile: `dev/${run.id}`,
          status: 'working',
          project: 'evidence',
        },
      ],
    });
  }
}
const auth = createGatewayAuthRuntime();
initializeGatewayIdentity(auth, { host: '127.0.0.1' });
const http = createServer((req, res) => {
  if (req.url?.startsWith('/api/run-artifact?')) void serveRunArtifact(req, res);
  else {
    res.writeHead(404);
    res.end();
  }
});
const sockets = createWebSocketServer(http, auth);
let vite: Awaited<ReturnType<typeof createVite>> | undefined;
try {
  http.listen(config.gatewayPort ?? 0, '127.0.0.1');
  await once(http, 'listening');
  const address = http.address();
  assert(address && typeof address !== 'string');
  process.env.GATEWAY_PORT = String(address.port);
  process.env.VITE_PORT = String(config.uiPort);
  vite = await createVite({
    configFile: path.join(code, 'apps/command-center/ui/vite.config.ts'),
    envDir: false,
    server: { host: '127.0.0.1' },
  });
  await vite.listen();
  if (config.sources.some((source) => source.mode === 'legacy'))
    await watchSlot('evidence-proof', { contexts: [] });
  await write(config.stateFile, {
    root,
    pid: process.pid,
    gatewayPort: address.port,
    uiPort: config.uiPort,
    runs,
  });
  console.log(
    JSON.stringify({ ready: true, gatewayPort: address.port, uiPort: config.uiPort, runs }),
  );
  process.removeAllListeners('SIGTERM');
  process.removeAllListeners('SIGINT');
  await new Promise<void>((resolve) => {
    process.once('SIGTERM', resolve);
    process.once('SIGINT', resolve);
  });
} finally {
  await unwatchSlot('evidence-proof');
  await vite?.close();
  for (const client of sockets.clients) client.terminate();
  await new Promise<void>((resolve) => sockets.close(() => resolve()));
  await new Promise<void>((resolve) => http.close(() => resolve()));
  console.log(JSON.stringify({ stopped: true, root }));
}
