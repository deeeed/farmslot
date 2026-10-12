import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { groupAlive, proofRPC, stopProofGateway, waitForProof } from './proof-gateway.mjs';
import { seedAndroidGatewayProfile } from './seed-ios-gateway-profile.mjs';
import { openAndroidUrl, waitForSimulatorRecipeBridge } from './simulator-dev-client.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const app = path.join(root, 'apps/companion');
const proof = process.env.COMPANION_DEV_LINKS_PROOF_DIR;
assert(proof, 'Set COMPANION_DEV_LINKS_PROOF_DIR to an empty owned scratch directory');
const stateFile = path.join(proof, 'state.json');
const state = () => JSON.parse(fs.readFileSync(stateFile, 'utf8'));
const writeState = (value) => fs.writeFileSync(stateFile, JSON.stringify(value), { mode: 0o600 });
const source = path.join(app, 'src/components/WhatsNewMonitor.tsx');
const sourceBackup = path.join(proof, 'source-backup.tsx');
const adb = (...args) => execFileSync('adb', ['-s', state().serial, ...args], { encoding: 'utf8' });
const phase = process.argv[2];
const commandGroup = Number(
  execFileSync('ps', ['-o', 'pgid=', '-p', String(process.pid)], { encoding: 'utf8' }).trim(),
);
if (phase !== 'setup' && phase !== 'stop' && fs.existsSync(stateFile)) {
  const owned = state();
  owned.commandGroups.push(commandGroup);
  writeState(owned);
}

async function stop() {
  if (!fs.existsSync(stateFile)) return;
  const owned = state();
  const groups = [...owned.pids, ...owned.commandGroups].filter((pid) => pid !== commandGroup);
  for (const pid of groups.reverse()) stopProofGateway(pid);
  for (const session of [owned.metroSession, owned.session]) {
    if (
      execFileSync('tmux', ['list-sessions', '-F', '#{session_name}'], { encoding: 'utf8' })
        .split('\n')
        .includes(session)
    ) {
      execFileSync('tmux', ['kill-session', '-t', `=${session}`]);
    }
  }
  await waitForProof(() => groups.every((pid) => !groupAlive(pid)), 10000);
  if (fs.existsSync(sourceBackup)) fs.copyFileSync(sourceBackup, source);
  fs.rmSync(owned.farm, { recursive: true, force: true });
  fs.rmSync(proof, { recursive: true, force: true });
}

if (phase === 'setup') {
  const serial = process.env.ADB_SERIAL;
  assert(
    /^emulator-\d+$/.test(serial ?? ''),
    'Fresh-client proof requires an explicitly selected owned Android emulator',
  );
  assert.equal(
    process.env.COMPANION_DEV_LINKS_CLEAR_APP,
    '1',
    'Opt in to clearing this owned emulator app',
  );
  for (const name of ['GATEWAY_PORT', 'METRO_PORT']) {
    assert(/^[1-9]\d*$/.test(process.env[name] ?? ''), `Set ${name} to an unused proof port`);
    const occupied = await fetch(`http://127.0.0.1:${process.env[name]}/status`).then(
      () => true,
      (error) => {
        if (error.cause?.code === 'ECONNREFUSED') return false;
        throw error;
      },
    );
    assert(!occupied, `${name} must be unused; this proof never replaces another stack`);
  }
  assert(!fs.existsSync(proof), 'Use a fresh proof directory for each replay');
  fs.mkdirSync(proof, { recursive: true });
  const farm = fs.mkdtempSync(path.join(os.tmpdir(), 'companion-dev-links-'));
  const owned = {
    farm,
    serial,
    port: process.env.GATEWAY_PORT,
    metro: process.env.METRO_PORT,
    machine: `companion-proof-${process.pid}`,
    session: `companion-links-${process.pid}`,
    metroSession: `farmslot-companion-metro-${process.env.METRO_PORT}`,
    pids: [],
    commandGroups: [commandGroup],
  };
  writeState(owned);
  process.once('SIGTERM', async () => {
    await stop();
    process.exit(143);
  });
  process.once('SIGINT', async () => {
    await stop();
    process.exit(130);
  });
  try {
    for (const name of ['pool', 'projects']) fs.mkdirSync(path.join(farm, name));
    fs.writeFileSync(path.join(farm, 'CLAUDE.md'), 'Private Companion dev-client proof.\n');
    for (const args of [
      ['init', '-b', 'proof/dev-links'],
      ['add', 'CLAUDE.md'],
      ['commit', '-S', '-m', 'test: initialize dev-client proof'],
    ]) {
      execFileSync('git', args, { cwd: farm, stdio: 'pipe' });
    }
    for (const name of ['scripts', 'services', 'packages'])
      fs.symlinkSync(path.join(root, name), path.join(farm, name));
    fs.writeFileSync(
      path.join(farm, 'pool/local.json'),
      JSON.stringify({
        machine: owned.machine,
        host: 'localhost',
        ssh_user: os.userInfo().username,
        os: 'macos',
        slots: [],
      }),
    );
    const env = {
      ...process.env,
      FARMSLOT_ROOT: farm,
      FARMSLOT_HOME: path.join(farm, 'home'),
      FARMSLOT_POOL_DIR: path.join(farm, 'pool'),
      FARMSLOT_PROJECTS_DIR: path.join(farm, 'projects'),
      FARMSLOT_RUNS_DIR: path.join(farm, 'runs'),
      FARMSLOT_GATEWAY_TOKEN: '',
      FARMSLOT_GATEWAY_PASSWORD: '',
      FARMSLOT_NODE_TOKEN: '',
      FARMSLOT_DISABLE_ORCHESTRATION: '1',
      FARMSLOT_DISABLE_RUN_ENGINE_START: '1',
      FARMSLOT_STARTUP_BRANCH_PREWARM: '0',
      FARMSLOT_BRANCH_WATCHERS: '0',
      FARMSLOT_LOCAL_HEALTH_POLL: '0',
    };
    function service(kind, overrides) {
      const log = fs.openSync(path.join(proof, `${kind}.log`), 'w');
      const child = spawn(
        path.join(root, 'node_modules/.bin/tsx'),
        [
          '--tsconfig',
          path.join(root, `services/${kind}/tsconfig.json`),
          path.join(root, `services/${kind}/src/index.ts`),
        ],
        { cwd: farm, detached: true, stdio: ['ignore', log, log], env: { ...env, ...overrides } },
      );
      fs.closeSync(log);
      child.on('error', (error) => {
        throw error;
      });
      owned.pids.push(child.pid);
      writeState(owned);
      child.unref();
      return child;
    }
    const gateway = service('gateway', { GATEWAY_HOST: '127.0.0.1' });
    await waitForProof(async () => {
      assert.equal(gateway.exitCode, null, 'Private Gateway exited');
      return fetch(`http://127.0.0.1:${owned.port}/health`).then(
        (r) => r.ok,
        (error) => {
          if (error.cause?.code === 'ECONNREFUSED') return false;
          throw error;
        },
      );
    });
    // The existing server is a precondition. Never start or stop a tmux server.
    execFileSync('tmux', ['list-sessions'], { stdio: 'pipe' });
    execFileSync(
      'tmux',
      [
        'new-session',
        '-d',
        '-s',
        owned.session,
        '-c',
        farm,
        'sh',
        '-c',
        "printf 'Companion link proof\\n'; exec sleep 3600",
      ],
      { stdio: 'pipe' },
    );
    owned.pane = execFileSync(
      'tmux',
      ['list-panes', '-t', `=${owned.session}`, '-F', '#{pane_id}'],
      { encoding: 'utf8' },
    ).trim();
    writeState(owned);
    service('node', {
      GATEWAY_URL: `ws://127.0.0.1:${owned.port}`,
      MACHINE_NAME: owned.machine,
      SCREEN_CONTROL_SOCKET: path.join(farm, 'screen-control.sock'),
    });
    for (const port of [owned.port, owned.metro]) adb('reverse', `tcp:${port}`, `tcp:${port}`);
    adb('shell', 'pm', 'clear', 'net.siteed.farmslot.development');
    seedAndroidGatewayProfile({
      serial,
      bundleId: 'net.siteed.farmslot.development',
      profile: {
        id: 'dev-links-proof',
        name: 'Dev links proof',
        url: `ws://127.0.0.1:${owned.port}`,
        kind: 'lan',
        authMode: 'none',
      },
    });
    execFileSync('bash', ['scripts/agentic/prepare-profile.sh', 'warm'], {
      cwd: app,
      env: {
        ...env,
        CI: '1',
        APP_VARIANT: 'development',
        PLATFORM: 'android',
        DEVICE_MODE: 'emulator',
        METRO_CONNECTION: process.env.METRO_CONNECTION ?? 'localhost',
        EXPO_PUBLIC_GATEWAY_URL: `ws://127.0.0.1:${owned.port}`,
      },
      stdio: 'pipe',
      timeout: 150000,
    });
    await waitForSimulatorRecipeBridge({ platform: 'android' });
    console.log('PASS fresh emulator prepared');
  } catch (error) {
    await stop();
    throw error;
  }
} else if (phase === 'watch') {
  const owned = state();
  const pid = () =>
    execFileSync('lsof', ['-nP', `-iTCP:${owned.metro}`, '-sTCP:LISTEN', '-t'], {
      encoding: 'utf8',
    }).trim();
  const metroPid = pid();
  const marker = `COMPANION_WATCH_PROOF_${Date.now()}`;
  fs.copyFileSync(source, sourceBackup);
  process.once('SIGTERM', () => {
    fs.copyFileSync(sourceBackup, source);
    process.exit(143);
  });
  process.once('SIGINT', () => {
    fs.copyFileSync(sourceBackup, source);
    process.exit(130);
  });
  try {
    fs.appendFileSync(source, `\nconsole.info('${marker}');\n`);
    await waitForProof(
      () =>
        adb('logcat', '-d', '-t', '500', '-v', 'raw', 'ReactNativeJS:V', '*:S').includes(marker),
      30000,
    );
    assert.equal(pid(), metroPid, 'Metro must not restart to apply source edits');
    console.log(JSON.stringify({ automaticRefresh: true, metroPid, marker }));
  } finally {
    fs.copyFileSync(sourceBackup, source);
    fs.unlinkSync(sourceBackup);
  }
} else if (phase === 'open') {
  const owned = state();
  await waitForSimulatorRecipeBridge({ platform: 'android' });
  const url = new URL('farmslot-development://terminal/worker');
  for (const [key, value] of Object.entries({
    nodeId: owned.machine,
    session: owned.session,
    target: owned.pane,
    paneId: owned.pane,
  }))
    url.searchParams.set(key, value);
  openAndroidUrl(owned.serial, 'net.siteed.farmslot.development', url);
  process.stdout.write(owned.pane);
} else if (phase === 'verify') {
  const owned = state();
  const request = await waitForProof(
    () =>
      fs
        .readFileSync(path.join(proof, 'gateway.log'), 'utf8')
        .split('\n')
        .find(
          (line) =>
            line.includes(`[pty] attach key=${owned.machine}:${owned.pane} `) &&
            line.includes(`select=${owned.pane} `),
        ),
    30000,
  );
  const snapshot = proofRPC(root, owned.port, 'terminal.worker.snapshot', {
    worker: {
      nodeId: owned.machine,
      session: owned.session,
      target: owned.pane,
      paneId: owned.pane,
    },
  });
  console.log(JSON.stringify({ pane: owned.pane, request, snapshot }));
} else if (phase === 'bridge') {
  await waitForSimulatorRecipeBridge({ platform: 'android' });
} else if (phase === 'stop') {
  await stop();
} else {
  throw new Error('Use setup, watch, open, verify or stop');
}
