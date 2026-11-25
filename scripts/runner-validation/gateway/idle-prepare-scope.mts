// Live proof with disposable farm roots and an isolated tmux server: a real run-less prepare
// scope (the prepare wrapper's keep-alive window, its nohup'd holder and a provider child) on
// a ready slot with no run is timed on the slot row, kept while a run owns the slot, then
// stopped by the idle sweep's scope pass once the window ends. A foreign process started
// beside it survives. Only processes this proof started are signalled at cleanup.
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const scratch = await mkdtemp(path.join(os.tmpdir(), 'idle-prepare-scope-'));
const socketDir = await mkdtemp('/tmp/ips-');
const slotId = `idle-scope-${process.pid}`;
const project = `idle-scope-project-${process.pid}`;
const repo = path.join(scratch, 'slot');
const runtimeDir = '.agent';
const identityPath = path.join(repo, runtimeDir, 'preflight.identity');
const token = Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join(
  '',
);

// Every farm path and tmux call in this process stays inside the proof's own roots.
for (const [key, value] of Object.entries({
  FARMSLOT_ROOT: path.join(scratch, 'root'),
  FARMSLOT_HOME: path.join(scratch, 'home'),
  FARMSLOT_POOL_DIR: path.join(scratch, 'root', 'pool'),
  FARMSLOT_PROJECTS_DIR: path.join(scratch, 'root', 'projects'),
  FARMSLOT_RUNS_DIR: path.join(scratch, 'root', '.runs'),
  FARMSLOT_CAPABILITY_STORE_FILE: path.join(scratch, 'root', '.runs', 'capabilities.json'),
  FARMSLOT_DEMO_POOL: '0',
  // The slot row lives in this proof's own status store, never the shared fleet file.
  NODE_TEST_CONTEXT: '1',
  FARMSLOT_TEST_STATUS_FILE: path.join(scratch, 'status.json'),
  TMUX_TMPDIR: socketDir,
  TMUX: '',
}))
  process.env[key] = value;
delete process.env.TMUX_PANE;
// The proof's own tmux server: the socket the gateway code reaches through TMUX_TMPDIR.
const socket = path.join(socketDir, `tmux-${process.getuid?.() ?? 0}`, 'default');
const tmux = (...args: string[]) => execute('tmux', ['-S', socket, ...args]);

const started: number[] = [];
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // ESRCH: gone. EPERM: it exists under another user, so it counts as alive.
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    if ((error as NodeJS.ErrnoException).code === 'EPERM') return true;
    throw error;
  }
};
const groupAlive = async (pgid: number) => {
  const { stdout } = await execute('ps', ['-A', '-o', 'pgid=,stat=']);
  return stdout
    .split('\n')
    .some(
      (line) =>
        line.trim().split(/\s+/)[0] === String(pgid) &&
        !/^Z/.test(line.trim().split(/\s+/)[1] ?? ''),
    );
};

let cleaning: Promise<void> | undefined;
/** Signal only the process groups this proof started, stop its own tmux server, remove files. */
function cleanup(): Promise<void> {
  cleaning ??= (async () => {
    // Every step runs; the first failure is reported once all of them have.
    const failures: unknown[] = [];
    for (const pid of started) {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch (error) {
        // ESRCH: the group is already gone, which the proof expects for the scope.
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') failures.push(error);
      }
    }
    if (existsSync(socket)) {
      try {
        await tmux('kill-server');
      } catch (error) {
        // A server that already exited leaves its socket behind; anything else fails cleanup.
        const stderr = String((error as { stderr?: unknown }).stderr ?? '');
        if (!/no server running|error connecting to/u.test(stderr)) failures.push(error);
      }
    }
    await rm(scratch, { recursive: true, force: true });
    await rm(socketDir, { recursive: true, force: true });
    if (failures.length) throw new AggregateError(failures, 'idle-prepare-scope cleanup failed');
  })();
  return cleaning;
}
/** Stop on a signal or the deadline: clean up, print any cleanup failure, then exit 1. */
function abort(reason: string): void {
  process.stderr.write(`${reason}\n`);
  cleanup().then(
    () => process.exit(1),
    (error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
      process.exit(1);
    },
  );
}
// A cancelled or timed-out recipe still stops what the proof started.
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.once(signal, () => abort(`idle-prepare-scope proof stopped by ${signal}`));
const deadline = setTimeout(() => abort('idle-prepare-scope proof timed out'), 50_000);
deadline.unref();

try {
  await mkdir(path.join(repo, runtimeDir), { recursive: true });
  await mkdir(path.join(scratch, 'root', 'pool'), { recursive: true });
  // A disposable Farmslot root, the shape the gateway's root check accepts.
  const root = path.join(scratch, 'root');
  await mkdir(path.join(root, 'scripts'), { recursive: true });
  await mkdir(path.join(root, 'services', 'gateway'), { recursive: true });
  await writeFile(path.join(root, 'CLAUDE.md'), '# Disposable idle prepare-scope fixture\n');
  await writeFile(path.join(root, 'scripts', 'dev.sh'), '#!/bin/sh\n');
  await writeFile(
    path.join(root, 'services', 'gateway', 'package.json'),
    JSON.stringify({ name: 'fixture', version: '0.0.0' }),
  );
  await execute('git', ['init', '-q'], { cwd: root });
  await mkdir(path.join(scratch, 'root', 'projects', project), { recursive: true });
  await mkdir(path.join(scratch, 'other'), { recursive: true });
  await writeFile(
    path.join(scratch, 'root', 'projects', project, 'project.json'),
    JSON.stringify({
      name: project,
      default_branch: 'main',
      paths: { runtime_dir: runtimeDir },
      // A dev server whose watch never answers here: its status is what the proof sets.
      resources: {
        server: {
          type: 'dev-server',
          label: 'Proof server',
          watch: { type: 'port-listen', port: '1' },
          hooks: { boot: 'true', health: 'false' },
        },
      },
    }),
  );
  await writeFile(
    path.join(scratch, 'root', 'pool', 'proof.json'),
    JSON.stringify({
      machine: os.hostname(),
      host: 'localhost',
      ssh_user: os.userInfo().username,
      os: process.platform,
      project,
      slots: [
        {
          id: slotId,
          repo,
          session: slotId,
          enabled: true,
          mode: 'dispatch',
          resources: { server: {} },
        },
      ],
    }),
  );
  // An unrelated tmux session: its pane is outside the slot and must not block the stop.
  await mkdir(path.dirname(socket), { recursive: true, mode: 0o700 });
  await tmux('new-session', '-d', '-s', 'proof-other', '-c', path.join(scratch, 'other'));

  const { claimSlotStatusIf, readSlotRow, updateSlotStatusIf } =
    await import('../../../services/gateway/src/core/state.js');
  const { buildPrepareWrappedCommand } =
    await import('../../../services/gateway/src/methods/slot/prepare-command.js');
  const { reapIdlePrepareScopes } =
    await import('../../../services/gateway/src/run-lifecycle/idle-devserver-service.js');
  const { DEVSERVER_IDLE_LIMIT_MS } =
    await import('../../../services/gateway/src/run-lifecycle/idle-devserver.js');
  const { rewriteStatusFile } = await import('../../../services/gateway/src/core/state.js');
  const { buildFleetRefreshSnapshot } =
    await import('../../../services/gateway/src/methods/fleet.js');
  const { setCachedResourceStatus } =
    await import('../../../services/gateway/src/fleet/resource-manager.js');
  const serverIs = (status: 'stopped' | 'unknown') =>
    setCachedResourceStatus(slotId, 'server', status, { broadcast: false });

  // The real prepare wrapper in keep-alive mode, with a provider child holding the scope.
  const scope = spawn(
    'bash',
    [
      '-c',
      buildPrepareWrappedCommand(
        'sleep 600 &',
        path.join(scratch, 'sentinel'),
        path.join(scratch, 'prep'),
        {
          cwd: repo,
          keepAliveOnSuccess: true,
          prepareScope: { token, identityPath },
        },
      ),
    ],
    { detached: true, stdio: 'ignore', env: process.env },
  );
  scope.unref();
  started.push(scope.pid!);
  const foreign = spawn('sleep', ['600'], { detached: true, stdio: 'ignore' });
  foreign.unref();
  started.push(foreign.pid!);
  for (let i = 0; !existsSync(identityPath) && i < 100; i++) await pause(100);
  const [pgid, sentinel, recorded] = (await readFile(identityPath, 'utf8')).trim().split('\t');
  assert.equal(recorded, token, 'the wrapper recorded this scope');
  assert.ok(await groupAlive(Number(pgid)), 'the scope runs');
  assert.ok(alive(Number(sentinel)), 'its holder runs');

  const fleetSlot = {
    slot: slotId,
    machine: os.hostname(),
    health: { ssh: 'LOCAL', device: '-', devserver: '-', cdp: '-', fixtures: '-' },
  };
  const ready = { lifecycle: 'ready', phase: null, agent: 'idle', slot_epoch: 1 };

  // Owned: the pass neither times nor stops the scope.
  await claimSlotStatusIf(slotId, () => true, { ...ready, current_run_id: 'proof-run' });
  await reapIdlePrepareScopes([fleetSlot]);
  assert.equal((await readSlotRow(slotId))?.idle_prepare_scope ?? null, null);
  assert.ok(await groupAlive(Number(pgid)), 'an owned slot keeps its scope');

  // Ownerless, dev server stopped: the first pass records the window on the slot row.
  await updateSlotStatusIf(slotId, () => true, { current_run_id: null });
  serverIs('stopped');
  await reapIdlePrepareScopes([fleetSlot]);
  const timed = await readSlotRow(slotId);
  const window = timed?.idle_prepare_scope;
  assert.ok(
    window && typeof window === 'object' && typeof Reflect.get(window, 'since') === 'number',
    'the window is on the slot row',
  );
  assert.ok(await groupAlive(Number(pgid)), 'inside the window the scope stays');

  // A full fleet refresh rebuilds the row from its field list: the window must survive it.
  await rewriteStatusFile((current) =>
    buildFleetRefreshSnapshot(
      current?.slots ?? [],
      [
        {
          slot: slotId,
          machine: os.hostname(),
          platform: 'cli',
          project,
          ssh: 'LOCAL',
          dev: '-',
          devserver: 'OFF',
          device: '-',
          cdp: '-',
          fixtures: '-',
          branch: 'main',
          agent: 'idle',
          enabled: true,
          mode: 'dispatch',
          dispatchable: true,
        },
      ],
      [],
      new Date().toISOString(),
    ),
  );
  assert.deepEqual((await readSlotRow(slotId))?.idle_prepare_scope, window, 'refresh keeps it');

  // The persisted window ended (as after a gateway restart)...
  await updateSlotStatusIf(slotId, () => true, {
    idle_prepare_scope: {
      scope: token,
      epoch: timed?.slot_epoch,
      since: Date.now() - DEVSERVER_IDLE_LIMIT_MS - 1,
    },
  });
  // ...but the dev server's status is not reported yet: no stop, and the window is kept.
  serverIs('unknown');
  await reapIdlePrepareScopes([fleetSlot]);
  assert.ok(await groupAlive(Number(pgid)), 'an unreported status stops nothing');
  assert.ok((await readSlotRow(slotId))?.idle_prepare_scope, 'and keeps the window');
  // Reported stopped: the next pass stops the scope.
  serverIs('stopped');
  await reapIdlePrepareScopes([fleetSlot]);
  for (let i = 0; (await groupAlive(Number(pgid))) && i < 50; i++) await pause(100);
  assert.equal(await groupAlive(Number(pgid)), false, 'the scope group is gone');
  assert.equal(alive(Number(sentinel)), false, 'its holder is gone');
  assert.equal(alive(foreign.pid!), true, 'the foreign process survives');
  const after = await readSlotRow(slotId);
  assert.equal(after?.lifecycle, 'ready', 'the upkeep fence is lifted');
  assert.equal(after?.phase, null);
  assert.equal(after?.idle_prepare_scope, null);
  console.log(
    JSON.stringify({
      ok: true,
      scope: token.slice(0, 8),
      pgid: Number(pgid),
      holder: Number(sentinel),
      foreign: foreign.pid,
    }),
  );
} finally {
  await cleanup();
}
