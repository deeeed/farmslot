// Manual production-RPC proof. No shared gateway, worker, slot or publication is changed.
import assert from 'node:assert/strict';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { hostname, tmpdir, userInfo } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { ReadyGatePrPackage, Run, RunDecision } from '@farmslot/protocol';

import { computeReadyGatePackageHash } from '../../../services/gateway/src/run-completion/ready-gate-package.js';
import { testGatewayIdentity } from '../../lib/test-gateway-identity-source.mts';

const source = fileURLToPath(new URL('../../../', import.meta.url));
const temporary = mkdtempSync(path.join(tmpdir(), 'publication-approval-'));
const root = path.join(temporary, 'root');
const out = path.resolve(
  process.env.FARMSLOT_APPROVAL_PROOF_OUT ?? 'temp/publication-approval',
  randomUUID(),
);
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const writeJson = (file: string, value: unknown) => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
};
let gateway: ChildProcess | undefined;
let env: NodeJS.ProcessEnv;
let port: number;
let passed = false;
let logs = '';
const helper = (method: string, params: unknown): { run: Run } =>
  JSON.parse(
    execFileSync(
      process.execPath,
      [
        path.join(source, 'apps/command-center/scripts/cdp.mjs'),
        'gateway',
        method,
        JSON.stringify(params),
      ],
      { cwd: source, env, encoding: 'utf8', timeout: 35_000 },
    ),
  );
async function stop() {
  if (!gateway || gateway.exitCode !== null || gateway.signalCode !== null) return;
  const exited = once(gateway, 'exit');
  gateway.kill('SIGTERM');
  await Promise.race([exited, pause(3000)]);
  if (gateway.exitCode === null && gateway.signalCode === null) {
    gateway.kill('SIGKILL');
    await exited;
  }
}
async function start() {
  gateway = spawn(process.execPath, ['--import', 'tsx', 'services/gateway/src/index.ts'], {
    cwd: source,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  for (const stream of [gateway.stdout, gateway.stderr])
    stream?.on('data', (data) => {
      logs += String(data);
    });
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    assert.equal(gateway.exitCode, null, logs.slice(-4000));
    try {
      if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) return;
    } catch (error) {
      if (!(error instanceof TypeError)) throw error;
    }
    await pause(50);
  }
  throw new Error('Private gateway did not become healthy');
}
try {
  mkdirSync(out, { recursive: true });
  mkdirSync(root);
  execFileSync('git', ['init', '-q', '-b', 'proof-root'], { cwd: root });
  symlinkSync(path.join(source, 'packages'), path.join(root, 'packages'), 'dir');
  writeFileSync(path.join(root, 'CLAUDE.md'), '# Disposable publication approval proof\n');
  mkdirSync(path.join(root, 'scripts'));
  writeFileSync(path.join(root, 'scripts/dev.sh'), '#!/bin/sh\n');
  writeJson(path.join(root, 'services/gateway/package.json'), {
    name: 'fixture',
    version: '0.0.0',
  });
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  port = address.port;
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  testGatewayIdentity(path.join(temporary, 'home'), `ws://127.0.0.1:${port}`);
  env = {
    ...process.env,
    FARMSLOT_ROOT: root,
    FARMSLOT_PROJECTS_DIR: path.join(root, 'projects'),
    FARMSLOT_POOL_DIR: path.join(root, 'pool'),
    FARMSLOT_RUNS_DIR: path.join(root, '.runs'),
    FARMSLOT_HOME: path.join(temporary, 'home'),
    FARMSLOT_GATEWAY_PROFILE: 'proof',
    FARMSLOT_GATEWAY: `ws://127.0.0.1:${port}`,
    FARMSLOT_GATEWAY_PASSWORD: '',
    GATEWAY_HOST: '127.0.0.1',
    GATEWAY_PORT: String(port),
    FARMSLOT_DISABLE_ORCHESTRATION: '1',
    FARMSLOT_DISABLE_RUN_ENGINE_START: '1',
    FARMSLOT_DEMO_POOL: '0',
    FARMSLOT_NATIVE_STATE_DIR: path.join(temporary, 'native'),
    TMUX: '',
    TMUX_TMPDIR: path.join(temporary, 'tmux'),
    TSX_TSCONFIG_PATH: path.join(source, 'services/gateway/tsconfig.json'),
  };
  mkdirSync(env.TMUX_TMPDIR!, { recursive: true });
  const project = 'publication-approval-proof';
  writeJson(path.join(root, 'projects', project, 'project.json'), {
    name: project,
    runtime_dir: 'tasks',
    task_dir_name: 'tasks',
    default_branch: 'main',
    hooks: {},
  });
  const repo = path.join(root, 'checkout');
  mkdirSync(repo);
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'approval-proof');
  git(
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.test',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '-q',
    '--allow-empty',
    '-m',
    'test: create publication source',
  );
  const head = git('rev-parse', 'HEAD');
  const now = new Date().toISOString();
  const fixtures = ['stale', 'approve-publish', 'approve-publish-unresolved'].map((action) => {
    const id = randomUUID();
    const slotId = `approval-${id}`;
    const task = path.join(repo, 'tasks', id);
    mkdirSync(path.join(task, 'artifacts'), { recursive: true });
    writeFileSync(path.join(task, 'TASK.md'), '# Publication approval proof\n');
    writeFileSync(path.join(task, 'artifacts/pr-description.md'), '# Publication approval proof\n');
    writeJson(path.join(task, 'inputs/handoff.json'), { task: { acceptanceCriteria: [] } });
    const prepared: ReadyGatePrPackage = {
      id: `pkg-${id}`,
      artifactPath: 'artifacts/pr-package.json',
      packageHash: '',
      branch: 'approval-proof',
      headSha: head,
      diffStat: { files: 0, additions: 0, deletions: 0 },
      draftTitle: 'Publication approval proof',
      draftBody: 'Disposable control',
      evidenceManifest: [],
      selectedEvidenceKeys: [],
      reviewArtifactIds: [],
      gatePolicy: {
        owner: 'human',
        publishAuthority: 'human',
        reason: 'Publication approval proof',
      },
      reviewPolicy: { minimumReviews: 0, requestedBy: 'dispatch' },
      publicationTarget: 'ready',
      publicationStatus: 'not_published',
      createdAt: now,
    };
    prepared.packageHash = computeReadyGatePackageHash(prepared);
    writeJson(path.join(task, prepared.artifactPath), prepared);
    const retained = path.join(root, 'projects', project, 'tasks', id);
    cpSync(task, retained, { recursive: true });
    const decision: RunDecision = {
      id: randomUUID(),
      type: 'engine_human_gate',
      title: 'Publication',
      description: '',
      createdAt: now,
      actions: [
        { id: action === 'stale' ? 'approve-publish' : action, label: 'Approve', style: 'primary' },
      ],
      payload: {
        kind: 'ready',
        prNumber: null,
        repo: null,
        branch: prepared.branch,
        diffStat: prepared.diffStat,
        workerReport: '',
        prPackage: prepared,
      },
    };
    const run: Run = {
      id,
      familyId: id,
      lane: 'validation',
      flowType: 'fix-bug',
      mode: 'interactive',
      project,
      ticketOrPr: 'APPROVAL-1',
      slotId,
      branch: prepared.branch,
      taskFile: path.join(retained, 'TASK.md'),
      status: 'human-gating',
      createdAt: now,
      updatedAt: now,
      metrics: {
        runner: 'scripted',
        model: null,
        nudgeCount: 0,
        runnerSessionId: null,
        runnerSessionPath: null,
      },
      // This is a control-plane fixture with no worker. No native liveness is claimed.
      steps: [
        { name: 'dispatch', status: 'pending' },
        { name: 'human-gate', status: 'running' },
        { name: 'finalize', status: 'pending' },
      ],
      decisions: [decision],
      agentContexts: [
        {
          id: 'primary',
          role: 'fix-bug',
          label: 'Primary',
          runner: 'scripted',
          status: 'complete',
          runId: id,
          slotId,
          taskFile: path.join(task, 'TASK.md'),
        },
      ],
      engineState: {
        generation: 0,
        publishGate: {
          packageId: prepared.id,
          packageHash: prepared.packageHash,
          packageArtifactPath: prepared.artifactPath,
          publicationStatus: 'not_published',
        },
        ...(action === 'stale'
          ? { reviewedInputs: { fingerprint: 'earlier-proof', recordedAt: now } }
          : {}),
      },
    };
    writeJson(path.join(root, '.runs', `${id}.json`), run);
    return { run, decision, prepared, action };
  });
  writeJson(path.join(root, 'pool/local.json'), {
    machine: hostname(),
    host: 'localhost',
    ssh_user: userInfo().username,
    os: process.platform,
    project,
    platform: 'cli',
    slots: fixtures.map(({ run }) => ({
      id: run.slotId,
      enabled: true,
      repo,
      session: run.slotId,
    })),
  });
  await start();
  const stale = fixtures[0];
  const before = helper('run.get', { runId: stale.run.id }).run;
  assert.throws(
    () =>
      helper('run.resolveDecision', {
        runId: stale.run.id,
        decisionId: stale.decision.id,
        actionId: 'approve-publish',
        selectionData: {
          packageId: stale.prepared.id,
          packageHash: stale.prepared.packageHash,
          packageHeadSha: stale.prepared.headSha,
        },
      }),
    /Source or evidence changed after review/,
  );
  const refused = helper('run.get', { runId: stale.run.id }).run;
  assert.equal(refused.decisions[0].resolvedAt, undefined);
  assert.equal(refused.decisions.length, 1);
  assert.deepEqual(refused.engineState, before.engineState);
  writeJson(path.join(out, 'refused.json'), refused);
  for (const f of fixtures.slice(1)) {
    const accepted = helper('run.resolveDecision', {
      runId: f.run.id,
      decisionId: f.decision.id,
      actionId: f.action,
      selectionData: {
        packageId: f.prepared.id,
        packageHash: f.prepared.packageHash,
        packageHeadSha: f.prepared.headSha,
      },
    }).run;
    assert.equal(accepted.decisions[0].resolvedAction, f.action);
    assert.equal(accepted.engineState?.publishGate?.approvedPackageHash, f.prepared.packageHash);
    assert.equal(accepted.engineState?.publishGate?.publicationStatus, 'pending_publish');
    writeJson(path.join(out, `${f.action}.json`), accepted);
  }
  await stop();
  await start();
  for (const f of fixtures.slice(1)) {
    const retained = helper('run.get', { runId: f.run.id }).run;
    assert.equal(retained.decisions.length, 1);
    assert.equal(retained.decisions[0].resolvedAction, f.action);
    assert.equal(retained.engineState?.publishGate?.approvedPackageHash, f.prepared.packageHash);
    assert.equal(retained.engineState?.publishGate?.publicationStatus, 'pending_publish');
    writeJson(path.join(out, `${f.action}-restart.json`), retained);
  }
  passed = true;
} finally {
  await stop();
  writeFileSync(path.join(out, 'gateway.log'), logs);
  writeJson(path.join(out, 'result.json'), {
    pass: passed,
    gatewayStopped: !gateway || gateway.exitCode !== null || gateway.signalCode !== null,
    sharedStateChanged: false,
    publicPublicationAttempted: false,
  });
  rmSync(temporary, { recursive: true, force: true });
}
console.log(`Publication approval RPC/restart proof PASS: ${out}`);
