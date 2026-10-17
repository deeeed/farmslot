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
      'case "$1" in',
      '  booted) test -f "$flag" ;;',
      '  shutdown) rm -f "$flag" ;;',
      '  *) exit 2 ;;',
      'esac',
      '',
    ].join('\n'),
  );
  chmodSync(fakeSimctl, 0o755);
  for (const slot of [disabledSlot, readySlot])
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
      enabled,
      mode: 'dispatch',
      resources: { 'ios-sim': { simulator: id, headless: true } },
    };
  };
  writeJson(path.join(root, 'pool', 'idle.json'), {
    machine: os.hostname(),
    host: 'localhost',
    ssh_user: os.userInfo().username,
    os: process.platform,
    slots: [slotEntry(disabledSlot, false), slotEntry(readySlot, true)],
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
      { slot: disabledSlot, lifecycle: 'disabled', agent: 'idle' },
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

  // Both simulators run on idle slots; one slot is disabled. A probe fills the
  // status cache, as the node's resource watches do on a live gateway.
  for (const slot of [disabledSlot, readySlot]) rpc('resource.health', { slotId: slot });
  assert.deepEqual([status(disabledSlot), status(readySlot)], ['running', 'running']);

  // The preview offers the disabled slot's simulator too.
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

  console.log(
    JSON.stringify({
      disabledSlotOffered: true,
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
