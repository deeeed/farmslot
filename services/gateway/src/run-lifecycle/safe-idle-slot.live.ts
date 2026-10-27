import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir, userInfo } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const code = fileURLToPath(new URL('../../../../', import.meta.url));
const output = process.env.FARMSLOT_SAFE_IDLE_PROOF_OUT;
assert.ok(output, 'Set FARMSLOT_SAFE_IDLE_PROOF_OUT outside the checkout');
const lane = output;
const cli = process.env.FARMSLOT_CLI;
assert.ok(
  cli && path.isAbsolute(cli),
  'Set FARMSLOT_CLI to an owned immutable distribution executable',
);
assert.ok(
  existsSync(path.resolve(path.dirname(await realpath(cli)), '../../..', 'DEPLOYED-REVISION.json')),
  'Use an immutable CLI distribution, not a development workspace',
);
await mkdir(lane, { recursive: true });
const tmux = (...args: string[]) => execFileSync('tmux', args, { encoding: 'utf8' }).trim();
const beforeSessions = tmux('list-sessions', '-F', '#{session_id} #{session_name}').split('\n');
assert.ok(beforeSessions.length, 'Use an existing tmux server, never start one');
const beforeOptions = {
  escape: tmux('show-options', '-sv', 'escape-time'),
  status: tmux('show-options', '-gv', 'status-left-length'),
};
const retainedPath = path.join(lane, 'FIXTURE-smoke-owned-root.json');
const retained = existsSync(retainedPath) ? JSON.parse(await readFile(retainedPath, 'utf8')) : null;
assert.ok(
  !existsSync(path.join(lane, 'FIXTURE-smoke-run-created.json')),
  'Inspect/replay the existing owned run; never create a replacement',
);
if (!retained)
  await writeFile(
    path.join(lane, 'CREATE-ONCE.json'),
    JSON.stringify({ source: code, createdAt: new Date().toISOString() }) + '\n',
    { flag: 'wx' },
  );
const root = retained
  ? await realpath(retained.root)
  : await realpath(await mkdtemp(path.join(tmpdir(), 'safe-idle-slot-smoke-')));
assert.ok(root.startsWith((await realpath(tmpdir())) + path.sep + 'safe-idle-slot-smoke-'));
assert.ok(
  !existsSync(path.join(root, 'repo/.git')),
  'Setup retry only; inspect the retained Git fixture',
);
const project = 'safe-idle-proof';
const slot = 'safe-idle-owned-slot';
const repo = path.join(root, 'repo');
const session = 'safe-idle-owned-smoke';
const proofTmux = 'existing-default-server';
const save = async (name: string, value: unknown) =>
  writeFile(path.join(lane, name), JSON.stringify(value, null, 2) + '\n');
await save('FIXTURE-smoke-owned-root.json', { root, code, project, slot, session, proofTmux });
for (const key of Object.keys(process.env))
  if (/^FARMSLOT_|^GATEWAY_|^NODE_TOKEN$|^GW_URL$|^TMUX/.test(key)) delete process.env[key];
Object.assign(process.env, {
  FARMSLOT_ROOT: root,
  FARMSLOT_POOL_DIR: path.join(root, 'pool'),
  FARMSLOT_PROJECTS_DIR: path.join(root, 'projects'),
  FARMSLOT_RUNS_DIR: path.join(root, 'runs'),
  FARMSLOT_HOME: path.join(root, 'home'),
  FARMSLOT_GATEWAY_AUTH_MODE: 'token',
  GATEWAY_HOST: '127.0.0.1',
  TSX_TSCONFIG_PATH: path.join(code, 'services/gateway/tsconfig.json'),
  FARMSLOT_CLI: cli,
});
for (const dir of [
  'pool',
  `projects/${project}/templates/worker`,
  'runs',
  'home',
  'bin',
  'tmux',
  'repo',
])
  await mkdir(path.join(root, dir), { recursive: true, mode: 0o700 });
for (const name of [
  'scripts',
  'packages',
  'services',
  'schemas',
  'node_modules',
  'CLAUDE.md',
  'package.json',
])
  if (!retained) await symlink(path.join(code, name), path.join(root, name));
  else
    assert.equal(
      await realpath(path.join(root, name)),
      await realpath(path.join(code, name)),
      'Retained fixture source must match',
    );
await writeFile(
  path.join(root, 'pool/proof.json'),
  JSON.stringify(
    {
      machine: 'local',
      host: 'localhost',
      ssh_user: userInfo().username,
      project,
      platform: 'cli',
      slots: [{ id: slot, enabled: true, repo, session }],
    },
    null,
    2,
  ),
);
await writeFile(
  path.join(root, `projects/${project}/project.json`),
  JSON.stringify(
    {
      name: project,
      default_branch: 'main',
      task_dir: 'tasks',
      paths: { runtime_dir: '.agent', artifact_dir: '.task' },
      hooks: { health_check: 'test -f .agent/seed.txt' },
      fixtures: { templates: [{ src: 'seed.txt', dst: '{{runtime_dir}}/seed.txt' }] },
      review: { enabled: false },
      execution_templates: { sources: [] },
      scripted: {
        commands: {
          smoke: {
            command: `${process.execPath} -e "setInterval(() => {}, 1000)"`,
            timeout_ms: 120000,
          },
        },
      },
      prepare: {
        default: 'fixture',
        compatibility_profile: 'fixture',
        profiles: { fixture: { label: 'Owned Git smoke', phases: ['git', 'fixtures', 'health'] } },
      },
    },
    null,
    2,
  ),
);
await mkdir(path.join(root, `projects/${project}/templates/prompts`), { recursive: true });
await writeFile(
  path.join(root, `projects/${project}/templates/prompts/worker-dispatch.md`),
  await readFile(path.join(code, 'projects/farmslot-farm/templates/prompts/worker-dispatch.md')),
);
await mkdir(path.join(root, `projects/${project}/fixtures`), { recursive: true });
await writeFile(
  path.join(root, `projects/${project}/fixtures/seed.txt`),
  'Required runtime fixture\n',
);
await writeFile(
  path.join(root, `projects/${project}/templates/worker/dev.md`),
  '---\nplatforms: [cli]\n---\n# FIXTURE dispatch smoke\n\n- [ ] 1. Record dispatch only.\n',
);
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
    cwd,
    encoding: 'utf8',
  }).trim();
git(root, 'init', '-q', '-b', 'main', repo);
git(repo, 'config', 'user.name', 'Fixture');
git(repo, 'config', 'user.email', 'fixture@example.invalid');
git(repo, 'config', 'commit.gpgsign', 'false');
await writeFile(path.join(repo, 'base.ts'), 'export const base = true;\n');
await writeFile(path.join(repo, '.gitignore'), '.agent/\n.task/\n');
git(repo, 'add', '.');
git(repo, 'commit', '-qm', 'test: seed smoke');
const remote = path.join(root, 'remote.git');
git(root, 'init', '-q', '--bare', remote);
git(repo, 'remote', 'add', 'origin', remote);
git(repo, 'push', '-q', 'origin', 'main');
git(repo, 'checkout', '-qb', 'fix/merged-ticket');
await writeFile(path.join(repo, 'merged.txt'), 'Published ticket work\n');
git(repo, 'add', '.');
git(repo, 'commit', '-qm', 'test: published ticket');
git(repo, 'push', '-q', '-u', 'origin', 'fix/merged-ticket');
const mergedHead = git(repo, 'rev-parse', 'HEAD');
git(repo, 'checkout', 'main');
git(repo, 'merge', '--squash', 'fix/merged-ticket');
git(repo, 'commit', '-qm', 'test: squash merged ticket');
await writeFile(path.join(repo, 'new-main.txt'), 'New main after ticket\n');
git(repo, 'add', '.');
git(repo, 'commit', '-qm', 'test: advance default');
git(repo, 'push', '-q', 'origin', 'main');
const latestMain = git(repo, 'rev-parse', 'HEAD');
git(repo, 'push', '-q', 'origin', '--delete', 'fix/merged-ticket');
git(repo, 'checkout', 'fix/merged-ticket');
assert.equal(git(repo, 'status', '--porcelain'), '');
await save('merged-slot-before.json', {
  branch: git(repo, 'branch', '--show-current'),
  head: mergedHead,
  latestMain,
});
await writeFile(
  path.join(root, '.farm-status.json'),
  JSON.stringify({
    checkedAt: new Date().toISOString(),
    slots: [
      {
        slot,
        machine: 'local',
        platform: 'cli',
        project,
        enabled: true,
        dispatchable: true,
        lifecycle: 'ready',
        phase: null,
        branch: 'fix/merged-ticket',
        current_run_id: null,
        slot_epoch: 1,
        health: {},
      },
    ],
  }),
);
const load = (file: string) => import(pathToFileURL(path.join(code, file)).href);
const { createGatewayAuthRuntime } = await load('services/gateway/src/security/auth.ts');
const auth = createGatewayAuthRuntime({ FARMSLOT_HOME: path.join(root, 'home') });
const person = auth.writer.createPrincipal(
  { type: 'person', displayName: 'FIXTURE automatic slot reuse proof' },
  [{ role: 'admin', scope: { kind: 'global' } }],
);
const credential = auth.writer.issueCredential(person.id, 'Owned local smoke');
const grant = auth.writer.exchangePersonCredential(credential.secret, {
  deviceName: 'Owned proof',
  deviceKind: 'cli',
});
const { createWebSocketServer, broadcastEvent } = await load('services/gateway/src/server.ts');
const { initRunEngine } = await load('services/gateway/src/run-engine/orchestrator.ts');
const { GatewayClient } = await load('packages/cli/src/gateway-client.ts');
initRunEngine(broadcastEvent);
const http = createServer();
const wss = createWebSocketServer(http, auth);
await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
const address = http.address();
assert(address && typeof address !== 'string');
const client = await new GatewayClient({
  url: `ws://127.0.0.1:${address.port}/ws`,
  credential: { token: grant.accessToken },
  timeout: 120000,
}).connect();
let runId: string | undefined;
let complete = false;
try {
  const created = await client.call('run.create', {
    project,
    flowType: 'dev',
    mode: 'autonomous',
    lane: 'validation',
    runner: 'scripted',
    model: 'scripted',
    scripted: { mode: 'command', commandRef: 'smoke' },
    transport: 'tmux',
    ticketOrPr: 'REUSE-1',
    prepareProfile: 'fixture',
    completionPolicy: 'artifact-only',
    ticketData: {
      source: 'manual',
      title: 'FIXTURE automatic slot reuse smoke',
      description: 'Dispatch the owned framework smoke and cancel it. No product or publication.',
      affectedArea: '',
      acceptanceCriteria: ['write-task, prepare and dispatch complete'],
      stepsToReproduce: [],
      screenshots: [],
      labels: [],
    },
  });
  runId = created.run.id;
  await save('FIXTURE-smoke-run-created.json', created);
  let previous = '';
  const deadline = Date.now() + 180000;
  while (Date.now() < deadline) {
    const { run } = await client.call('run.get', { runId });
    await save('FIXTURE-smoke-run-latest.json', run);
    const summary = JSON.stringify({
      id: run.id,
      status: run.status,
      step: run.currentStep,
      error: run.error,
      steps: run.steps.map((s: { name: string; status: string }) => [s.name, s.status]),
    });
    if (summary !== previous) {
      console.log(summary);
      previous = summary;
    }
    if (run.steps.find((s: { name: string }) => s.name === 'dispatch')?.status === 'done') {
      for (const name of ['write-task', 'prepare', 'dispatch'])
        assert.equal(run.steps.find((s: { name: string }) => s.name === name)?.status, 'done');
      assert.equal(
        await readFile(path.join(repo, '.agent/seed.txt'), 'utf8'),
        'Required runtime fixture\n',
      );
      assert.equal(
        await readFile(path.join(repo, 'new-main.txt'), 'utf8'),
        'New main after ticket\n',
      );
      assert.equal(
        run.decisions.some(
          (decision: { type: string }) => decision.type === 'engine_no_suitable_slot',
        ),
        false,
      );
      assert.equal(run.allowedSlots, null);
      assert.equal(
        run.steps.find((step: { name: string }) => step.name === 'find-slot')?.outputs
          ?.selectionMethod,
        'scored',
      );
      assert.equal(git(repo, 'rev-parse', 'fix/merged-ticket'), mergedHead);
      await save('FIXTURE-smoke-PASS.json', {
        pass: true,
        runId,
        runner: 'scripted',
        candidate: code,
        steps: ['write-task', 'prepare', 'dispatch'],
        productionMethodsSubstituted: false,
        run,
      });
      complete = true;
      break;
    }
    if (['failed', 'blocked', 'cancelled'].includes(run.status))
      throw new Error(`Owned smoke ${run.id} stopped: ${run.error}`);
    if (run.decisions.some((d: { status: string }) => d.status === 'pending'))
      throw new Error('Owned smoke requires a decision; inspect this same run');
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert(complete, 'Inspect this same run; do not create a replacement');
} finally {
  if (runId) {
    const current = await client.call('run.get', { runId });
    if (!['done', 'failed', 'cancelled'].includes(current.run.status))
      await save(
        'FIXTURE-smoke-cancel.json',
        await client.call('run.cancel', {
          runId,
          reason: 'Owned automatic slot reuse smoke complete; no full run',
        }),
      );
    await save('FIXTURE-smoke-after-cancel.json', await client.call('run.get', { runId }));
    if (complete) {
      await save('FIXTURE-smoke-archive.json', await client.call('run.archive', { runId }));
      assert.equal(git(repo, 'branch', '--show-current'), 'main');
      assert.equal(git(repo, 'rev-parse', 'HEAD'), latestMain);
      assert.equal(git(repo, 'rev-parse', 'fix/merged-ticket'), mergedHead);
    }
  }
  client.close();
  await new Promise<void>((resolve) => wss.close(() => resolve()));
  await new Promise<void>((resolve) => http.close(() => resolve()));
  const afterSessions = tmux('list-sessions', '-F', '#{session_id} #{session_name}').split('\n');
  for (const before of beforeSessions)
    assert.ok(afterSessions.includes(before), 'Existing session changed: ' + before);
  assert.equal(tmux('show-options', '-sv', 'escape-time'), beforeOptions.escape);
  assert.equal(tmux('show-options', '-gv', 'status-left-length'), beforeOptions.status);
  await save('FIXTURE-smoke-session-check.json', {
    beforeSessions,
    afterSessions,
    beforeOptions,
    root,
    session,
  });
}
console.log(JSON.stringify({ complete, runId, retainedRoot: root, output: lane }));
process.exit(complete ? 0 : 1);
