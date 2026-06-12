// commands/up.ts — start/stop the local gateway as a background service.
//
// `farmslot up` runs the gateway daemon detached with token auth and an
// all-interfaces bind, so a phone (see `farmslot pair`) can reach it, and serves
// the built Command Center dashboard on the same port. It registers a local
// authed profile so subsequent commands (pair, fleet, …) work with no flags.
// `farmslot down` stops it. pid + log live under ~/.farmslot.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { dirname, join } from 'node:path';

import type { Command } from 'commander';

import { bold, cyan, dim, green, red } from '../colors.js';
import {
  DEFAULT_GATEWAY_URL,
  loadProfiles,
  profilesPath,
  saveProfiles,
} from '../gateway-profiles.js';
import { repoRoot } from '../onboarding/workspace.js';
import { OutputContext } from '../output.js';

const LOCAL_PROFILE = 'local';
const UI_DIST_INDEX = join(repoRoot, 'apps', 'command-center', 'ui', 'dist', 'index.html');

function farmslotHome(): string {
  return dirname(profilesPath());
}

function pidFilePath(): string {
  return join(farmslotHome(), 'gateway.pid');
}

function logFilePath(): string {
  return join(farmslotHome(), 'gateway.log');
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    // ESRCH/EPERM both mean "not a process we can signal" — treat as not running.
    return false;
  }
}

/** SIGTERM, wait up to 5s for exit, escalate to SIGKILL — shared by down() and failed boots. */
async function killGracefully(pid: number): Promise<void> {
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    // Raced to exit between the liveness check and the signal — nothing to do.
    return;
  }
  for (let i = 0; i < 10 && isAlive(pid); i++) await delay(500);
  if (isAlive(pid)) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Exited just now — fine.
    }
  }
}

function readPid(): number | null {
  const path = pidFilePath();
  if (!existsSync(path)) return null;
  const pid = Number(readFileSync(path, 'utf-8').trim());
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

/** Reuse the gateway token from .env.local-auth, or mint and persist one. */
function ensureGatewayToken(): string {
  const envPath = join(repoRoot, '.env.local-auth');
  const content = existsSync(envPath) ? readFileSync(envPath, 'utf-8') : '';
  const existing = content.match(/^FARMSLOT_GATEWAY_TOKEN=(.+)$/m);
  if (existing) return existing[1].trim();
  const token = randomBytes(32).toString('base64url');
  const separator = content && !content.endsWith('\n') ? '\n' : '';
  writeFileSync(envPath, `${content}${separator}FARMSLOT_GATEWAY_TOKEN=${token}\n`, {
    mode: 0o600,
  });
  return token;
}

function registerLocalProfile(port: number, token: string): void {
  const profiles = loadProfiles();
  profiles.gateways[LOCAL_PROFILE] = {
    url: port === 7777 ? DEFAULT_GATEWAY_URL : `ws://localhost:${port}`,
    authMode: 'token',
    secret: token,
  };
  if (!profiles.active) profiles.active = LOCAL_PROFILE;
  saveProfiles(profiles);
}

function waitForHealth(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const attempt = (): void => {
      const req = http.get({ host: '127.0.0.1', port, path: '/health', timeout: 1500 }, (res) => {
        res.resume();
        if (res.statusCode === 200) return resolve(true);
        retry();
      });
      req.on('error', retry);
      req.on('timeout', () => req.destroy());
    };
    const retry = (): void => {
      if (Date.now() > deadline) return resolve(false);
      setTimeout(attempt, 500);
    };
    attempt();
  });
}

async function up(port: number, output: OutputContext): Promise<void> {
  const existingPid = readPid();
  if (existingPid && isAlive(existingPid)) {
    if (await waitForHealth(port, 2000)) {
      output.write(`${green('gateway already running')} ${dim(`pid ${existingPid}`)}\n`);
      return;
    }
    // Pid alive but our port is not healthy: either a wedged gateway or the OS
    // reused the pid after a crash. Health on the port is the real authority —
    // stop the stale owner and respawn rather than reporting "already running".
    await killGracefully(existingPid);
  }
  if (existingPid) rmSync(pidFilePath(), { force: true }); // stale pidfile from a crash

  const tsx = join(repoRoot, 'node_modules', '.bin', 'tsx');
  const entry = join(repoRoot, 'services', 'gateway', 'src', 'index.ts');
  if (!existsSync(tsx) || !existsSync(entry)) {
    output.error(
      `cannot start gateway: ${tsx} or ${entry} missing — run install.sh / yarn install in ${repoRoot}`,
    );
    process.exit(1);
  }

  const token = ensureGatewayToken();
  mkdirSync(farmslotHome(), { recursive: true, mode: 0o700 });
  const logFd = openSync(logFilePath(), 'a');
  const child = spawn(tsx, [entry], {
    cwd: repoRoot,
    detached: true,
    stdio: ['ignore', logFd, logFd],
    env: {
      ...process.env,
      GATEWAY_PORT: String(port),
      GATEWAY_HOST: '0.0.0.0',
      FARMSLOT_GATEWAY_TOKEN: token,
    },
  });
  if (child.pid === undefined) {
    output.error('failed to spawn gateway process');
    process.exit(1);
  }
  writeFileSync(pidFilePath(), `${child.pid}\n`);
  child.unref();

  if (!(await waitForHealth(port, 25_000))) {
    // Don't leave a half-started daemon + stale pidfile behind (e.g. EADDRINUSE
    // or a boot deadlock that ignores SIGTERM).
    await killGracefully(child.pid);
    rmSync(pidFilePath(), { force: true });
    output.error(`gateway did not become healthy on :${port} — see ${logFilePath()}`);
    process.exit(1);
  }
  registerLocalProfile(port, token);

  const dashboardBuilt = existsSync(UI_DIST_INDEX);
  if (output.json) {
    output.writeJson({
      pid: child.pid,
      port,
      url: `ws://localhost:${port}`,
      profile: LOCAL_PROFILE,
      dashboard: dashboardBuilt ? `http://localhost:${port}` : null,
    });
    return;
  }
  output.write(`${green('gateway up')} ${dim(`pid ${child.pid}`)}\n`);
  if (dashboardBuilt) {
    output.write(`  ${dim('dashboard')}  ${cyan(`http://localhost:${port}`)}\n`);
  } else {
    output.write(
      `  ${dim('dashboard')}  ${dim('not built — run: yarn --cwd apps/command-center/ui build')}\n`,
    );
  }
  output.write(`  ${dim('gateway')}    ${cyan(`ws://localhost:${port}`)}\n`);
  output.write(`  ${dim('next')}       ${bold('farmslot pair')} ${dim('(pair your phone)')}\n`);
}

async function down(output: OutputContext): Promise<void> {
  const pid = readPid();
  if (!pid || !isAlive(pid)) {
    rmSync(pidFilePath(), { force: true });
    output.write(`${dim('gateway not running')}\n`);
    return;
  }
  await killGracefully(pid);
  rmSync(pidFilePath(), { force: true });
  output.write(`${red('gateway stopped')} ${dim(`pid ${pid}`)}\n`);
}

export function registerUpCommand(program: Command): void {
  program
    .command('up')
    .description('Start the local gateway + dashboard as a background service')
    .option('--port <port>', 'gateway port', '7777')
    .action(async (opts: { port: string }, cmd: Command) => {
      const output = new OutputContext(cmd.optsWithGlobals().json ?? false);
      await up(Number(opts.port), output);
    });

  program
    .command('down')
    .description('Stop the local gateway started by farmslot up')
    .action(async (_opts: unknown, cmd: Command) => {
      const output = new OutputContext(cmd.optsWithGlobals().json ?? false);
      await down(output);
    });
}
