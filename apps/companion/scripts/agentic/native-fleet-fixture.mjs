// AC4 source fixtures and bounded real writers. No device/bootstrap/service ownership.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const sourceRoot = fileURLToPath(new URL('../../../../', import.meta.url)).replace(
  /\/$/,
  '',
);
export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const inside = (base, file) =>
  file === base ||
  (!path.relative(base, file).startsWith('..') && !path.isAbsolute(path.relative(base, file)));
const json = async (file) => JSON.parse(await readFile(file, 'utf8'));
const put = (file, value) =>
  writeFile(file, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
const self = fileURLToPath(import.meta.url);

/** Read-only preflight, before device imports, subprocesses or network work. */
export async function resolveFleetInputs(env = process.env) {
  const errors = [],
    inputs = [];
  const check = (ok, label) => {
    if (!ok) errors.push(label);
  };
  const file = async (label, target, parse = false) => {
    try {
      assert(target && path.isAbsolute(target));
      assert(!(await lstat(target)).isSymbolicLink());
      const resolved = await realpath(target),
        raw = await readFile(resolved);
      assert((await stat(resolved)).isFile());
      inputs.push({ label, path: resolved, sha256: sha256(raw) });
      return parse ? JSON.parse(raw) : raw;
    } catch {
      errors.push(`${label}: provide a readable valid regular file`);
    }
  };
  const directory = async (key) => {
    try {
      assert(env[key] && path.isAbsolute(env[key]));
      const resolved = await realpath(env[key]);
      assert((await stat(resolved)).isDirectory());
      return resolved;
    } catch {
      errors.push(`${key}: provide an existing absolute owned directory`);
    }
  };
  const home = await directory('FARMSLOT_HOME');
  const artifacts = await directory('FARMSLOT_RECIPE_ARTIFACTS_DIR');
  const stateDir = await directory('FARMSLOT_AGENT_DEVICE_STATE_DIR');
  const proxyDir = await directory('FARMSLOT_NATIVE_STORE_PROXY_DIR');
  const fixture = await file('AC4 fixture', env.FARMSLOT_NATIVE_AC4_FIXTURE, true);
  const profiles = await file(
    'CLI gateway profiles',
    home && path.join(home, 'gateways.json'),
    true,
  );
  const profile = profiles?.gateways?.[env.FARMSLOT_GATEWAY_PROFILE];
  try {
    const url = new URL(profile.url);
    assert.equal(url.protocol, 'ws:');
    assert.equal(url.hostname, '127.0.0.1');
    assert.equal(url.port, env.GATEWAY_PORT);
    assert.equal(url.pathname, '/');
    assert(!url.username && !url.password && !url.search && !url.hash);
    assert.equal(profile.authMode, 'token');
    assert(profile.secret);
  } catch {
    errors.push('CLI profile must select the owned loopback gateway and token, not the app proxy');
  }
  for (const key of ['GATEWAY_PORT', 'METRO_PORT', 'FARMSLOT_NATIVE_STORE_PROXY_PORT'])
    check(
      /^[1-9]\d*$/.test(env[key] ?? '') && Number(env[key]) < 65536,
      `${key}: require explicit owned port`,
    );
  check(
    new Set([env.GATEWAY_PORT, env.METRO_PORT, env.FARMSLOT_NATIVE_STORE_PROXY_PORT]).size === 3,
    'Select distinct gateway, Metro and existing passive proxy ports',
  );
  check(
    env.PLATFORM === 'ios' && /^[a-f0-9-]{36}$/i.test(env.IOS_SIMULATOR ?? ''),
    'PLATFORM=ios and exact reserved IOS_SIMULATOR UUID required',
  );
  check(
    env.FARMSLOT_DISABLE_ORCHESTRATION === '1',
    'FARMSLOT_DISABLE_ORCHESTRATION=1 required; no provider execution',
  );
  check(
    env.FARMSLOT_BRANCH_WATCHERS === '1',
    'FARMSLOT_BRANCH_WATCHERS=1 required on the private gateway',
  );
  const proxy = await file(
    'existing proxy ready receipt',
    proxyDir && path.join(proxyDir, 'ready.json'),
    true,
  );
  check(
    proxy?.root === sourceRoot &&
      String(proxy?.port) === env.FARMSLOT_NATIVE_STORE_PROXY_PORT &&
      String(proxy?.upstreamPort) === env.GATEWAY_PORT,
    'Proxy receipt must belong to this source checkout and selected ports',
  );
  check(
    Number.isSafeInteger(Number(env.FARMSLOT_NATIVE_AC4_NODE_PID)) &&
      Number(env.FARMSLOT_NATIVE_AC4_NODE_PID) > 0,
    'FARMSLOT_NATIVE_AC4_NODE_PID must identify the root-supervised real node',
  );
  if (fixture) {
    try {
      assert.equal(fixture.version, 1);
      assert.equal(fixture.sourceRoot, sourceRoot);
      assert.equal(fixture.home, home);
      assert.equal(await realpath(fixture.root), fixture.root);
      assert.equal(await realpath(fixture.repo), fixture.repo);
      assert(inside(fixture.root, fixture.repo) && !inside(sourceRoot, fixture.repo));
      assert.equal(path.dirname(await realpath(env.FARMSLOT_NATIVE_AC4_FIXTURE)), fixture.root);
      assert(/^[a-f0-9-]{36}$/.test(fixture.runId));
      assert(/^[a-zA-Z0-9._-]+$/.test(fixture.slotId));
      assert(/^[a-zA-Z0-9._-]+$/.test(fixture.machine) && fixture.machine !== os.hostname());
      assert.equal(fixture.host, `${fixture.machine}.invalid`); // force real remote-node admission, never local fallback
      assert.equal(fixture.taskDir, path.join(fixture.repo, '.task/dev/ac4'));
      assert.equal(fixture.controlRoot, path.join(fixture.root, 'control'));
      assert.equal(env.FARMSLOT_ROOT, fixture.controlRoot);
      assert.equal(env.FARMSLOT_RUNS_DIR, path.join(fixture.controlRoot, '.runs'));
      for (const [label, expected] of Object.entries(fixture.baseline)) {
        assert(inside(fixture.root, expected.path));
        const raw = await file(label, expected.path);
        check(
          raw && sha256(raw) === expected.sha256,
          `${label}: prepared source drift; preserve consumed fixture, do not rerun writers`,
        );
      }
      const run = await json(path.join(fixture.controlRoot, '.runs', `${fixture.runId}.json`));
      const pool = await json(path.join(fixture.controlRoot, 'pool', `${fixture.machine}.json`));
      const status = await json(path.join(fixture.controlRoot, '.farm-status.json'));
      assert.equal(run.slotId, fixture.slotId);
      assert.equal(run.taskFile, path.join(fixture.taskDir, 'TASK.md'));
      assert.equal(pool.slots.length, 1);
      assert.equal(pool.host, fixture.host);
      assert.equal(pool.slots[0].repo, fixture.repo);
      assert.equal(pool.slots[0].id, fixture.slotId);
      assert.equal(status.slots[0].current_run_id, fixture.runId);
      assert.equal(status.slots[0].task_file, 'dev/ac4');
    } catch {
      errors.push(
        'Fixture ownership, source identity, pool/run/task binding or gateway environment is invalid',
      );
    }
  }
  const scriptDir = path.dirname(self);
  for (const relative of [
    'native-fleet-fixture.mjs',
    'native-store-fixture.mjs',
    'prove-native-fleet.mjs',
    'd05-fixture.mjs',
    'simulator-dev-client.mjs',
  ])
    await file(relative, path.join(scriptDir, relative));
  const recipe = await file(
    'fleet recipe',
    path.join(scriptDir, 'recipe/recipes/fleet-live.recipe.json'),
    true,
  );
  const manifest = await file(
    'action manifest',
    path.join(scriptDir, 'recipe/action-manifest.json'),
    true,
  );
  if (recipe && manifest) {
    try {
      const { d05RecipeErrors } = await import('./d05-fixture.mjs');
      for (const finding of await d05RecipeErrors(recipe, manifest, {}))
        errors.push(`recipe: ${finding.message ?? JSON.stringify(finding)}`);
    } catch {
      errors.push('Recipe/action-manifest pure validation unavailable');
    }
  }
  for (const relative of [
    'src/farmslot/run-collections-proof.ts',
    'src/features/diff/SlotDiffScreen.tsx',
    'src/features/slot-workspace/use-slot-workspace-controller.ts',
  ]) {
    const raw = await file(relative, path.join(sourceRoot, 'apps/companion', relative));
    check(
      raw?.toString().includes('ac4'),
      `${relative}: integrate the separate dev-only AC4 frame proposal first`,
    );
  }
  if (errors.length)
    throw new Error(`AC4 preflight inputs:\n${errors.map((error) => `- ${error}`).join('\n')}`);
  const scheme = env.SCHEME || `farmslot-${env.APP_VARIANT || 'development'}`;
  check(/^[a-z][a-z0-9+.-]*$/i.test(scheme), 'Valid application deep-link scheme required');
  if (errors.length) throw new Error(errors.join('\n'));
  const plan = {
    version: 1,
    sourceRoot,
    fixturePath: await realpath(env.FARMSLOT_NATIVE_AC4_FIXTURE),
    fixture,
    artifacts,
    stateDir,
    simulator: env.IOS_SIMULATOR,
    metroPort: Number(env.METRO_PORT),
    proxyPort: Number(env.FARMSLOT_NATIVE_STORE_PROXY_PORT),
    proxyStartId: proxy.startId,
    nodePid: Number(env.FARMSLOT_NATIVE_AC4_NODE_PID),
    home,
    profileName: env.FARMSLOT_GATEWAY_PROFILE,
    slotRoute: `${scheme}:///workspace/slot/${encodeURIComponent(fixture.slotId)}/slot?runId=${fixture.runId}`,
    diffRoute: `${scheme}:///workspace/slot/${encodeURIComponent(fixture.slotId)}/diff?path=ac4.txt`,
    inputs,
  };
  return { ...plan, inputHash: sha256(JSON.stringify(plan)) };
}

async function execute(file, args, options = {}) {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const env = { ...process.env };
  for (const key of Object.keys(env))
    if (key.startsWith('GIT_') || key.startsWith('FARMSLOT_SIGNAL_')) delete env[key];
  delete env.FARMSLOT_MARK_CMD;
  return promisify(execFile)(file, args, {
    env,
    timeout: 15000,
    maxBuffer: 1024 * 1024,
    ...options,
  });
}

/** Root invokes once, before its private gateway/node startup. Creates no services or UI state. */
async function prepare() {
  assert(process.env.FARMSLOT_DISABLE_ORCHESTRATION === '1');
  const requested = process.env.FARMSLOT_NATIVE_AC4_ROOT;
  assert(requested && path.isAbsolute(requested) && !inside(sourceRoot, requested));
  const home = await realpath(process.env.FARMSLOT_HOME);
  const parent = await realpath(path.dirname(requested));
  const root = path.join(parent, path.basename(requested));
  assert(!inside(root, home));
  await mkdir(root); // exclusive: never reuse or remove somebody else's scratch tree
  const machine = process.env.MACHINE_NAME;
  assert(/^[a-zA-Z0-9._-]+$/.test(machine ?? '') && machine !== os.hostname());
  const runId = randomUUID(),
    slotId = `${machine}-ac4`,
    project = 'native-ac4';
  const repo = path.join(root, 'repo'),
    controlRoot = path.join(root, 'control');
  await put(path.join(root, 'owner.json'), {
    version: 1,
    sourceRoot,
    runId,
    home,
    createdAt: Date.now(),
  });
  for (const dir of [
    repo,
    controlRoot,
    path.join(controlRoot, 'pool'),
    path.join(controlRoot, '.runs'),
    path.join(controlRoot, 'projects', project),
  ])
    await mkdir(dir, { recursive: true });
  for (const name of ['CLAUDE.md', 'scripts', 'services', 'packages', 'node_modules', 'schemas'])
    await symlink(path.join(sourceRoot, name), path.join(controlRoot, name));
  const beforeBranch = `ac4-before-${runId.slice(0, 8)}`,
    afterBranch = `ac4-after-${runId.slice(0, 8)}`;
  const git = (...args) => execute('git', ['-c', 'core.hooksPath=/dev/null', '-C', repo, ...args]);
  await git('init', '--initial-branch', beforeBranch);
  await writeFile(path.join(repo, 'ac4.txt'), 'AC4_GIT_BASE\n', { flag: 'wx' });
  await git('add', '--', 'ac4.txt');
  const tree = (await git('write-tree')).stdout.trim();
  const commit = (
    await git(
      '-c',
      'user.name=AC4 private source',
      '-c',
      'user.email=ac4@example.invalid',
      'commit-tree',
      tree,
      '-m',
      'Private source baseline',
    )
  ).stdout.trim();
  await git('update-ref', `refs/heads/${beforeBranch}`, commit);
  await writeFile(path.join(repo, 'ac4.txt'), 'AC4_GIT_BEFORE\n');
  await writeFile(path.join(repo, '.gitignore'), '.task/\n');
  const { writeTaskDir, buildHandoffMetadata, builtinTerminalContract } =
    await import('@farmslot/agent-runtime');
  const taskDir = path.join(repo, '.task/dev/ac4');
  const terminalContract = builtinTerminalContract('dev');
  const checklist =
    '# AC4 source\n\n- [ ] **1. AC4 first source mark**\n- [ ] **2. AC4 retained open step**\n';
  await writeTaskDir({
    taskDir,
    taskMarkdown: '# AC4 source-only task fixture\nNo provider or worker is executed.\n',
    checklistMarkdown: checklist,
    terminalContract,
    handoff: buildHandoffMetadata({
      attemptId: runId,
      surface: 'farmslot',
      project,
      flow: 'dev',
      title: 'AC4 source observations',
      sourceKind: 'text',
      terminalContract,
    }),
  });
  await execute(path.join(taskDir, 'mark'), ['start'], { cwd: taskDir });
  const signal = await json(path.join(taskDir, 'SIGNAL.json'));
  const now = new Date().toISOString();
  // Setup-time source run metadata only. No ready receipt, session, lease or command is manufactured.
  const run = {
    id: runId,
    familyId: runId,
    parentRunId: null,
    familyRootTicketOrPr: 'AC4 source observations',
    lane: 'production',
    variant: null,
    flowType: 'dev',
    mode: 'interactive',
    status: 'monitoring',
    project,
    ticketOrPr: 'AC4 source observations',
    slotId,
    branch: beforeBranch,
    taskFile: path.join(taskDir, 'TASK.md'),
    steps: [{ name: 'monitor', status: 'running' }],
    decisions: [],
    agentContexts: [
      {
        id: 'worker',
        role: 'primary',
        label: 'Source fixture',
        status: 'working',
        slotId,
        runId,
        taskFile: path.join(taskDir, 'TASK.md'),
        signalFile: path.join(taskDir, 'SIGNAL.json'),
        attemptStartedAt: signal.timestamp,
        signalAttemptId: signal.attemptId,
      },
    ],
    metrics: {
      nudgeCount: 0,
      model: null,
      runner: null,
      runnerSessionId: null,
      runnerSessionPath: null,
    },
    createdAt: now,
    updatedAt: now,
  };
  await put(path.join(controlRoot, '.runs', `${runId}.json`), run);
  await put(path.join(controlRoot, 'projects', project, 'project.json'), {
    name: project,
    runtime_dir: '.agent',
    artifact_dir: 'artifacts',
    resources: {},
  });
  const host = `${machine}.invalid`;
  await put(path.join(controlRoot, 'pool', `${machine}.json`), {
    schema_version: 2,
    machine,
    project,
    platform: 'web',
    os: process.platform === 'darwin' ? 'darwin' : 'linux',
    host,
    ssh_user: 'ac4',
    slots: [{ id: slotId, enabled: true, repo, session: slotId, resources: {} }],
  });
  await put(path.join(controlRoot, '.farm-status.json'), {
    checked_at: now,
    slots: [
      {
        slot: slotId,
        machine,
        project,
        platform: 'web',
        repo,
        enabled: true,
        lifecycle: 'busy',
        phase: 'working',
        agent: 'idle',
        mode: 'dispatch',
        branch: beforeBranch,
        current_run_id: runId,
        current_ticket_or_pr: run.ticketOrPr,
        task_file: 'dev/ac4',
        session: slotId,
      },
    ],
  });
  const baseline = {};
  for (const [label, file] of Object.entries({
    owner: path.join(root, 'owner.json'),
    gitHead: path.join(repo, '.git/HEAD'),
    gitText: path.join(repo, 'ac4.txt'),
    checklist: path.join(taskDir, 'CHECKLIST.md'),
    signal: path.join(taskDir, 'SIGNAL.json'),
    mark: path.join(taskDir, 'mark'),
    run: path.join(controlRoot, '.runs', `${runId}.json`),
    pool: path.join(controlRoot, 'pool', `${machine}.json`),
    project: path.join(controlRoot, 'projects', project, 'project.json'),
  }))
    baseline[label] = { path: file, sha256: sha256(await readFile(file)) };
  const fixture = {
    version: 1,
    sourceRoot,
    root,
    home,
    repo,
    controlRoot,
    taskDir,
    slotId,
    runId,
    machine,
    host,
    beforeBranch,
    afterBranch,
    baseline,
  };
  await put(path.join(root, 'fixture.json'), fixture);
  process.stdout.write(
    `${JSON.stringify({ prepared: true, fixture: path.join(root, 'fixture.json'), controlRoot, runId, slotId, machine })}\n`,
  );
}

/** Independent real filesystem/Git/mark writer on the same host as the registered node. */
async function write(kind, fixturePath) {
  assert(['branch', 'progress', 'git'].includes(kind));
  const f = await json(await realpath(fixturePath));
  assert.equal(f.sourceRoot, sourceRoot);
  assert.equal(await realpath(path.dirname(fixturePath)), f.root);
  assert(inside(f.root, f.repo) && !inside(sourceRoot, f.repo));
  assert.equal((await json(path.join(f.root, 'owner.json'))).runId, f.runId);
  const receiptFile = path.join(f.root, `writer-${kind}.json`);
  await put(receiptFile, { status: 'consumed', kind, runId: f.runId, startedAt: Date.now() });
  const expectBaseline = async (name) =>
    assert.equal(
      sha256(await readFile(f.baseline[name].path)),
      f.baseline[name].sha256,
      `${name} changed before its owned writer`,
    );
  let data;
  if (kind === 'branch') {
    await expectBaseline('gitHead');
    await execute('git', [
      '-c',
      'core.hooksPath=/dev/null',
      '-C',
      f.repo,
      'switch',
      '--no-track',
      '-c',
      f.afterBranch,
    ]);
    data = { branch: (await readFile(f.baseline.gitHead.path, 'utf8')).trim() };
  } else if (kind === 'progress') {
    await expectBaseline('mark');
    await expectBaseline('checklist');
    await expectBaseline('signal');
    await execute(path.join(f.taskDir, 'mark'), ['1'], { cwd: f.taskDir });
    const signal = await json(path.join(f.taskDir, 'SIGNAL.json'));
    const mark = signal.checklistTiming?.events?.find((event) => event.stepNumber === 1);
    assert(mark?.checkedAt && signal.attemptId);
    data = {
      mark,
      attemptId: signal.attemptId,
      signalSha256: sha256(await readFile(f.baseline.signal.path)),
      checklistSha256: sha256(await readFile(f.baseline.checklist.path)),
    };
  } else {
    await expectBaseline('gitText');
    await writeFile(f.baseline.gitText.path, 'AC4_GIT_AFTER\n');
    data = { sha256: sha256(await readFile(f.baseline.gitText.path)) };
  }
  const receipt = { status: 'committed', kind, runId: f.runId, finishedAt: Date.now(), data };
  await writeFile(receiptFile, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(`${JSON.stringify(receipt)}\n`);
}
if (process.argv[1] && path.resolve(process.argv[1]) === self) {
  try {
    if (process.argv[2] === 'prepare') await prepare();
    else if (process.argv[2] === 'write') await write(process.argv[3], process.argv[4]);
    else throw new Error('Use prepare, or write <branch|progress|git> <private fixture.json>');
  } catch (error) {
    process.stderr.write(
      `AC4 fixture failed (${error.code || error.name}); preserve its private files for disposition.\n`,
    );
    process.exitCode = 1;
  }
}
