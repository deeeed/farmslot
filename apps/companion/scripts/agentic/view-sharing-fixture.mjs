#!/usr/bin/env node
// Launch-time source fixtures only. Never writes native/UI/cache state.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, realpath, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// An inherited tmux client selects its server even when TMUX_TMPDIR is private.
delete process.env.TMUX;
delete process.env.TMUX_PANE;

const sourceRoot = fileURLToPath(new URL('../../../../', import.meta.url)).replace(/\/$/, '');
const caseDir = process.env.FARMSLOT_VIEW_SHARING_CASE;
assert(caseDir && path.isAbsolute(caseDir), 'Set a fresh absolute FARMSLOT_VIEW_SHARING_CASE');
assert(!caseDir.startsWith(sourceRoot + '/'), 'Keep proof state outside the product checkout');
const put = (file, value) =>
  writeFile(file, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const controlRoot = path.join(caseDir, 'control');
const home = path.join(caseDir, 'home');
const runsDir = path.join(caseDir, 'runs');
const project = 'view-sharing-proof';
const gatewayPort = Number(process.env.GATEWAY_PORT);
assert(Number.isInteger(gatewayPort) && gatewayPort > 1024 && gatewayPort < 65536);
const url = `ws://127.0.0.1:${gatewayPort}`;

// Imported owning stores capture these paths once. Refuse inherited native state.
for (const key of Object.keys(process.env)) {
  if (key.startsWith('FARMSLOT_NATIVE_')) delete process.env[key];
}
Object.assign(process.env, {
  FARMSLOT_HOME: home,
  FARMSLOT_ROOT: controlRoot,
  FARMSLOT_POOL_DIR: path.join(controlRoot, 'pool'),
  FARMSLOT_PROJECTS_DIR: path.join(controlRoot, 'projects'),
  FARMSLOT_RUNS_DIR: runsDir,
  FARMSLOT_DISABLE_ORCHESTRATION: '1',
  FARMSLOT_COPILOT_DANGEROUS_AUTOSTART: '',
  FARMSLOT_OPERATOR_CHECKOUT: sourceRoot,
});

if (process.argv[2] === 'prepare') {
  await mkdir(caseDir, { mode: 0o700 }); // Exclusive case. No reuse or duplicate setup.
  for (const directory of [
    home,
    controlRoot,
    path.join(controlRoot, 'pool'),
    runsDir,
    path.join(controlRoot, 'projects', project),
  ])
    await mkdir(directory, { recursive: true, mode: 0o700 });
  assert.equal(await realpath(caseDir), caseDir, 'Require a canonical private path');
  // Existing root discovery checks these source markers. Runtime state remains private.
  for (const marker of ['CLAUDE.md', 'scripts', 'services'])
    await symlink(path.join(sourceRoot, marker), path.join(controlRoot, marker));
  const { testGatewayIdentity } = await import(
    path.join(sourceRoot, 'scripts/lib/test-gateway-identity-source.mts')
  );
  const token = testGatewayIdentity(home, url);
  await writeFile(path.join(caseDir, 'actor.secret'), token + '\n', { flag: 'wx', mode: 0o600 });
  await put(path.join(controlRoot, 'projects', project, 'project.json'), {
    name: project,
    runtime_dir: '.agent',
    artifact_dir: 'artifacts',
    resources: {},
  });
  // Local shell fixture in a private tmux namespace, never a shared farm slot.
  const machine = os.hostname().replace(/\.local$/, '');
  await put(path.join(controlRoot, 'pool', machine + '.json'), {
    schema_version: 2,
    machine,
    project,
    platform: 'web',
    os: process.platform,
    host: 'localhost',
    ssh_user: '',
    slots: [],
  });
  const { createRun, updateRun, persistRunNow } = await import(
    path.join(sourceRoot, 'services/gateway/src/runs/store.ts')
  );
  const runs = [];
  for (const title of ['Shared run target', 'Different control run']) {
    const run = createRun(
      { flowType: 'dev', project, ticketOrPr: title, mode: 'interactive' },
      { deferBackgroundPersist: true },
    );
    updateRun(run.id, { status: 'done', summary: title, completedAt: new Date().toISOString() });
    await persistRunNow(run, 'view-sharing launch fixture');
    const raw = await readFile(path.join(runsDir, run.id + '.json'));
    await writeFile(path.join(caseDir, run.id + '.setup.json'), raw, { flag: 'wx', mode: 0o600 });
    runs.push({ id: run.id, title, sha256: digest(raw) });
  }
  await put(path.join(caseDir, 'fixture.json'), {
    version: 1,
    sourceRoot,
    caseDir,
    controlRoot,
    runsDir,
    home,
    profile: 'proof',
    project,
    machine,
    gatewayPort,
    gatewayUrl: url,
    runs,
  });
  console.log(
    JSON.stringify({ prepared: true, caseDir, sourceRoot, runs, credentialsPrinted: false }),
  );
} else if (process.argv[2] === 'prepare-worker') {
  const fixture = JSON.parse(await readFile(path.join(caseDir, 'fixture.json'), 'utf8'));
  assert.equal(fixture.sourceRoot, sourceRoot);
  const socketRoot = process.env.TMUX_TMPDIR;
  assert(socketRoot && socketRoot.startsWith('/tmp/') && !socketRoot.includes('..'));
  await mkdir(socketRoot, { mode: 0o700 }); // Must be fresh and owned.
  const inputPath = path.join(caseDir, 'worker-input.jsonl');
  const shellPath = path.join(caseDir, 'worker-shell.mjs');
  await writeFile(
    shellPath,
    `import fs from 'node:fs';
process.stdin.setEncoding('utf8');
if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.on('data', data => fs.appendFileSync(${JSON.stringify(inputPath)}, JSON.stringify({ at: Date.now(), data })+'\\n'));
console.log('Private view-sharing terminal ready');
`,
    { flag: 'wx', mode: 0o600 },
  );
  const { COPILOT_TMUX_SESSION, COPILOT_TMUX_WINDOW_NAME, COPILOT_TMUX_TARGET } =
    await import('@farmslot/protocol');
  execFileSync('tmux', [
    '-f',
    '/dev/null',
    'new-session',
    '-d',
    '-s',
    COPILOT_TMUX_SESSION,
    '-n',
    COPILOT_TMUX_WINDOW_NAME,
    '-c',
    caseDir,
    process.execPath,
    shellPath,
  ]);
  const pane = execFileSync(
    'tmux',
    ['display-message', '-p', '-t', COPILOT_TMUX_TARGET, '#{pane_id}\t#{pane_pid}\t#{pid}'],
    { encoding: 'utf8' },
  )
    .trim()
    .split('\t');
  const { CopilotRuntimeStore } = await import(
    path.join(sourceRoot, 'services/gateway/src/copilot-runtime/session-store.ts')
  );
  const { inspectCopilotCheckout } = await import(
    path.join(sourceRoot, 'services/gateway/src/copilot-runtime/live-fix-policy.ts')
  );
  const { dangerousLaunchBinding } = await import(
    path.join(sourceRoot, 'services/gateway/src/copilot-runtime/authorization.ts')
  );
  const checkout = await inspectCopilotCheckout(sourceRoot);
  const now = new Date().toISOString();
  const runner = 'scripted',
    model = 'private-shell';
  const store = new CopilotRuntimeStore(home);
  assert.equal(await store.load(), null, 'Never replace an existing Co-Pilot fixture');
  await store.save({
    schemaVersion: 1,
    transcriptOffset: 0,
    paneId: pane[0],
    session: {
      runtimeId: 'gateway-copilot',
      status: 'running',
      tmuxTarget: COPILOT_TMUX_TARGET,
      transcriptId: 'global',
      runner,
      model,
      effort: 'auto',
      autostart: false,
      safetyTier: 'sandboxed',
      checkout,
      workload: {
        severity: 'normal',
        totals: {
          implementation: 0,
          review: 0,
          reviewRework: 0,
          ciFix: 0,
          fullQa: 0,
          recipe: 0,
          prepare: 0,
          devServer: 0,
          copilot: 1,
          total: 1,
        },
        hosts: [],
        policy: {
          singleton: true,
          automaticCancellation: false,
          automaticDispatch: false,
          automaticFanOut: false,
        },
      },
      lastDelivery: { id: 'fixture-idle', state: 'idle', requestedAt: now },
      createdAt: now,
      startedAt: now,
      updatedAt: now,
      dangerousLaunch: dangerousLaunchBinding({ checkout, runner, model, effort: 'auto' }),
    },
  });
  const rawSession = await readFile(store.sessionPath);
  await writeFile(path.join(caseDir, 'copilot.setup.json'), rawSession, {
    flag: 'wx',
    mode: 0o600,
  });
  const serverBirth = execFileSync('ps', ['-p', pane[2], '-o', 'lstart='], {
    encoding: 'utf8',
  }).trim();
  assert(serverBirth, 'Retain the actual private tmux server birth');
  const receipt = {
    socketRoot,
    session: COPILOT_TMUX_SESSION,
    target: COPILOT_TMUX_TARGET,
    paneId: pane[0],
    panePid: Number(pane[1]),
    serverPid: Number(pane[2]),
    serverBirth,
    sessionSha256: digest(rawSession),
    inputPath,
    sourceRoot,
  };
  await put(path.join(caseDir, 'worker-setup.json'), receipt);
  console.log(JSON.stringify({ prepared: true, ...receipt }));
} else throw new Error('Use prepare or prepare-worker. Importing this file is not a preflight.');
