// Opt-in macOS proof. Owns a temporary APFS image, private gateway, identity and ports.
// Run: TSX_TSCONFIG_PATH=services/gateway/tsconfig.json node --import tsx scripts/runner-validation/storage-volume-smoke.mts <evidence-directory>
import assert from 'node:assert/strict';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { closeSync, existsSync, openSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { FleetStatus, GatewayDoctorResult } from '../../packages/protocol/src/index.js';
import { writeAtomicJSON } from '../../services/gateway/src/core/atomic-json.js';
import { GatewayClient } from '../../packages/cli/src/gateway-client.js';
import { testGatewayIdentity } from '../lib/test-gateway-identity-source.mjs';
import { freePort, linkCheckout, poll, stopProcess } from './lib/isolated-stack.mjs';

const waitFor = (description: string, timeout: number, read: () => Promise<boolean>) =>
  poll(description, async () => ((await read()) ? true : undefined), timeout);

assert.equal(process.platform, 'darwin', 'This opt-in proof needs macOS hdiutil');
const root = fileURLToPath(new URL('../../', import.meta.url));
const evidence = path.resolve(process.argv[2] ?? '/tmp/farmslot-storage-proof-evidence');
await mkdir(evidence, { recursive: true });
const scratch = await mkdtemp('/tmp/farmslot-storage-proof-');
const fixture = path.join(scratch, 'gateway');
const mount = `/Volumes/farmslot-storage-proof-${process.pid}`;
const image = path.join(scratch, 'proof.dmg');
const slotRepo = path.join(mount, 'slot');
const task = path.join(slotRepo, '.task/proof/TASK.md');
let gateway: ChildProcess | undefined;
let connection: Awaited<ReturnType<GatewayClient['connect']>> | undefined;
let attached = false;
const disk = (...args: string[]) =>
  execFileSync('hdiutil', args, { encoding: 'utf8', stdio: 'pipe' });
try {
  disk('create', '-size', '64m', '-fs', 'APFS', '-volname', path.basename(mount), image);
  disk('attach', '-nobrowse', '-mountpoint', mount, image);
  attached = true;
  await mkdir(path.dirname(task), { recursive: true });
  await writeFile(task, '# Storage proof\n\n- [ ] Preserve this task\n');
  await mkdir(path.join(mount, 'archive'));
  await linkCheckout(root, fixture, 'Storage volume smoke');
  for (const dir of ['home', 'runs', 'pool', 'projects/proof', 'bin', 'tmux'])
    await mkdir(path.join(fixture, dir), { recursive: true });
  for (const command of ['gh', 'ssh'])
    await writeFile(path.join(fixture, 'bin', command), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  await writeFile(
    path.join(fixture, 'pool/local.json'),
    JSON.stringify({
      schema_version: 2,
      machine: 'storage-proof',
      host: 'localhost',
      project: 'proof',
      platform: 'cli',
      os: 'darwin',
      slots: [{ id: 'storage-proof-1', repo: slotRepo, enabled: true }],
    }),
  );
  await writeFile(
    path.join(fixture, 'projects/proof/project.json'),
    JSON.stringify({
      name: 'proof',
      platform: 'cli',
      default_branch: 'main',
      repo_url: 'file:///unused',
    }),
  );
  await writeFile(
    path.join(fixture, '.farm-status.json'),
    JSON.stringify({
      checked_at: new Date().toISOString(),
      slots: [
        {
          slot: 'storage-proof-1',
          machine: 'storage-proof',
          project: 'proof',
          repo: slotRepo,
          task_file: 'proof',
          agent: 'working',
          lifecycle: 'ready',
          phase: null,
          enabled: true,
          dispatchable: true,
        },
      ],
    }),
  );
  const port = await freePort();
  const url = `ws://127.0.0.1:${port}`;
  const token = testGatewayIdentity(path.join(fixture, 'home'), url);
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env))
    if (!/^(FARMSLOT_|GATEWAY_|TMUX|TSX_|GH_|GITHUB_|NPM_)|_TOKEN$|_PAT$|_API_KEY/.test(key))
      env[key] = value;
  Object.assign(env, {
    PATH: `${fixture}/bin:${env.PATH}`,
    TMUX_TMPDIR: `${fixture}/tmux`,
    FARMSLOT_ROOT: fixture,
    FARMSLOT_HOME: `${fixture}/home`,
    FARMSLOT_RUNS_DIR: `${fixture}/runs`,
    FARMSLOT_POOL_DIR: `${fixture}/pool`,
    FARMSLOT_PROJECTS_DIR: `${fixture}/projects`,
    FARMSLOT_RUN_ARCHIVE_ROOT: `${mount}/archive`,
    FARMSLOT_DISABLE_ORCHESTRATION: '1',
    FARMSLOT_DISPATCH_PRESSURE_ADMISSION: 'off',
    GATEWAY_PORT: String(port),
    GATEWAY_HOST: '127.0.0.1',
  });
  const log = path.join(evidence, 'gateway.log');
  const fd = openSync(log, 'w', 0o600);
  gateway = spawn(
    process.execPath,
    [
      path.join(root, 'scripts/gateway-supervisor.mjs'),
      'yarn',
      'workspace',
      '@farmslot/gateway',
      'start',
    ],
    { cwd: root, env, detached: true, stdio: ['ignore', fd, fd] },
  );
  closeSync(fd);
  const connect = async () =>
    new GatewayClient({ url, timeout: 10000, credential: { token } }).connect();
  await waitFor('supervised gateway startup', 60000, async () => {
    assert.equal(gateway!.exitCode, null);
    try {
      connection = await connect();
      return true;
    } catch (error) {
      if (error instanceof Error && /ECONNREFUSED|closed|timeout/i.test(error.message))
        return false;
      throw error;
    }
  });
  await waitFor('local task watchers armed', 15000, () =>
    Promise.resolve(readFileSync(log, 'utf8').includes('watching local storage-proof-1')),
  );
  const observedMarkdown = new Set<string>();
  connection!.onEvent((event) => {
    if (
      event.event !== 'task.progress.updated' ||
      !event.payload ||
      typeof event.payload !== 'object'
    )
      return;
    const progress: unknown = Reflect.get(event.payload, 'progress');
    if (!progress || typeof progress !== 'object') return;
    const markdown: unknown = Reflect.get(progress, 'markdown');
    if (typeof markdown === 'string') observedMarkdown.add(markdown);
  });
  const before = '# Storage proof\n\n- [x] Preserve this task\n';
  await writeFile(task, before);
  await waitFor('task write observed before detach', 10000, async () =>
    observedMarkdown.has(before),
  );
  const lock = `${fixture}/.runs/gateway-${port}.pid`;
  const firstPid = Number((await readFile(lock, 'utf8')).trim());
  disk('detach', '-force', mount);
  attached = false;
  await waitFor('missing-volume slot projection', 10000, async () => {
    const { fleet } = await connection!.call<{ fleet: FleetStatus }>('fleet.status', {});
    const slot = fleet.slots.find((slot) => slot.slot === 'storage-proof-1');
    return Boolean(slot && !slot.enabled && slot.repoBlocker?.includes('Storage unavailable'));
  });
  assert.equal(
    Number((await readFile(lock, 'utf8')).trim()),
    firstPid,
    'Volume detach must not restart the gateway',
  );
  await assert.rejects(
    connection!.call('slot.prepare', { slotId: 'storage-proof-1' }),
    /Storage unavailable/,
  );
  await assert.rejects(
    writeAtomicJSON(path.join(mount, 'archive/forbidden.json'), { proof: true }),
    /Storage unavailable/,
  );
  assert.equal(existsSync(mount), false, 'A failed write must not recreate the mount point');
  const doctor = await connection!.call<GatewayDoctorResult>('gateway.doctor', {
    sectionId: 'workspace',
  });
  const storage = doctor.sections[0]!.checks.find((check) => check.id === 'storage-volumes');
  assert(storage && !storage.ok && storage.detail.includes(mount));
  disk('attach', '-nobrowse', '-mountpoint', mount, image);
  attached = true;
  assert((await readFile(task, 'utf8')).includes('Preserve this task'));
  await waitFor('volume recovery', 10000, async () => {
    const { fleet } = await connection!.call<{ fleet: FleetStatus }>('fleet.status', {});
    return fleet.slots.find((slot) => slot.slot === 'storage-proof-1')?.enabled === true;
  });
  const after = '# Storage proof\n\n- [ ] Preserve this task\n- [ ] Reconnected volume\n';
  await writeFile(task, after);
  await waitFor('task write observed after reconnect', 10000, async () =>
    observedMarkdown.has(after),
  );
  connection!.close();
  const crashedAt = Date.now();
  process.kill(firstPid, 'SIGABRT');
  await waitFor('automatic replacement gateway', 60000, async () => {
    try {
      if (Number(readFileSync(lock, 'utf8').trim()) === firstPid) return false;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
    try {
      connection = await connect();
      return true;
    } catch (error) {
      if (error instanceof Error && /ECONNREFUSED|closed|timeout/i.test(error.message))
        return false;
      throw error;
    }
  });
  const secondPid = Number(readFileSync(lock, 'utf8').trim());
  const restartMs = Date.now() - crashedAt;
  connection!.close();
  const stopped = once(gateway, 'exit');
  gateway.kill('SIGTERM');
  await stopped;
  assert.throws(() => process.kill(secondPid, 0), { code: 'ESRCH' });
  await writeFile(
    path.join(evidence, 'receipt.json'),
    JSON.stringify(
      {
        head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
        dirty: execFileSync('git', ['status', '--porcelain'], {
          cwd: root,
          encoding: 'utf8',
        }).trim(),
        firstPid,
        secondPid,
        restartMs,
        port,
        missingVolumePrepareRefused: true,
        missingVolumeStoreWriteRefused: true,
        taskWritesObservedBeforeAndAfter: true,
        volumeDetachSurvived: true,
        unavailableSlot: true,
        doctorAlert: storage.detail,
        retainedTaskRecovered: true,
        shutdownExit: gateway.exitCode,
        replacementStopped: true,
      },
      null,
      2,
    ),
  );
  console.log('PASS storage detach, alert, recovery, abort restart and clean stop', restartMs);
} finally {
  connection?.close();
  await stopProcess(gateway);
  if (attached) disk('detach', '-force', mount);
  await rm(scratch, { recursive: true, force: true });
}
