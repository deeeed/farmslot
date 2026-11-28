/**
 * Isolated live gateway recipe proving Antigravity catalog, CLI dispatch,
 * real worker execution (model confirmation, acceptance, progress, completion),
 * separate-run cancellation, retained handoff without duplicate send, and
 * negative unavailability / invalid-model error paths.
 *
 * Uses an isolated private gateway, isolated FARMSLOT_HOME / native state,
 * and an isolated temp git repo. Never touches the shared gateway or active lanes.
 */
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import {
  copyFile,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import type {
  NativeSessionCatalogResult,
  NativeSessionReadResult,
  Run,
  RunnerModelCatalogResult,
} from '@farmslot/protocol';

import {
  buildProofManifest,
  createAttemptOutputDir,
  ensureFrozenProofExecution,
} from '../lib/frozen-proof-checkout.mts';

const execFileAsync = promisify(execFile);
const repo = fileURLToPath(new URL('../../../', import.meta.url));
const frozenSource = ensureFrozenProofExecution(
  repo,
  'scripts/runner-validation/gateway/antigravity-worker-lifecycle.mts',
  process.argv[2],
);
const { sourceSha, sourceTreeSha, trackedWorkingTreeClean } = frozenSource;
const baseOutput = path.resolve(process.argv[2] ?? '/tmp/antigravity-worker-proof');
const { attemptId, outputDir: output } = await createAttemptOutputDir(baseOutput, sourceSha);
const root = await realpath(await mkdtemp(path.join(tmpdir(), 'antigravity-worker-proof-')));

for (const directory of [
  'services/gateway',
  'pool',
  'projects/agy-proof/templates/worker',
  'projects/agy-proof/templates/prompts',
  'repo',
]) {
  await mkdir(path.join(root, directory), { recursive: true });
}
await symlink(path.join(repo, 'scripts'), path.join(root, 'scripts'));
await symlink(path.join(repo, 'packages'), path.join(root, 'packages'));
await symlink(path.join(repo, 'node_modules'), path.join(root, 'node_modules'));

// Build a minimal isolated CLI distribution (matching task-runtime.test-support.ts) so
// hosted task-init pins our checkout-local CLI in <1s without invoking global ~/.local/bin/farmslot.
const cliDistribution = path.join(root, 'installation');
const distCli = path.join(cliDistribution, 'packages/cli');
await mkdir(distCli, { recursive: true });
await writeFile(path.join(cliDistribution, 'yarn.lock'), '');
await writeFile(path.join(cliDistribution, 'DEPLOYED-REVISION.json'), '{}');
await mkdir(path.join(cliDistribution, 'packages/agent-runtime'), { recursive: true });
await copyFile(
  path.join(repo, 'packages/agent-runtime/package.json'),
  path.join(cliDistribution, 'packages/agent-runtime/package.json'),
);
for (const subdir of ['src', 'scripts', 'bin']) {
  await cp(
    path.join(repo, 'packages/agent-runtime', subdir),
    path.join(cliDistribution, 'packages/agent-runtime', subdir),
    { recursive: true, filter: (file) => !file.endsWith('.test.ts') },
  );
}
await cp(path.join(repo, 'packages/cli/src'), path.join(distCli, 'src'), {
  recursive: true,
  filter: (file) => !file.endsWith('.test.ts'),
});
await cp(path.join(repo, 'packages/cli/bin'), path.join(distCli, 'bin'), { recursive: true });
await writeFile(
  path.join(distCli, 'package.json'),
  JSON.stringify({ name: '@farmslot/cli', version: '1.0.0', type: 'module' }),
);
const distCliTsconfig = JSON.parse(
  await readFile(path.join(repo, 'packages/cli/tsconfig.json'), 'utf8'),
) as { extends?: string; compilerOptions: { paths: Record<string, string[]> } };
distCliTsconfig.extends = path.join(repo, 'apps/command-center/tsconfig.base.json');
for (const key of Object.keys(distCliTsconfig.compilerOptions.paths)) {
  distCliTsconfig.compilerOptions.paths[key] = distCliTsconfig.compilerOptions.paths[key].map(
    (entry) => path.resolve(repo, 'packages/cli', entry),
  );
}
distCliTsconfig.compilerOptions.paths['@farmslot/agent-runtime'] = [
  path.join(cliDistribution, 'packages/agent-runtime/src/index.ts'),
];
distCliTsconfig.compilerOptions.paths['@farmslot/agent-runtime/*'] = [
  path.join(cliDistribution, 'packages/agent-runtime/src/*'),
];
await writeFile(path.join(distCli, 'tsconfig.json'), JSON.stringify(distCliTsconfig));
const isolatedFarmslotCli = path.join(distCli, 'bin/farmslot.mjs');
const workRepo = path.join(root, 'repo');
const git = (...args: string[]) =>
  execFileSync('git', ['-C', workRepo, ...args], { encoding: 'utf8' }).trim();
git('init', '-q', '-b', 'main');
await writeFile(path.join(workRepo, 'README.md'), '# Isolated Antigravity Worker Proof\n');
git('add', '.');
git(
  '-c',
  'user.name=Proof',
  '-c',
  'user.email=proof@localhost',
  '-c',
  'commit.gpgsign=false',
  'commit',
  '-qm',
  'seed isolated proof repo',
);

const slotId = 'macwork-agy-proof-1';
const project = 'agy-proof';
await writeFile(path.join(root, 'CLAUDE.md'), '# Isolated Antigravity proof\n');
await writeFile(path.join(root, 'services/gateway/package.json'), '{}');
await writeFile(
  path.join(root, 'projects', project, 'templates/worker/dev.md'),
  '# Isolated Antigravity proof worker task\n\n- [ ] Proof step\n',
);
await writeFile(
  path.join(root, 'projects', project, 'templates/prompts/worker-dispatch.md'),
  'Read {{TASK_FILE}} and follow its instructions.\n',
);
await writeFile(
  path.join(root, 'projects', project, 'templates/prompts/worker-nudge.md'),
  'Read {{TASK_FILE}} and follow its instructions.\n',
);
await writeFile(
  path.join(root, 'projects', project, 'project.json'),
  JSON.stringify({
    name: project,
    task_dir: 'tasks',
    execution_templates: { sources: [] },
    hooks: {},
    review: { enabled: false },
  }),
);
await writeFile(
  path.join(root, 'pool/macwork.json'),
  JSON.stringify({
    machine: 'macwork',
    project,
    host: 'localhost',
    ssh_user: process.env.USER || 'operator',
    os: process.platform,
    platform: 'cli',
    slots: [{ id: slotId, enabled: true, mode: 'dispatch', repo: workRepo, session: slotId }],
  }),
);
await writeFile(
  path.join(root, 'status.json'),
  JSON.stringify({
    checkedAt: new Date().toISOString(),
    slots: [
      {
        slot: slotId,
        machine: 'macwork',
        project,
        platform: 'cli',
        lifecycle: 'ready',
        slot_epoch: 1,
        current_run_id: null,
      },
    ],
    summary: {
      total: 1,
      ready: 1,
      busy: 0,
      held: 0,
      manual: 0,
      disabled: 0,
      blocked: 0,
      warmCount: 0,
    },
  }),
);

Object.assign(process.env, {
  NODE_TEST_CONTEXT: '1',
  FARMSLOT_ROOT: root,
  FARMSLOT_CLI: isolatedFarmslotCli,
  FARMSLOT_HOME: path.join(root, 'home'),
  FARMSLOT_POOL_DIR: path.join(root, 'pool'),
  FARMSLOT_PROJECTS_DIR: path.join(root, 'projects'),
  FARMSLOT_NATIVE_STATE_DIR: path.join(root, 'native'),
  FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID: '',
  FARMSLOT_DISABLE_ORCHESTRATION: '1',
  FARMSLOT_DISABLE_RUN_ENGINE_START: '1',
  FARMSLOT_RUNS_DIR: path.join(root, 'runs'),
  FARMSLOT_TEST_STATUS_FILE: path.join(root, 'status.json'),
  FARMSLOT_OPERATOR_CHECKOUT: workRepo,
});

const { createGatewayAuthRuntime } = await import('../../../services/gateway/src/security/auth.js');
const { createWebSocketServer, initServerGlobals, resetServerGlobalsForTests } =
  await import('../../../services/gateway/src/server.js');
const { GatewayClient } = await import('../../../packages/cli/src/gateway-client.js');
const { saveProfiles } = await import('../../../packages/cli/src/gateway-profiles.js');
const { NativeSessionClient } =
  await import('../../../packages/agent-runtime/src/native/client.js');
const { antigravityNativeAdapter, observeAntigravityAccount } =
  await import('../../../packages/agent-runtime/src/native/antigravity.js');
const { runnerModelNodeBlocker } =
  await import('../../../services/gateway/src/runners/registry.js');

const auth = createGatewayAuthRuntime({ FARMSLOT_HOME: process.env.FARMSLOT_HOME });
const roles = [{ role: 'admin' as const, scope: { kind: 'global' as const } }];
const owner = auth.writer.createPrincipal(
  { type: 'service', displayName: 'Proof executor' },
  roles,
  'proof-executor',
);
const ownerCred = auth.writer.issueCredential(owner.id, 'Proof CLI executor');
const person = auth.writer.createPrincipal(
  { type: 'person', displayName: 'Proof operator' },
  roles,
  'proof-operator',
);
const personCred = auth.writer.issueCredential(person.id, 'Proof CLI');
const grant = await auth.writer.exchangePersonCredential(personCred.secret, {
  deviceName: 'Antigravity worker proof',
  deviceKind: 'cli',
});
process.env.FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID = owner.id;

// Finding 7: Register native-host supervisor cleanup before warming.
const nativeStateDir = path.join(root, 'native');
const killSupervisorSync = () => {
  const lock = path.join(nativeStateDir, 'lock/owner.json');
  if (fs.existsSync(lock)) {
    try {
      const supervisor = JSON.parse(fs.readFileSync(lock, 'utf8')) as { pid: number };
      process.kill(supervisor.pid, 'SIGTERM');
    } catch {
      // Best-effort process kill on signal/exit
    }
  }
};
process.on('SIGINT', killSupervisorSync);
process.on('SIGTERM', killSupervisorSync);
process.on('exit', killSupervisorSync);

const result: Record<string, unknown> = {
  pass: false,
  root,
  gatewayUrl: '',
  checks: {},
};
const checks = result.checks as Record<string, unknown>;
const cleanupWorkers: Array<{ sessionId: string; generation: string; leaseId: string }> = [];
const cleanupRuns: string[] = [];

let server: import('node:http').Server | undefined;
let wss: import('ws').WebSocketServer | undefined;
let conn: import('../../../packages/cli/src/gateway-client.js').GatewayClient | undefined;
let privateNative:
  | import('../../../packages/agent-runtime/src/native/client.js').NativeSessionClient
  | undefined;

const until = async <T,>(
  read: () => Promise<T>,
  check: (value: T) => boolean,
  label: string,
  timeoutMs = 120_000,
  intervalMs = 150,
): Promise<T> => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (check(value)) return value;
    assert(Date.now() < deadline, `Timed out: ${label}`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
};

try {
  // ─── Finding 7: Prove startup failure leaves no owned supervisor ───
  const failRoot = await mkdtemp(path.join(tmpdir(), 'agy-supervisor-fail-'));
  try {
    const marker = path.join(failRoot, 'fail-lstart');
    await writeFile(
      path.join(failRoot, 'ps'),
      `#!/bin/sh\ncase "$*" in *lstart=*) if [ -f '${marker}' ]; then rm -f '${marker}'; exit 1; fi;; esac\nexec /bin/ps "$@"\n`,
      { mode: 0o700 },
    );
    await writeFile(marker, '');
    const supervisorEntry = fileURLToPath(
      new URL('../../../packages/agent-runtime/src/native/supervisor.ts', import.meta.url),
    );
    const failedProc = execFileSync(
      process.execPath,
      ['--import', import.meta.resolve('tsx'), supervisorEntry, failRoot],
      {
        encoding: 'utf8',
        env: { ...process.env, PATH: `${failRoot}:${process.env.PATH}` },
        timeout: 15_000,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    assert.fail(`Expected supervisor startup to fail, got output: ${failedProc}`);
  } catch (err) {
    const status = (err as { status?: number }).status;
    assert(status !== undefined && status !== 0, 'Supervisor must exit non-zero on failure');
    const lockRemaining = fs.existsSync(path.join(failRoot, 'lock'));
    assert.equal(lockRemaining, false, 'Failed supervisor startup must leave no lock directory');
  } finally {
    await rm(failRoot, { recursive: true, force: true });
  }
  checks.startupFailureLeavesNoSupervisor = {
    verified: true,
    noLockRemaining: true,
  };

  privateNative = new NativeSessionClient(nativeStateDir);
  await privateNative.warm();

  server = createServer();
  wss = createWebSocketServer(server, auth);
  initServerGlobals();
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address !== 'string');
  const gatewayUrl = `ws://127.0.0.1:${address.port}/ws`;
  result.gatewayUrl = gatewayUrl;

  conn = await new GatewayClient({
    url: gatewayUrl,
    credential: { token: grant.accessToken },
    timeout: 60_000,
  }).connect();

  // ─── AC1a: Shared catalog on macwork exposes stable model IDs & display names ───
  const catalog = await conn.call<RunnerModelCatalogResult>('runner.modelCatalog', {
    runner: 'antigravity',
  });
  assert.equal(catalog.runner, 'antigravity');
  assert.equal(catalog.status, 'ready', `Expected ready catalog, got ${JSON.stringify(catalog)}`);
  assert.equal(catalog.source, 'catalog-command');
  assert(catalog.models.length >= 2, 'Expected multiple Antigravity models');
  for (const model of catalog.models) {
    assert(model.id.trim().length > 0, 'Model id must be non-empty');
    assert(
      typeof model.label === 'string' && model.label.trim().length > 0,
      `Model ${model.id} must expose a display name`,
    );
  }
  const nonDefaultModel = 'gemini-3.8-flash-low';
  const selectedEntry = catalog.models.find((m) => m.id === nonDefaultModel);
  assert(selectedEntry, `Expected non-default model ${nonDefaultModel} in catalog`);
  assert.equal(selectedEntry.label, 'Gemini 3.8 Flash (Low)');

  const nativeCatalog = await conn.call<NativeSessionCatalogResult>('native.session.catalog', {});
  const agyRunner = nativeCatalog.runners.find((r) => r.runner === 'antigravity');
  assert(agyRunner, 'antigravity must appear in native.session.catalog');
  assert.equal(agyRunner.nativeOnly, true);
  assert.equal(agyRunner.supportsWorkers, true);
  assert.deepEqual(agyRunner.modes, ['default', 'plan']);
  assert.equal(agyRunner.efforts, undefined);
  assert(agyRunner.nodeModels?.local?.includes(nonDefaultModel));
  assert.equal(agyRunner.modelLabels?.[nonDefaultModel], 'Gemini 3.8 Flash (Low)');

  checks.catalog = {
    count: catalog.models.length,
    nonDefaultModel,
    nonDefaultLabel: selectedEntry.label,
    nativeOnly: agyRunner.nativeOnly,
    modes: agyRunner.modes,
  };
  await writeFile(
    path.join(output, 'catalog.json'),
    JSON.stringify({ catalog, nativeCatalog }, null, 2),
  );

  // ─── AC1b: CLI dispatch accepts same runner/model pair (and agy alias), refuses tmux ───
  saveProfiles({
    active: 'proof',
    gateways: {
      proof: {
        url: gatewayUrl,
        authMode: 'token',
        secret: ownerCred.secret,
      },
    },
  });
  const runCli = async (args: string[]) =>
    execFileAsync(
      process.execPath,
      ['--import', 'tsx', path.join(repo, 'packages/cli/src/entry.ts'), ...args],
      { cwd: repo, env: process.env, timeout: 30_000 },
    );

  const makeCliTask = async (slug: string) => {
    const dir = path.join(root, 'projects', project, 'tasks', 'dev', slug);
    await mkdir(dir, { recursive: true });
    const taskFile = path.join(dir, 'TASK.md');
    await writeFile(taskFile, `# Isolated CLI proof ${slug}\n`);
    await writeFile(path.join(dir, 'CHECKLIST.md'), '# Checklist\n1. Proof step\n');
    return taskFile;
  };
  const cliTask1 = await makeCliTask('agy-cli-101');
  const cliTask2 = await makeCliTask('agy-cli-102');
  const cliTask3 = await makeCliTask('agy-cli-103');

  const cliOut = await runCli([
    '--url',
    gatewayUrl,
    'run',
    'create',
    '--project',
    project,
    '--task',
    cliTask1,
    '--flow-type',
    'dev',
    '--mode',
    'interactive',
    '--runner',
    'antigravity',
    '--model',
    nonDefaultModel,
    '--slot',
    slotId,
    '--skip-prepare',
    '--json',
  ]);
  const cliParsed = JSON.parse(cliOut.stdout) as { status: string; data: { run: Run } };
  assert.equal(cliParsed.status, 'ok');
  const cliRun = cliParsed.data.run;
  assert.equal(cliRun.metrics.runner, 'antigravity');
  assert.equal(cliRun.metrics.model, nonDefaultModel);
  assert.equal(cliRun.transport, 'native');
  await conn.call('run.cancel', { runId: cliRun.id, reason: 'CLI admission proof complete' });
  await conn.call('run.archive', { runId: cliRun.id });

  const cliAliasOut = await runCli([
    '--url',
    gatewayUrl,
    'run',
    'create',
    '--project',
    project,
    '--task',
    cliTask2,
    '--flow-type',
    'dev',
    '--mode',
    'interactive',
    '--runner',
    'agy',
    '--model',
    nonDefaultModel,
    '--slot',
    slotId,
    '--skip-prepare',
    '--json',
  ]);
  const cliAliasParsed = JSON.parse(cliAliasOut.stdout) as { status: string; data: { run: Run } };
  assert.equal(cliAliasParsed.status, 'ok');
  assert.equal(cliAliasParsed.data.run.metrics.runner, 'antigravity');
  assert.equal(cliAliasParsed.data.run.metrics.model, nonDefaultModel);
  assert.equal(cliAliasParsed.data.run.transport, 'native');
  await conn.call('run.cancel', {
    runId: cliAliasParsed.data.run.id,
    reason: 'CLI alias proof complete',
  });
  await conn.call('run.archive', { runId: cliAliasParsed.data.run.id });

  let tmuxErrorText = '';
  try {
    await runCli([
      '--url',
      gatewayUrl,
      'run',
      'create',
      '--project',
      project,
      '--task',
      cliTask3,
      '--flow-type',
      'dev',
      '--mode',
      'interactive',
      '--runner',
      'antigravity',
      '--model',
      nonDefaultModel,
      '--transport',
      'tmux',
      '--slot',
      slotId,
      '--skip-prepare',
      '--json',
    ]);
    assert.fail('Expected --transport tmux to fail for native-only Antigravity');
  } catch (err) {
    const failed = err as { stdout?: string; stderr?: string; message?: string };
    tmuxErrorText = `${failed.stdout ?? ''}\n${failed.stderr ?? ''}\n${failed.message ?? ''}`;
    assert.match(tmuxErrorText, /requires native transport/);
  }
  checks.cliDispatch = {
    runId: cliRun.id,
    runner: cliRun.metrics.runner,
    model: cliRun.metrics.model,
    transport: cliRun.transport,
    aliasAccepted: true,
    tmuxRefused: true,
  };

  // ─── AC1c + AC2a: Real Antigravity worker confirms selected model, accepts prompt, reports progress, completes ───
  const lease1 = crypto.randomUUID();
  const workerLaunch1 = {
    leaseId: lease1,
    safetyTier: 'full-auto' as const,
    environment: { set: {}, unset: [] },
  };
  const worker1 = await privateNative.ensureWorker(
    owner.id,
    {
      sessionId: crypto.randomUUID(),
      runner: 'antigravity',
      model: nonDefaultModel,
      cwd: workRepo,
      executionNodeId: 'local',
      mode: 'default',
    },
    workerLaunch1,
  );
  const target1 = { sessionId: worker1.id, generation: worker1.generation, leaseId: lease1 };
  cleanupWorkers.push(target1);
  assert.equal(worker1.model, nonDefaultModel);
  assert(worker1.nativeSessionId.length > 0, 'Worker must expose nativeSessionId');

  const initialRead = await privateNative.readWorker(owner.id, worker1.id, lease1);
  const startedEvent = initialRead.events.find((e) => e.type === 'session.started');
  assert.equal(
    startedEvent?.data?.model,
    nonDefaultModel,
    'session.started must confirm selected model reached agy',
  );

  const cmd1 = crypto.randomUUID();
  const token = `AGY_WORKER_TOKEN_${process.pid}`;
  const proofFile = path.join(workRepo, 'worker-proof.txt');
  await privateNative.sendWorker(
    owner.id,
    target1,
    cmd1,
    `Use your file-writing tool to create the file ${proofFile} containing exactly ${token} and then reply with WORKER_DONE.`,
  );
  const completed1 = await until(
    () => privateNative.readWorker(owner.id, worker1.id, lease1, undefined, 500),
    (snap) => snap.events.some((e) => e.commandId === cmd1 && e.type === 'turn.completed'),
    'worker1 turn completion',
  );
  const receipt1 = completed1.commands.find((c) => c.commandId === cmd1);
  assert.equal(receipt1?.accepted, true, 'Prompt acceptance must be confirmed');
  assert.equal(receipt1?.state, 'completed');
  assert.equal(receipt1?.outcome, 'completed');
  assert(completed1.events.some((e) => e.commandId === cmd1 && e.type === 'command.accepted'));
  assert(completed1.events.some((e) => e.commandId === cmd1 && e.type === 'turn.started'));
  assert(
    completed1.events.some((e) => e.commandId === cmd1 && e.type === 'tool.completed'),
    'Progress must include structured tool completion',
  );
  assert(
    completed1.events.some((e) => e.commandId === cmd1 && e.type === 'text.delta'),
    'Progress must include streamed text',
  );
  assert(
    completed1.events.some(
      (e) => e.commandId === cmd1 && e.type === 'turn.completed' && e.status === 'completed',
    ),
  );
  assert.equal((await readFile(proofFile, 'utf8')).trim(), token);
  await writeFile(path.join(output, 'worker1-receipt.json'), JSON.stringify(completed1, null, 2));

  checks.workerExecution = {
    sessionId: worker1.id,
    nativeSessionId: worker1.nativeSessionId,
    confirmedModel: startedEvent?.data?.model,
    commandAccepted: receipt1?.accepted,
    toolCompleted: true,
    turnCompleted: true,
    fileWritten: true,
  };

  // ─── AC2c: Retained handoff delivers follow-up to original session ID without duplicate send ───
  const lease2 = crypto.randomUUID();
  const workerLaunch2 = {
    leaseId: lease2,
    safetyTier: 'full-auto' as const,
    environment: { set: {}, unset: [] },
  };
  const transferred = await privateNative.transferWorker(owner.id, target1, workerLaunch2);
  assert.equal(transferred.nativeSessionId, worker1.nativeSessionId);
  assert.equal(transferred.workerLeaseId, lease2);

  // Close live process and resume from saved conversation to prove exact session/load handoff
  const target2 = { sessionId: worker1.id, generation: transferred.generation, leaseId: lease2 };
  await privateNative.closeWorker(owner.id, target2);
  const resumeCommandId = crypto.randomUUID();
  assert(worker1.nativeSessionId, 'Initial worker must record nativeSessionId before handoff');
  const resumed = await privateNative.resumeWorker(
    owner.id,
    {
      sessionId: worker1.id,
      runner: 'antigravity',
      model: nonDefaultModel,
      cwd: workRepo,
      executionNodeId: 'local',
      mode: 'default',
      resumeSessionId: worker1.nativeSessionId,
      generation: transferred.generation,
      commandId: resumeCommandId,
    },
    workerLaunch2,
  );
  const target2Resumed = { sessionId: resumed.id, generation: resumed.generation, leaseId: lease2 };
  cleanupWorkers[0] = target2Resumed;
  assert.equal(
    resumed.nativeSessionId,
    worker1.nativeSessionId,
    'Retained handoff must preserve original nativeSessionId',
  );
  assert.equal(resumed.id, worker1.id, 'Retained handoff must preserve worker sessionId');
  assert.notEqual(
    resumed.generation,
    worker1.generation,
    'Resumed handoff must start a fresh process generation',
  );

  const cmd2 = crypto.randomUUID();
  const followupText =
    'What exact token did you write into worker-proof.txt earlier? Reply with the token only, without using tools.';
  const sendFirst = await privateNative.sendWorker(owner.id, target2Resumed, cmd2, followupText);
  // Immediately replay the identical commandId to prove durable deduplication (no duplicate send!)
  const sendDuplicate = await privateNative.sendWorker(
    owner.id,
    target2Resumed,
    cmd2,
    followupText,
  );
  assert.equal(sendFirst.commandId, cmd2);
  assert.equal(sendDuplicate.commandId, cmd2);

  const completed2 = await until(
    () => privateNative.readWorker(owner.id, resumed.id, lease2, undefined, 500),
    (snap) => snap.events.some((e) => e.commandId === cmd2 && e.type === 'turn.completed'),
    'retained handoff follow-up completion',
  );
  const submittedForCmd2 = completed2.events.filter(
    (e) => e.type === 'command.submitted' && e.commandId === cmd2,
  );
  assert.equal(
    submittedForCmd2.length,
    1,
    'Duplicate send must NOT create a second command.submitted',
  );
  const followupReply = completed2.events
    .filter((e) => e.commandId === cmd2 && e.type === 'text.delta')
    .map((e) => e.text ?? '')
    .join('');
  assert(
    followupReply.includes(token),
    `Expected retained context token ${token} in follow-up reply, got: ${followupReply}`,
  );
  await privateNative.closeWorker(owner.id, target2Resumed);
  cleanupWorkers.pop();
  const afterClose = await privateNative.readWorker(owner.id, resumed.id, lease2);
  assert.equal(afterClose.session.processStopped, true);
  await writeFile(path.join(output, 'handoff-receipt.json'), JSON.stringify(completed2, null, 2));

  checks.retainedHandoff = {
    originalNativeSessionId: worker1.nativeSessionId,
    resumedNativeSessionId: resumed.nativeSessionId,
    sameNativeSessionId: resumed.nativeSessionId === worker1.nativeSessionId,
    submittedCountForReplayedCommandId: submittedForCmd2.length,
    retainedTokenConfirmed: true,
  };

  // ─── AC2b: Separate run proves cancellation ───
  const leaseCancel = crypto.randomUUID();
  const workerCancel = await privateNative.ensureWorker(
    owner.id,
    {
      sessionId: crypto.randomUUID(),
      runner: 'antigravity',
      model: nonDefaultModel,
      cwd: workRepo,
      executionNodeId: 'local',
      mode: 'default',
    },
    { leaseId: leaseCancel, safetyTier: 'full-auto', environment: { set: {}, unset: [] } },
  );
  const targetCancel = {
    sessionId: workerCancel.id,
    generation: workerCancel.generation,
    leaseId: leaseCancel,
  };
  cleanupWorkers.push(targetCancel);
  const cmdCancel = crypto.randomUUID();
  await privateNative.sendWorker(
    owner.id,
    targetCancel,
    cmdCancel,
    'Write a detailed 2000-word essay explaining the history of distributed consensus algorithms. Do not use any tools.',
  );
  await until(
    () => privateNative.readWorker(owner.id, workerCancel.id, leaseCancel, undefined, 500),
    (snap) =>
      snap.events.some(
        (e) =>
          e.commandId === cmdCancel && (e.type === 'text.delta' || e.type === 'command.accepted'),
      ),
    'cancel worker active turn',
  );
  const cancelled = await privateNative.cancelWorker(owner.id, targetCancel);
  cleanupWorkers.pop();
  assert.equal(cancelled.cancelled, true, 'Cancellation must be confirmed');
  assert.equal(cancelled.session?.processStopped, true, 'Cancelled worker process must be stopped');
  assert(['closed', 'failed'].includes(cancelled.session?.state ?? ''));
  if (workerCancel.processPid) {
    let alive = true;
    try {
      process.kill(workerCancel.processPid, 0);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ESRCH') alive = false;
    }
    assert.equal(alive, false, 'Cancelled worker OS process must not remain alive');
  }
  await writeFile(path.join(output, 'cancel-receipt.json'), JSON.stringify(cancelled, null, 2));

  checks.cancellation = {
    sessionId: workerCancel.id,
    cancelled: cancelled.cancelled,
    state: cancelled.session?.state,
    processStopped: cancelled.session?.processStopped,
  };

  checks.acpBoundaryEvidence = {
    workerExecution: checks.workerExecution,
    retainedHandoff: checks.retainedHandoff,
    cancellation: checks.cancellation,
  };

  // ─── Finding 6: Real Gateway Run Dispatch, Retained Handoff, and Cancellation ───
  delete process.env.FARMSLOT_DISABLE_RUN_ENGINE_START;
  process.env.FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID = person.id;

  const findPrimaryContext = (r: Run) =>
    r.agentContexts?.find((c) => c.role === 'dev' || c.role === 'primary');

  const gwTask1 = await makeCliTask('agy-gw-smoke-1');
  await writeFile(
    gwTask1,
    `# Isolated Gateway Proof agy-gw-smoke-1\n\nReply with GATEWAY_RUN_1_READY and stop. Do not run shell commands or edit files.\n`,
  );
  const gwCreate1 = await conn.call<{ run: Run }>('run.create', {
    project,
    taskFile: gwTask1,
    ticketOrPr: 'AGY-GW-1',
    flowType: 'dev',
    mode: 'interactive',
    safetyTier: 'full-auto',
    runner: 'antigravity',
    model: nonDefaultModel,
    slotId,
    skipPrepare: true,
  });
  const gwRun1 = gwCreate1.run;
  cleanupRuns.push(gwRun1.id);
  assert.equal(gwRun1.transport, 'native');
  assert.equal(gwRun1.metrics.runner, 'antigravity');
  assert.equal(gwRun1.metrics.model, nonDefaultModel);

  const gwRun1Active = await until(
    async () => (await conn.call<{ run: Run }>('run.get', { runId: gwRun1.id })).run,
    (r) => {
      if (
        r.status === 'failed' ||
        r.status === 'blocked' ||
        r.status === 'reconciling' ||
        r.status === 'cancelled'
      ) {
        throw new Error(
          `Gateway run 1 entered unexpected state ${r.status}: ${r.error ?? JSON.stringify(r.steps.find((s) => s.status === 'failed'))}`,
        );
      }
      const primary = findPrimaryContext(r);
      return Boolean(primary?.nativeSession?.sessionId && primary?.nativeSession?.acceptedAt);
    },
    'gateway run 1 native dispatch acceptance',
    150_000,
    1_000,
  );
  const gwRun1Primary = findPrimaryContext(gwRun1Active);
  assert(
    gwRun1Primary?.nativeSession?.sessionId,
    'Gateway run 1 must record active native session',
  );
  assert(gwRun1Primary?.nativeSession?.acceptedAt, 'Gateway run 1 must record prompt acceptedAt');
  const gwRun1NativeSessionId = gwRun1Primary.runnerSessionId;
  assert(gwRun1NativeSessionId, 'Gateway run 1 must record runnerSessionId');

  // Wait for run 1's native turn to settle before handing the warm session to run 2
  await until(
    async () =>
      privateNative!.readWorker(
        person.id,
        gwRun1Primary.nativeSession!.sessionId,
        gwRun1Primary.nativeSession!.leaseId,
        undefined,
        200,
      ),
    (snap) =>
      snap.events.some(
        (e) =>
          e.commandId === gwRun1Primary.nativeSession!.commandId && e.type === 'turn.completed',
      ),
    'gateway run 1 initial turn completion',
    90_000,
  );

  const gwTask2 = await makeCliTask('agy-gw-smoke-2');
  await writeFile(
    gwTask2,
    `# Isolated Gateway Proof agy-gw-smoke-2\n\nWrite a detailed 2000-word essay explaining the history of distributed consensus algorithms. Do not use any tools.\n`,
  );
  const gwCreate2 = await conn.call<{ run: Run }>('run.create', {
    project,
    taskFile: gwTask2,
    ticketOrPr: 'AGY-GW-2',
    flowType: 'dev',
    mode: 'interactive',
    safetyTier: 'full-auto',
    runner: 'antigravity',
    model: nonDefaultModel,
    slotId,
    parentRunId: gwRun1.id,
    familyId: gwRun1.familyId,
    familyRootTicketOrPr: gwRun1.ticketOrPr,
    skipPrepare: true,
    engineState: {
      flags: {
        warmSessionReuse: true,
        skipPrepare: true,
      },
    },
  });
  const gwRun2 = gwCreate2.run;
  cleanupRuns.push(gwRun2.id);
  const gwRun2Active = await until(
    async () => (await conn.call<{ run: Run }>('run.get', { runId: gwRun2.id })).run,
    (r) => {
      if (
        r.status === 'failed' ||
        r.status === 'blocked' ||
        r.status === 'reconciling' ||
        r.status === 'cancelled'
      ) {
        throw new Error(
          `Gateway run 2 entered unexpected state ${r.status}: ${r.error ?? JSON.stringify(r.steps.find((s) => s.status === 'failed'))}`,
        );
      }
      const primary = findPrimaryContext(r);
      return Boolean(
        primary?.nativeSession?.sessionId &&
        primary?.nativeSession?.acceptedAt &&
        r.engineState?.flags?.warmHandoffSucceeded === true,
      );
    },
    'gateway run 2 retained handoff acceptance',
    150_000,
    1_000,
  );
  const gwRun2Primary = findPrimaryContext(gwRun2Active);
  assert(gwRun2Primary?.nativeSession?.sessionId, 'Gateway run 2 must record native session');
  assert.equal(
    gwRun2Active.engineState?.flags?.warmHandoffSucceeded,
    true,
    'Gateway run 2 must confirm warmHandoffSucceeded',
  );
  assert.equal(
    gwRun2Primary.nativeSession.sessionId,
    gwRun1Primary.nativeSession.sessionId,
    'Chained run retained handoff must reuse the parent native worker session ID',
  );
  assert.equal(
    gwRun2Primary?.runnerSessionId,
    gwRun1NativeSessionId,
    'Chained run retained handoff must preserve native conversation session ID',
  );

  const cancelGw2 = await conn.call<{ run: Run }>('run.cancel', {
    runId: gwRun2.id,
    reason: 'Gateway run lifecycle proof cancellation',
  });
  assert.equal(cancelGw2.run.status, 'cancelled');
  const afterGwCancel = await privateNative!.readWorker(
    person.id,
    gwRun2Primary.nativeSession.sessionId,
    gwRun2Primary.nativeSession.leaseId,
    undefined,
    200,
  );
  const gw2SubmittedCount = afterGwCancel.events.filter(
    (e) => e.type === 'command.submitted' && e.commandId === gwRun2Primary.nativeSession!.commandId,
  ).length;
  assert.equal(
    gw2SubmittedCount,
    1,
    'Gateway retained handoff must deliver follow-up exactly once',
  );
  assert.equal(
    afterGwCancel.session.processStopped,
    true,
    'Cancelling gateway run 2 must stop its underlying native worker process',
  );
  const gwRun1After = (await conn.call<{ run: Run }>('run.get', { runId: gwRun1.id })).run;
  if (!['cancelled', 'done', 'failed'].includes(gwRun1After.status)) {
    await conn.call('run.cancel', {
      runId: gwRun1.id,
      reason: 'Parent cleanup',
    });
  }
  await conn.call('run.archive', { runId: gwRun2.id });
  await conn.call('run.archive', { runId: gwRun1.id });
  cleanupRuns.length = 0;
  await writeFile(
    path.join(output, 'gateway-lifecycle-receipt.json'),
    JSON.stringify(
      { run1: gwRun1Active, run2: gwRun2Active, cancelledRun2: cancelGw2.run },
      null,
      2,
    ),
  );

  checks.gatewayRunLifecycle = {
    run1Id: gwRun1.id,
    run1Status: gwRun1Active.status,
    run1SessionId: gwRun1Primary.nativeSession.sessionId,
    run1NativeSessionId: gwRun1NativeSessionId,
    run2Id: gwRun2.id,
    run2Status: gwRun2Active.status,
    run2SessionId: gwRun2Primary.nativeSession.sessionId,
    run2NativeSessionId: gwRun2Primary?.runnerSessionId,
    warmHandoffSucceeded: gwRun2Active.engineState?.flags?.warmHandoffSucceeded === true,
    retainedSessionPreserved: gwRun2Primary?.runnerSessionId === gwRun1NativeSessionId,
    followUpSubmittedCount: gw2SubmittedCount,
    cancelled: cancelGw2.run.status === 'cancelled',
    cancelledProcessStopped: afterGwCancel.session.processStopped,
  };

  // Restore test flags for remaining checks
  process.env.FARMSLOT_DISABLE_RUN_ENGINE_START = '1';
  process.env.FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID = owner.id;

  // ─── AC4: Unavailability (missing install, signed-out login) & unavailable model error ───
  const missingObs = await observeAntigravityAccount({
    cwd: workRepo,
    executable: path.join(root, 'does-not-exist-agy'),
    env: { PATH: '' },
  });
  assert.equal(missingObs.installed, false);
  assert.equal(missingObs.login, 'unavailable');
  assert.equal(missingObs.reason, 'not-installed');

  const emptyHome = await mkdtemp(path.join(tmpdir(), 'agy-signedout-home-'));
  let signedOutObs;
  try {
    signedOutObs = await observeAntigravityAccount({
      cwd: workRepo,
      env: { ...process.env, HOME: emptyHome },
    });
  } finally {
    await rm(emptyHome, { recursive: true, force: true });
  }
  assert.equal(signedOutObs.installed, true);
  assert.equal(signedOutObs.login, 'signed-out');

  const badModel = 'gemini-unavailable-for-account-999';
  const catalogBlocker = runnerModelNodeBlocker('antigravity', badModel, 'macwork', 'native');
  assert.match(catalogBlocker ?? '', /not available for the macwork account/);

  let rpcBadModelError = '';
  await assert.rejects(
    conn.call('native.session.create', {
      runner: 'antigravity',
      model: badModel,
      cwd: workRepo,
      executionNodeId: 'local',
      mode: 'default',
      approvalMode: 'ask',
    }),
    (err: Error) => {
      rpcBadModelError = err.message;
      return /not available/i.test(err.message);
    },
  );

  let adapterBadModelError = '';
  const agyExe = execFileSync('which', ['agy'], { encoding: 'utf8' }).trim();
  await assert.rejects(
    antigravityNativeAdapter.start(
      { cwd: workRepo, executable: agyExe, model: badModel, mode: 'default', approvalMode: 'ask' },
      () => {},
    ),
    (err: Error) => {
      adapterBadModelError = err.message;
      return /not available for the selected account/i.test(err.message);
    },
  );

  checks.unavailabilityAndErrors = {
    missingInstall: { installed: missingObs.installed, reason: missingObs.reason },
    signedOut: { installed: signedOutObs.installed, login: signedOutObs.login },
    catalogBlocker,
    rpcBadModelError,
    adapterBadModelError,
  };

  result.pass = true;
} catch (error) {
  result.error = String(error);
  throw error;
} finally {
  for (const runId of [...cleanupRuns].reverse()) {
    try {
      await conn?.call('run.cancel', { runId, reason: 'Proof cleanup' });
    } catch {
      // Best-effort cleanup of test-owned runs on failure path.
    }
  }
  for (const target of cleanupWorkers) {
    try {
      await privateNative?.closeWorker(owner.id, target);
    } catch {
      // Best-effort cleanup of test-owned workers on failure path.
    }
  }
  conn?.close();
  resetServerGlobalsForTests();
  if (wss) {
    for (const socket of wss.clients) socket.terminate();
    await new Promise<void>((resolve) => wss!.close(() => resolve()));
  }
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
  }
  const lock = path.join(root, 'native/lock/owner.json');
  if (fs.existsSync(lock)) {
    const supervisor = JSON.parse(fs.readFileSync(lock, 'utf8')) as { pid: number };
    const host = JSON.parse(fs.readFileSync(path.join(root, 'native/worker.json'), 'utf8')) as {
      pid: number;
    };
    const gone = (pid: number) => {
      try {
        process.kill(pid, 0);
        return false;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ESRCH') return true;
        throw err;
      }
    };
    process.kill(supervisor.pid, 'SIGTERM');
    await until(
      async () =>
        !fs.existsSync(path.join(root, 'native/lock')) && gone(supervisor.pid) && gone(host.pid),
      Boolean,
      'private native host cleanup',
      30_000,
    );
  }
  result.hostStopped = !fs.existsSync(lock);
  frozenSource.verifyBeforeSeal();
  result.sourceSha = sourceSha;
  result.sourceTreeSha = sourceTreeSha;
  result.trackedWorkingTreeClean = trackedWorkingTreeClean;
  result.isolatedCheckoutVerifiedBeforeLaunch = true;
  result.isolatedCheckoutVerifiedBeforeSeal = true;
  result.isolatedModuleResolutionVerified = frozenSource.isolatedModuleResolutionVerified;
  result.resolvedModules = frozenSource.resolvedModules;
  result.attemptId = attemptId;
  result.outputDir = output;
  const hostLogPath = path.join(root, 'native/host.log');
  if (fs.existsSync(hostLogPath)) {
    await copyFile(hostLogPath, path.join(output, 'host.log'));
  }
  const manifestEntries = await buildProofManifest(output);
  result.manifest = manifestEntries;
  await writeFile(path.join(output, 'result.json'), JSON.stringify(result, null, 2) + '\n');
  await rm(root, { recursive: true, force: true });
  console.log(
    JSON.stringify(
      {
        pass: result.pass,
        sourceSha: result.sourceSha,
        sourceTreeSha: result.sourceTreeSha,
        trackedWorkingTreeClean: result.trackedWorkingTreeClean,
        isolatedCheckoutVerifiedBeforeLaunch: result.isolatedCheckoutVerifiedBeforeLaunch,
        isolatedCheckoutVerifiedBeforeSeal: result.isolatedCheckoutVerifiedBeforeSeal,
        isolatedModuleResolutionVerified: result.isolatedModuleResolutionVerified,
        resolvedModules: result.resolvedModules,
        attemptId: result.attemptId,
        outputDir: result.outputDir,
        hostStopped: result.hostStopped,
        manifest: manifestEntries,
        checks,
        error: result.error,
      },
      null,
      2,
    ),
  );
}
