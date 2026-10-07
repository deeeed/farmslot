// Stop the web-dapp slot browser and wallet host by their pid files and prove
// the slot CDP port is released. A pid is signalled only when its command line
// carries this slot's owner marker for that process kind. A pid file naming a
// dead process is removed; one naming a live process without the marker is
// kept and reported, never signalled.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';

import { webDappPolicy, webDappRuntimeDir } from './runtime.mjs';

export function pidAlive(pid) {
  if (!Number.isInteger(Number(pid)) || Number(pid) <= 0) return false;
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

function groupAlive(pgid) {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

function readPid(file) {
  if (!existsSync(file)) return null;
  const pid = Number(readFileSync(file, 'utf8').trim());
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

function psField(pid, field) {
  try {
    return execFileSync('ps', ['-ww', '-o', `${field}=`, '-p', String(pid)], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
}

export function processCommand(pid) {
  return pidAlive(pid) ? psField(pid, 'command') : '';
}

// Each process the slot starts carries `--mm-harness-owner=<kind>-<id>`, where
// <id> is derived from the canonical runtime dir. Ownership is that exact
// argument, compared as a whole whitespace-free token, so a runtime dir that
// shares a prefix with this one (".../terminal backup", ".../terminal2")
// never matches.
export const OWNER_FLAG = '--mm-harness-owner';
export const OWNER_KINDS = Object.freeze(['browser', 'wallet-host', 'console-collector']);

export function ownerMarker(kind, runtimeDir) {
  if (!OWNER_KINDS.includes(kind)) throw new Error(`unknown web-dapp process kind ${kind}`);
  const id = createHash('sha256').update(path.resolve(runtimeDir)).digest('hex').slice(0, 32);
  return `${OWNER_FLAG}=${kind}-${id}`;
}

export function ownsProcess(kind, pid, runtimeDir, command = processCommand(pid)) {
  if (!command) return false;
  return command.split(/\s+/u).includes(ownerMarker(kind, runtimeDir));
}

export function portFree(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port }, () => {
      socket.destroy();
      resolve(false);
    });
    socket.on('error', () => resolve(true));
  });
}

// Browsers and hosts are spawned detached, each leading its own process group.
// When the pid leads its group the whole group is signalled and waited for,
// so children that outlive the leader (renderers, a child ignoring SIGTERM)
// are killed too; otherwise only the pid.
export async function terminate(pid, graceMs = 8000) {
  if (!pidAlive(pid)) return false;
  const group = Number(psField(pid, 'pgid')) === pid;
  const alive = () => (group ? groupAlive(pid) : pidAlive(pid));
  const signal = (name) => {
    try {
      process.kill(group ? -pid : pid, name);
    } catch {
      // Already gone.
    }
  };
  signal('SIGTERM');
  const deadline = Date.now() + graceMs;
  while (alive() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 200));
  if (alive()) {
    signal('SIGKILL');
    const killDeadline = Date.now() + 5000;
    while (alive() && Date.now() < killDeadline)
      await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return true;
}

// The console collector a run started (the host's console capture)
// outlives browser relaunches inside the run; stop and cleanup end it.
export async function stopConsoleCollector(target, { log = () => {}, runtimeDir } = {}) {
  const runtime = runtimeDir ?? webDappRuntimeDir(target);
  const pidFile = path.join(runtime, 'console-tail.pid');
  const pid = readPid(pidFile);
  if (!pid) return { stopped: null };
  if (ownsProcess('console-collector', pid, runtime)) {
    await terminate(pid, 3000);
    rmSync(pidFile, { force: true });
    log(`stopped console collector pid ${pid}`);
    return { stopped: pid };
  }
  if (pidAlive(pid)) {
    log(`console collector pid ${pid} is alive but is not this slot's collector; left it alone`);
    return { stopped: null, foreign: pid };
  }
  rmSync(pidFile, { force: true });
  return { stopped: null, stale: pid };
}

// Every live process that proves it is a browser on this slot's profiles,
// found by command line: a browser started through LaunchServices has no
// child handle, and its pid is only known once it owns the CDP port.
export function ownedBrowserPids(runtimeDir) {
  const runtime = path.resolve(runtimeDir);
  let lines = '';
  try {
    // `--` ends pgrep's options: the pattern itself starts with dashes.
    lines = execFileSync('pgrep', ['-f', '--', ownerMarker('browser', runtime)], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return [];
  }
  return lines
    .split('\n')
    .map(Number)
    .filter((pid) => pid > 0 && ownsProcess('browser', pid, runtime));
}

export function cdpListenerPids(port) {
  try {
    return execFileSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .split('\n')
      .map(Number)
      .filter((pid) => pid > 0);
  } catch {
    return [];
  }
}

export async function stopWebDappBrowser(target, { cdpPort, log = () => {}, runtimeDir } = {}) {
  const runtime = runtimeDir ?? webDappRuntimeDir(target);
  const stopped = [];
  const stale = [];
  const foreign = [];
  for (const name of ['wallet-host', 'browser']) {
    const pidFile = path.join(runtime, `${name}.pid`);
    const pid = readPid(pidFile);
    if (pid && ownsProcess(name, pid, runtime)) {
      if (await terminate(pid)) {
        stopped.push({ name, pid });
        log(`stopped ${name} pid ${pid}`);
      }
      rmSync(pidFile, { force: true });
    } else if (pid && pidAlive(pid)) {
      foreign.push({ name, pid });
      log(
        `${name} pid ${pid} is alive but is not this slot's ${name}; left it and its pid file alone`,
      );
    } else {
      if (pid) stale.push({ name, pid });
      rmSync(pidFile, { force: true });
    }
  }
  rmSync(path.join(runtime, 'wallet-host.ready'), { force: true });
  rmSync(path.join(runtime, 'browser.json'), { force: true });
  let free = null;
  if (cdpPort) {
    const deadline = Date.now() + 10000;
    free = await portFree(cdpPort);
    while (!free && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      free = await portFree(cdpPort);
    }
    if (!free)
      throw new Error(
        `CDP port ${cdpPort} is still in use after stopping the ${webDappPolicy().adapterId} browser; another process owns it.`,
      );
  }
  return { stopped, stale, foreign, cdpPortFree: free };
}
