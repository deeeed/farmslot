// Disposable-gateway proof that idle resource cleanup reaches a disabled slot's
// running simulator and verifies a stopped simulator as stopped. The simulators
// are a fake `simctl` over flag files; no real device is touched.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';

import '../lib/no-inherited-git-location.mjs';

import { testGatewayIdentity } from '../../lib/test-gateway-identity.mjs';
import {
  closeTmuxSandbox,
  GIT_LOCATION_ENV,
  openTmuxSandbox,
  tmuxSandboxEnvironment,
} from '../../quality/run-tsx-tests.mjs';

const sourceRoot = process.cwd();
const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), 'farmslot-idle-cleanup-'));
const root = path.join(temporaryRoot, 'root');
const devices = path.join(temporaryRoot, 'devices');
const fakeSimctl = path.join(temporaryRoot, 'bin', 'simctl');
const project = `idle-cleanup-${randomUUID()}`;
const disabledSlot = `idle-disabled-${randomUUID()}`;
const readySlot = `idle-ready-${randomUUID()}`;
// A disabled slot on a machine whose node never connects.
const offlineSlot = `idle-offline-${randomUUID()}`;
// A disabled slot still bound to a run: never a cleanup target, never probed.
const boundSlot = `idle-bound-${randomUUID()}`;
const simctlCalls = path.join(temporaryRoot, 'simctl-calls.log');
const tmuxDir = openTmuxSandbox();
const baseEnv = { ...process.env };
for (const key of GIT_LOCATION_ENV) delete baseEnv[key];
let gateway;
let logFd;

function writeJson(file, value) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

async function freePort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  await new Promise((resolve) => server.close(resolve));
  return address.port;
}

const booted = (slot) => existsSync(path.join(devices, `${slot}.booted`));

try {
  // `simctl booted NAME` succeeds while NAME's flag exists; `simctl shutdown NAME` removes it.
  mkdirSync(devices, { recursive: true });
  mkdirSync(path.dirname(fakeSimctl), { recursive: true });
  writeFileSync(
    fakeSimctl,
    [
      '#!/bin/sh',
      `flag="${devices}/$2.booted"`,
      `printf '%s %s\\n' "$1" "$2" >> "${simctlCalls}"`,
      'case "$1" in',
      '  booted) test -f "$flag" ;;',
      '  shutdown) rm -f "$flag" ;;',
      '  *) exit 2 ;;',
      'esac',
      '',
    ].join('\n'),
  );
  chmodSync(fakeSimctl, 0o755);
  for (const slot of [disabledSlot, readySlot, offlineSlot, boundSlot])
    writeFileSync(path.join(devices, `${slot}.booted`), '');

  mkdirSync(path.join(root, 'scripts'), { recursive: true });
  writeFileSync(path.join(root, 'CLAUDE.md'), '# Disposable idle-cleanup fixture\n');
  writeFileSync(path.join(root, 'scripts', 'dev.sh'), '#!/bin/sh\n');
  execFileSync('git', ['init', '-q'], { cwd: root, env: baseEnv, stdio: 'pipe' });
  writeJson(path.join(root, 'services', 'gateway', 'package.json'), {
    name: 'fixture',
    version: '0.0.0',
  });
  const slotEntry = (id, enabled) => {
    const repo = path.join(temporaryRoot, id);
    mkdirSync(repo, { recursive: true });
    return {
      id,
      project,
      platform: 'ios',
      repo,
      session: id,
      // A disabled slot is `enabled: false`, which the fleet reads as mode disabled.
      ...(enabled ? { enabled, mode: 'dispatch' } : { enabled }),
      resources: { 'ios-sim': { simulator: id, headless: true } },
    };
  };
  writeJson(path.join(root, 'pool', 'idle.json'), {
    machine: os.hostname(),
    host: 'localhost',
    ssh_user: os.userInfo().username,
    os: process.platform,
    slots: [
      slotEntry(disabledSlot, false),
      slotEntry(readySlot, true),
      slotEntry(boundSlot, false),
    ],
  });
  writeJson(path.join(root, 'pool', 'offline.json'), {
    machine: 'idle-offline-node',
    host: 'idle-offline-node.invalid',
    ssh_user: os.userInfo().username,
    os: 'darwin',
    slots: [slotEntry(offlineSlot, false)],
  });
  writeJson(path.join(root, 'projects', project, 'project.json'), {
    name: project,
    type: 'monorepo',
    default_branch: 'main',
    resources: {
      'ios-sim': {
        type: 'device',
        platform: 'ios',
        label: 'iOS Sim',
        controllable: true,
        hooks: {
          health: `"${fakeSimctl}" booted '{{simulator}}'`,
          shutdown: `"${fakeSimctl}" shutdown '{{simulator}}'`,
        },
      },
    },
  });
  writeJson(path.join(root, '.farm-status.json'), {
    checked_at: new Date().toISOString(),
    slots: [
      { slot: disabledSlot, lifecycle: 'disabled', agent: '-', enabled: false },
      { slot: offlineSlot, lifecycle: 'disabled', agent: '-', enabled: false },
      {
        slot: boundSlot,
        lifecycle: 'disabled',
        agent: '-',
        enabled: false,
        current_run_id: randomUUID(),
      },
      { slot: readySlot, lifecycle: 'ready', agent: 'idle' },
    ],
  });

  const port = await freePort();
  testGatewayIdentity(path.join(temporaryRoot, 'home'), `ws://127.0.0.1:${port}`);
  const env = tmuxSandboxEnvironment(
    {
      ...baseEnv,
      FARMSLOT_ROOT: root,
      FARMSLOT_HOME: path.join(temporaryRoot, 'home'),
      FARMSLOT_POOL_DIR: path.join(root, 'pool'),
      FARMSLOT_PROJECTS_DIR: path.join(root, 'projects'),
      FARMSLOT_RUNS_DIR: path.join(root, '.runs'),
      FARMSLOT_CAPABILITY_STORE_FILE: path.join(root, '.runs', 'runtime-capabilities.json'),
      FARMSLOT_DISABLE_ORCHESTRATION: '1',
      FARMSLOT_DISABLE_RUN_ENGINE_START: '1',
      NODE_TEST_CONTEXT: '1',
      FARMSLOT_DEMO_POOL: '0',
      GATEWAY_HOST: '127.0.0.1',
      GATEWAY_PORT: String(port),
      FARMSLOT_GATEWAY_PROFILE: 'proof',
      FARMSLOT_GATEWAY_PASSWORD: '',
      FARMSLOT_GATEWAY: `ws://127.0.0.1:${port}`,
      FARMSLOT_RPC_TIMEOUT_MS: '25000',
      // A disabled slot's probed status is trusted this long (60 s by default).
      FARMSLOT_DISABLED_SLOT_PROBE_TTL_MS: '1500',
      TSX_TSCONFIG_PATH: path.join(sourceRoot, 'services/gateway/tsconfig.json'),
    },
    tmuxDir,
  );
  const rpc = (method, params) =>
    JSON.parse(
      execFileSync(
        process.execPath,
        ['apps/command-center/scripts/cdp.mjs', 'gateway', method, JSON.stringify(params)],
        { cwd: sourceRoot, env, encoding: 'utf8', timeout: 40000, stdio: 'pipe' },
      ),
    );
  const status = (slot) =>
    rpc('resource.list', { slotId: slot }).resources.find((r) => r.id === 'ios-sim')?.status;

  logFd = openSync(path.join(temporaryRoot, 'gateway.log'), 'w');
  gateway = spawn(process.execPath, ['--import', 'tsx', 'services/gateway/src/index.ts'], {
    cwd: sourceRoot,
    env,
    stdio: ['ignore', logFd, logFd],
  });
  for (let attempt = 0; ; attempt++) {
    if (gateway.exitCode !== null || gateway.signalCode !== null)
      throw new Error('Fixture gateway exited during startup');
    try {
      if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break;
    } catch (error) {
      if (!(error instanceof TypeError)) throw error;
    }
    if (attempt >= 450) throw new Error('Fixture gateway did not start');
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  // Node watches fill the cache for enabled slots only. This gateway has no node,
  // so one probe stands in for the ready slot's watch; nothing fills the disabled
  // slots, exactly as on a live gateway after a restart.
  rpc('resource.health', { slotId: readySlot });
  assert.deepEqual(
    [status(disabledSlot), status(offlineSlot), status(readySlot)],
    ['unknown', 'unknown', 'running'],
  );

  // The pressure snapshot (Command Center's cleanup preview) probes the local
  // disabled slot and offers its simulator; the unreachable one is not waited on.
  const started = Date.now();
  const snapshot = rpc('resource.pressure.snapshot', {});
  const snapshotMs = Date.now() - started;
  assert.deepEqual(
    snapshot.cleanupCandidates.map((candidate) => candidate.slotId).sort(),
    [disabledSlot, readySlot].sort(),
  );
  assert.ok(snapshotMs < 10000, `snapshot waited ${snapshotMs} ms on an unreachable node`);

  // The cleanup preview offers the disabled slot's simulator too.
  const preview = rpc('resource.cleanup', {
    dryRun: true,
    slotIds: [disabledSlot, readySlot],
    resourceIds: ['ios-sim'],
  });
  assert.deepEqual(
    preview.targets.map((target) => target.slotId).sort(),
    [disabledSlot, readySlot].sort(),
  );

  // Live cleanup stops both and verifies them by probing, not from the cache.
  const result = rpc('resource.cleanup', {
    dryRun: false,
    targets: preview.targets.map(({ machine, slotId, resourceId }) => ({
      machine,
      slotId,
      resourceId,
    })),
  });
  assert.deepEqual(
    result.targets
      .map(({ slotId, ok, afterStatus }) => ({ slotId, ok, afterStatus }))
      .sort((a, b) => a.slotId.localeCompare(b.slotId)),
    [disabledSlot, readySlot]
      .sort()
      .map((slotId) => ({ slotId, ok: true, afterStatus: 'stopped' })),
  );
  assert.deepEqual([result.stopped, result.failed], [2, 0]);
  assert.deepEqual([booted(disabledSlot), booted(readySlot)], [false, false]);
  assert.deepEqual([status(disabledSlot), status(readySlot)], ['stopped', 'stopped']);

  // Something boots the disabled slot's simulator again (a provisioning run); once
  // its probed status is older than the TTL, the snapshot offers it again.
  writeFileSync(path.join(devices, `${disabledSlot}.booted`), '');
  let reoffered = false;
  for (let attempt = 0; attempt < 20 && !reoffered; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    reoffered = rpc('resource.pressure.snapshot', {}).cleanupCandidates.some(
      (candidate) => candidate.slotId === disabledSlot,
    );
  }
  assert.ok(reoffered, 'a re-booted simulator on a disabled slot was not offered again');
  assert.ok(
    !readFileSync(simctlCalls, 'utf8').includes(` ${boundSlot}`),
    'a disabled slot bound to a run was probed',
  );

  console.log(
    JSON.stringify({
      disabledSlotOffered: true,
      unreachableSlotSkippedMs: snapshotMs,
      rebootedSimulatorReoffered: reoffered,
      boundSlotProbed: false,
      stopped: result.stopped,
      failed: result.failed,
      verifiedStopped: result.targets.map((target) => target.afterStatus),
    }),
  );
} catch (error) {
  if (logFd !== undefined)
    console.error(readFileSync(path.join(temporaryRoot, 'gateway.log'), 'utf8').slice(-4500));
  throw error;
} finally {
  if (gateway && gateway.exitCode === null && gateway.signalCode === null) {
    const stopped = once(gateway, 'exit');
    gateway.kill('SIGTERM');
    await stopped;
  }
  if (logFd !== undefined) closeSync(logFd);
  closeTmuxSandbox(tmuxSandboxEnvironment(baseEnv, tmuxDir));
  rmSync(temporaryRoot, { recursive: true, force: true });
}
