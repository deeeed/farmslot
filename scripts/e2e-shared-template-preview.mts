#!/usr/bin/env tsx
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { openSync, closeSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import {
  GatewayClient,
  GatewayConnectionError,
  type GatewayConnection,
} from '../packages/cli/src/gateway-client.js';
import type { DispatchPreviewResult } from '../packages/protocol/src/index.js';
import {
  createRecipeRunner,
  createStandardCoreAdapters,
} from '../packages/recipe-harness/src/index.js';

// Input packs and expected references are supplied by the caller. This proves
// preview resolution only; fixture slot readiness is not application proof.
const root = fileURLToPath(new URL('../', import.meta.url));
if (process.argv[2] === 'recipe') {
  const specifications = JSON.parse(await readFile(process.argv[3], 'utf8')) as string[];
  assert(Array.isArray(specifications) && specifications.length);
  const artifactsDir = path.resolve(process.argv[4]);
  await mkdir(path.join(artifactsDir, 'inputs'), { recursive: true });
  const nodes: Record<string, unknown> = {};
  for (const [index, file] of specifications.entries()) {
    const input = JSON.parse(await readFile(file, 'utf8'));
    input.evidence = path.join(artifactsDir, `preview-${index}`);
    const inputPath = path.join(artifactsDir, 'inputs', `${index}.json`);
    await writeFile(inputPath, JSON.stringify(input, null, 2));
    const quoted = "'" + inputPath.replaceAll("'", "'\\''") + "'";
    nodes[`preview-${index}`] = {
      action: 'command',
      cmd: `yarn exec tsx scripts/e2e-shared-template-preview.mts ${quoted}`,
      timeout_ms: 180_000,
      intent:
        'Compare real gateway previews before and after canonical template selection; verify source IDs and content digests without launching workers.',
      next: index + 1 === specifications.length ? 'done' : `preview-${index + 1}`,
    };
  }
  nodes.done = { action: 'end', status: 'pass' };
  const catalog = JSON.parse(
    await readFile(
      path.join(root, 'docs/examples/recipes/farmslot-v1.action-manifest.json'),
      'utf8',
    ),
  );
  const actions = ['command', 'end'];
  const runner = createRecipeRunner({
    actionManifest: {
      $schema: catalog.$schema,
      actions: Object.fromEntries(actions.map((name) => [name, catalog.actions[name]])),
    },
    adapters: createStandardCoreAdapters({ actions }),
    runner: {
      source: 'worktree',
      git_ref: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
      name: 'Shared template preview validation',
    },
  });
  const result = await runner.run({
    recipeDocument: {
      $schema: 'https://farmslot.io/schemas/recipe-v1.schema.json',
      title: 'Shared template dispatch previews',
      workflow: { entry: 'preview-0', nodes },
    },
    artifactsDir,
    projectRoot: root,
    source: { kind: 'operator', trust: 'trusted', name: 'Shared template preview validation' },
  });
  console.log(JSON.stringify(result));
  process.exit(result.status === 'pass' ? 0 : 1);
}
const spec = JSON.parse(await readFile(process.argv[2], 'utf8')) as {
  pack: string;
  platform: string;
  domain?: string;
  evidence: string;
  requests: Array<{
    params: Record<string, unknown>;
    expected: { id: string; sourceId: string; sha256: string };
    afterOnly?: boolean;
  }>;
};
assert(spec.pack && spec.platform && spec.evidence && spec.requests.length);
await mkdir(spec.evidence, { recursive: true });
const results = [];
for (const phase of ['before', 'after'] as const) {
  const fixture = await mkdtemp(path.join(tmpdir(), 'shared-template-preview-'));
  execFileSync('git', ['clone', '--shared', '--no-checkout', root, fixture], { stdio: 'pipe' });
  for (const name of ['scripts', 'services', 'packages', 'node_modules'])
    await symlink(path.join(root, name), path.join(fixture, name));
  await writeFile(path.join(fixture, 'CLAUDE.md'), '# Isolated template preview fixture\n');
  await mkdir(path.join(fixture, 'bin'));
  await writeFile(path.join(fixture, 'bin/gh'), '#!/bin/sh\nexit 1\n', { mode: 0o700 });
  const config = JSON.parse(
    phase === 'before'
      ? execFileSync('git', ['show', 'HEAD:project.json'], { cwd: spec.pack, encoding: 'utf8' })
      : await readFile(path.join(spec.pack, 'project.json'), 'utf8'),
  );
  const project = path.join(fixture, 'projects', config.name);
  await mkdir(path.dirname(project), { recursive: true });
  execFileSync('git', ['clone', '--shared', '--no-checkout', spec.pack, project], {
    stdio: 'pipe',
  });
  if (phase === 'before')
    execFileSync(
      'git',
      ['-c', 'core.hooksPath=/dev/null', 'checkout', '--quiet', '--detach', 'HEAD'],
      { cwd: project, stdio: 'pipe' },
    );
  else
    await cp(spec.pack, project, {
      recursive: true,
      filter: (source) => !['.git', 'node_modules'].includes(path.basename(source)),
    });
  // The fixture owns no application runtime. Prevent scheduled health/recycle work.
  config.auto_recycle = { ...config.auto_recycle, enabled: false };
  await writeFile(path.join(project, 'project.json'), JSON.stringify(config));
  const app = path.join(fixture, 'application');
  await mkdir(app);
  execFileSync('git', ['init', '--quiet'], { cwd: app });
  const slotId = 'template-preview-slot';
  await mkdir(path.join(fixture, 'pool'));
  await writeFile(
    path.join(fixture, 'pool/fixture.json'),
    JSON.stringify({
      machine: 'template-preview-node',
      host: 'localhost',
      project: config.name,
      platform: spec.platform,
      os: process.platform,
      review_workspaces: { max_concurrent: 2 },
      slots: [
        {
          id: slotId,
          enabled: true,
          repo: app,
          session: 'template-preview-unused',
          resources: { port: 49001, cdp_port: 49002 },
        },
      ],
    }),
  );
  await writeFile(
    path.join(fixture, '.farm-status.json'),
    JSON.stringify({
      checked_at: new Date().toISOString(),
      slots: [
        {
          slot: slotId,
          machine: 'template-preview-node',
          project: config.name,
          platform: spec.platform,
          repo: app,
          lifecycle: 'ready',
          phase: null,
          agent: 'idle',
          enabled: true,
          health: { ssh: 'LOCAL', device: 'OK', devserver: 'OK', cdp: 'OK', fixtures: 'OK' },
        },
      ],
    }),
  );
  const probe = createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>((resolve, reject) =>
    probe.close((error) => (error ? reject(error) : resolve())),
  );
  const log = path.join(spec.evidence, `${phase}-gateway.log`);
  const descriptor = openSync(log, 'w', 0o600);
  const token = randomBytes(32).toString('hex');
  const gateway = spawn('yarn', ['workspace', '@farmslot/gateway', 'start'], {
    cwd: root,
    detached: true,
    stdio: ['ignore', descriptor, descriptor],
    env: {
      ...process.env,
      PATH: path.join(fixture, 'bin') + path.delimiter + process.env.PATH,
      FARMSLOT_ROOT: fixture,
      FARMSLOT_HOME: path.join(fixture, 'home'),
      FARMSLOT_PROJECTS_DIR: path.join(fixture, 'projects'),
      FARMSLOT_POOL_DIR: path.join(fixture, 'pool'),
      FARMSLOT_RUNS_DIR: path.join(fixture, 'runs'),
      FARMSLOT_DISPATCH_QUEUE_FILE: path.join(fixture, 'queue.json'),
      GATEWAY_HOST: '127.0.0.1',
      GATEWAY_PORT: String(port),
      FARMSLOT_GATEWAY_TOKEN: token,
      FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID: 'legacy-env',
      FARMSLOT_DISABLE_ORCHESTRATION: '1',
      FARMSLOT_LOCAL_HEALTH_POLL: '0',
      FARMSLOT_DISPATCH_PRESSURE_ADMISSION: 'off',
    },
  });
  closeSync(descriptor);
  let connection: GatewayConnection | undefined;
  try {
    const client = new GatewayClient({
      url: `ws://127.0.0.1:${port}`,
      timeout: 30_000,
      credential: { token },
    });
    const deadline = Date.now() + 30_000;
    while (!connection) {
      assert(gateway.exitCode === null, 'Preview gateway exited before readiness');
      try {
        connection = await client.connect();
      } catch (error) {
        if (!(error instanceof GatewayConnectionError) || Date.now() >= deadline) throw error;
        await delay(200);
      }
    }
    for (const request of spec.requests) {
      if (phase === 'before' && request.afterOnly) continue;
      const result = await connection.call<DispatchPreviewResult>('dispatch.preview', {
        project: config.name,
        slotId: request.params.reviewWorkspaceTarget ? undefined : slotId,
        ticketOrPr: config.ci.repo + '#1',
        runner: 'codex',
        model: 'gpt-5.6-luna',
        effort: 'low',
        mode: 'autonomous',
        ...(spec.domain ? { domain: spec.domain } : {}),
        ...request.params,
      });
      assert.equal(result.preview.slotId, request.params.reviewWorkspaceTarget ? null : slotId);
      assert(result.preview.executionTemplate, 'Preview must identify its resolved template');
      if (phase === 'after')
        for (const field of ['id', 'sourceId', 'sha256'] as const)
          assert.equal(
            result.preview.executionTemplate[field],
            request.expected[field],
            `Canonical ${field} mismatch`,
          );
      results.push({ phase, params: request.params, preview: result.preview });
    }
    assert.equal((await connection.call<{ runs: unknown[] }>('run.list')).runs.length, 0);
    await writeFile(path.join(spec.evidence, 'previews.json'), JSON.stringify(results, null, 2));
  } finally {
    connection?.close();
    if (gateway.exitCode === null && gateway.signalCode === null && gateway.pid) {
      const exited = once(gateway, 'exit');
      process.kill(-gateway.pid, 'SIGTERM');
      if (!(await Promise.race([exited.then(() => true), delay(5000).then(() => false)]))) {
        process.kill(-gateway.pid, 'SIGKILL');
        await exited;
      }
    }
    await rm(fixture, { recursive: true, force: true });
  }
}
await writeFile(
  path.join(spec.evidence, 'result.json'),
  JSON.stringify(
    { passed: true, previews: results.length, workersLaunched: 0, applicationRuntimeProved: false },
    null,
    2,
  ),
);
console.log(JSON.stringify({ passed: true, evidence: spec.evidence, previews: results.length }));
