#!/usr/bin/env tsx
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { openSync, closeSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile, symlink, rm, cp } from 'node:fs/promises';
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
import type { Run } from '../packages/protocol/src/index.js';
import {
  createRecipeRunner,
  createStandardCoreAdapters,
} from '../packages/recipe-harness/src/index.js';

const root = fileURLToPath(new URL('../', import.meta.url));
if (process.argv[2] === 'recipe') {
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
      name: 'QA controller runtime lifecycle',
    },
  });
  const result = await runner.run({
    recipeDocument: JSON.parse(
      await readFile(
        path.join(root, 'docs/examples/recipes/farmslot/qa-runtime.recipe.json'),
        'utf8',
      ),
    ),
    artifactsDir: path.resolve(root, process.argv[3] ?? `temp/qa-runtime-recipe/${Date.now()}`),
    projectRoot: root,
    source: { kind: 'operator', trust: 'trusted', name: 'QA lifecycle validation' },
  });
  console.log(JSON.stringify(result));
  process.exit(result.status === 'pass' ? 0 : 1);
}
const evidence = path.resolve(root, process.argv[2] ?? `temp/qa-runtime/${Date.now()}`);
const scenarios = process.argv[3]
  ? [process.argv[3]]
  : [
      'pass',
      'missing-smoke',
      'missing-package',
      'failing-smoke',
      'empty-scope',
      'unexecuted',
      'mismatched-scope',
    ];
assert(
  scenarios.every((value) =>
    [
      'pass',
      'missing-smoke',
      'missing-package',
      'failing-smoke',
      'empty-scope',
      'unexecuted',
      'mismatched-scope',
    ].includes(value),
  ),
  'Unknown QA runtime scenario',
);
await mkdir(evidence, { recursive: true });
const fixture = await mkdtemp(path.join(tmpdir(), 'qa-runtime-'));
execFileSync('git', ['clone', '--shared', '--no-checkout', root, fixture], { stdio: 'pipe' });
for (const entry of ['scripts', 'services', 'packages', 'node_modules', 'package.json'])
  await symlink(path.join(root, entry), path.join(fixture, entry));
await writeFile(path.join(fixture, 'CLAUDE.md'), '# Isolated QA runtime fixture\n');
async function json(file: string, value: unknown) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(value, null, 2), { mode: 0o600 });
}
const project = path.join(fixture, 'projects/qa-controller');
await mkdir(path.join(project, 'shared/validation'), { recursive: true });
await mkdir(path.join(project, 'templates/prompts'), { recursive: true });
await writeFile(
  path.join(project, 'templates/prompts/worker-dispatch.md'),
  'Read {{TASK_FILE}} and run the configured QA command.\n',
);
await writeFile(
  path.join(project, 'shared/validation/shared.md'),
  '---\nplatforms: [cli]\nrunMode: autonomous\n---\n\n# Controller QA\n\n- [ ] Execute controller smoke and retain the suite evidence.\n',
);
const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
const commands: Record<string, unknown> = {};
const slots: Array<any> = [];
const sessions: string[] = [];
for (const scenario of scenarios) {
  const repo = path.join(fixture, `repo-${scenario}`);
  await mkdir(repo);
  execFileSync('git', ['clone', '--shared', '--no-checkout', root, repo], { stdio: 'pipe' });
  for (const entry of ['scripts', 'services', 'packages', 'node_modules', 'package.json'])
    await symlink(path.join(root, entry), path.join(repo, entry));
  await symlink(path.join(fixture, 'projects'), path.join(repo, 'projects'));
  await writeFile(path.join(repo, 'CLAUDE.md'), '# Isolated QA controller checkout\n');
  const session = path.basename(fixture) + '-' + scenario;
  sessions.push(session);
  commands[scenario] = {
    command: [
      process.execPath,
      '--import',
      'tsx',
      path.join(root, 'scripts/fixtures/qa-runtime-worker.mts'),
      scenario,
    ]
      .map(quote)
      .join(' '),
    timeout_ms: 60000,
  };
  slots.push({ id: `qa-${scenario}`, enabled: true, repo, session, resources: {} });
}
await json(path.join(project, 'project.json'), {
  name: 'qa-controller',
  repo_url: root,
  paths: { runtime_dir: '.agent', artifact_dir: '.task' },
  scripted: { commands },
  execution_templates: {
    sources: [{ id: 'fixture', kind: 'workspace', root: { projectPath: 'shared' } }],
  },
  qa: {
    default_profile: 'controller',
    profiles: [
      {
        id: 'controller',
        title: 'Controller changes',
        template_id: 'validation/shared',
        inputs: { scope: 'controller' },
      },
    ],
  },
  monitoring: { poll_interval_min: 0.02, total_timeout_min: 2 },
});
await json(path.join(fixture, 'pool/qa.json'), {
  machine: 'qa-machine',
  host: 'localhost',
  ssh_user: process.env.USER ?? 'operator',
  project: 'qa-controller',
  platform: 'cli',
  os: process.platform,
  slots,
});
await json(path.join(fixture, '.farm-status.json'), {
  checked_at: new Date().toISOString(),
  slots: slots.map((slot) => ({
    slot: slot.id,
    machine: 'qa-machine',
    project: 'qa-controller',
    platform: 'cli',
    repo: slot.repo,
    session: slot.session,
    lifecycle: 'ready',
    phase: null,
    agent: 'idle',
    enabled: true,
    health: { ssh: 'LOCAL', device: '-', devserver: 'OK', fixtures: '-' },
  })),
});
const probe = createServer().listen(0, '127.0.0.1');
await once(probe, 'listening');
const port = (probe.address() as { port: number }).port;
await new Promise<void>((resolve, reject) =>
  probe.close((error) => (error ? reject(error) : resolve())),
);
const token = randomBytes(32).toString('hex');
const fd = openSync(path.join(evidence, 'gateway.log'), 'w', 0o600);
const gateway = spawn('yarn', ['workspace', '@farmslot/gateway', 'start'], {
  cwd: root,
  detached: true,
  stdio: ['ignore', fd, fd],
  env: {
    ...process.env,
    FARMSLOT_ROOT: fixture,
    FARMSLOT_HOME: path.join(fixture, 'home'),
    FARMSLOT_PROJECTS_DIR: path.join(fixture, 'projects'),
    FARMSLOT_POOL_DIR: path.join(fixture, 'pool'),
    FARMSLOT_RUNS_DIR: path.join(fixture, 'runs'),
    FARMSLOT_DISPATCH_QUEUE_FILE: path.join(fixture, 'queue.json'),
    GATEWAY_HOST: '127.0.0.1',
    GATEWAY_PORT: String(port),
    FARMSLOT_GATEWAY_TOKEN: token,
    FARMSLOT_DISABLE_ORCHESTRATION: '1',
    FARMSLOT_DISPATCH_PRESSURE_ADMISSION: 'off',
  },
});
closeSync(fd);
let connection: GatewayConnection | undefined;
let failure: unknown;
const runs: Run[] = [];
try {
  for (const slot of slots)
    execFileSync('tmux', ['new-session', '-d', '-s', slot.session, '-c', slot.repo], {
      stdio: 'pipe',
    });
  const client = new GatewayClient({
    url: `ws://127.0.0.1:${port}`,
    timeout: 30000,
    credential: { token },
  });
  const ready = Date.now() + 30000;
  while (!connection && Date.now() < ready) {
    try {
      connection = await client.connect();
    } catch (error) {
      if (!(error instanceof GatewayConnectionError)) throw error;
      await delay(200);
    }
  }
  assert(connection);
  for (const scenario of scenarios) {
    const ticket =
      scenario === 'pass'
        ? `Controller 'quoted' $(printf qa); ${'x'.repeat(260)}`
        : `controller-${scenario}`;
    const created = await connection.call<{ run: Run }>('run.create', {
      flowType: 'qa',
      project: 'qa-controller',
      ticketOrPr: ticket,
      slotId: `qa-${scenario}`,
      mode: 'autonomous',
      runner: 'scripted',
      model: 'scripted',
      scripted: { mode: 'command', commandRef: scenario },
      skipPrepare: true,
      completionPolicy: 'artifact-only',
    });
    let run = created.run;
    runs.push(run);
    const deadline = Date.now() + 150000;
    while (Date.now() < deadline) {
      run = (await connection.call<{ run: Run }>('run.get', { runId: run.id })).run;
      await json(path.join(evidence, scenario, 'run.json'), run);
      if (['done', 'failed', 'blocked', 'cancelled'].includes(run.status)) break;
      await delay(500);
    }
    runs[runs.length - 1] = run;
    if (run.taskFile) {
      const taskDocument = await readFile(run.taskFile, 'utf8');
      assert.match(taskDocument, /This mode grants no additional permission/);
      assert.doesNotMatch(taskDocument, /zero human input|Execute all phases without stopping/);
      await cp(path.dirname(run.taskFile), path.join(evidence, scenario, 'task'), {
        recursive: true,
      });
    }
    if (run.taskFile) {
      const worker = path.join(
        slots.find((slot) => slot.id === `qa-${scenario}`)!.repo,
        '.task',
        'qa',
        path.basename(path.dirname(run.taskFile)),
      );
      await cp(worker, path.join(evidence, scenario, 'worker-task'), { recursive: true });
      const signal = JSON.parse(await readFile(path.join(worker, 'SIGNAL.json'), 'utf8'));
      const command = JSON.parse(
        await readFile(path.join(worker, 'artifacts/scripted-command-result.json'), 'utf8'),
      );
      assert.equal(run.metrics.runner, 'scripted');
      assert.equal(signal.status, 'complete');
      assert.equal(signal.outcome, 'success');
      assert.equal(command.exitCode, 0);
      assert.equal(command.commandRef, scenario);
      assert(!(await readFile(path.join(worker, 'CHECKLIST.md'), 'utf8')).includes('[ ]'));
    }
    if (scenario === 'pass') {
      assert.equal(run.status, 'done', run.error ?? JSON.stringify(run.steps));
      assert(run.taskFile);
      const folder = path.basename(path.dirname(run.taskFile));
      assert.match(folder, /^[a-z0-9-]+$/, 'QA title must not become shell syntax in task paths');
      assert(folder.length < 120, 'QA task folder must stay below filesystem name limits');
      assert.equal(run.ticketOrPr, ticket, 'Original QA scope title must remain intact');
      assert(
        run.steps.find((step) => step.name === 'monitor')?.outputs?.qaEvidence,
        'QA completion must retain gate evidence',
      );
    } else {
      assert.equal(run.status, 'blocked', run.error ?? JSON.stringify(run.steps));
      assert.match(
        JSON.stringify({ error: run.error, steps: run.steps }),
        /QA evidence incomplete|qa-runtime-evidence/,
      );
      let refusal: { message: string; code?: string } | undefined;
      await assert.rejects(
        connection.call('run.forceComplete', { runId: run.id, prNumber: 42 }).catch((error) => {
          refusal = { message: error.message, code: error.code };
          throw error;
        }),
        /QA cannot be force-completed/,
      );
      await json(path.join(evidence, scenario, 'force-complete.json'), refusal);
      assert.equal(
        (await connection.call<{ run: Run }>('run.get', { runId: run.id })).run.status,
        'blocked',
      );
    }
  }
  await json(path.join(evidence, 'result.json'), {
    passed: true,
    scenarios,
    runs: runs.map((run) => ({ id: run.id, status: run.status })),
    runtime: 'isolated HTTP counter controller; no app or MetaMask skill parity claimed',
  });
} catch (error) {
  failure = error;
  await json(path.join(evidence, 'failure.json'), { error: String(error), fixture });
} finally {
  if (connection)
    for (const run of runs)
      if (!['done', 'cancelled'].includes(run.status)) {
        try {
          await connection.call('run.cancel', {
            runId: run.id,
            reason: 'QA runtime fixture cleanup',
          });
        } catch (error) {
          failure = new AggregateError([...(failure ? [failure] : []), error], 'QA cleanup failed');
        }
      }
  connection?.close();
  for (const session of sessions) {
    try {
      execFileSync('tmux', ['kill-session', '-t', session], { stdio: 'pipe' });
    } catch (error) {
      const exists = spawn('tmux', ['has-session', '-t', session], { stdio: 'ignore' });
      const [code] = await once(exists, 'exit');
      if (code === 0)
        failure = new AggregateError(
          [...(failure ? [failure] : []), error],
          'Owned tmux session survived',
        );
    }
  }
  if (gateway.pid && gateway.exitCode === null) {
    const stopped = once(gateway, 'exit');
    process.kill(-gateway.pid, 'SIGTERM');
    if (!(await Promise.race([stopped.then(() => true), delay(5000).then(() => false)]))) {
      process.kill(-gateway.pid, 'SIGKILL');
      await stopped;
    }
  }
  await rm(fixture, { recursive: true, force: true });
}
if (failure) throw failure;
console.log(JSON.stringify({ passed: true, evidence, scenarios }));
