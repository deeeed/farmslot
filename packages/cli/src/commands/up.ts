// commands/up.ts — start/stop the local gateway as a background service.
//
// `farmslot up` runs the gateway daemon detached with token auth and an
// all-interfaces bind, so a phone (see `farmslot pair`) can reach it, and serves
// the built Command Center dashboard on the same port. It registers a `local`
// authed profile for subsequent commands (pair, fleet, …). `farmslot down`
// stops it. pid + log live under ~/.farmslot.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { dirname, join } from 'node:path';

import type { Command } from 'commander';

import { bold, cyan, dim, green, red } from '../colors.js';
import { probeGatewayAuth } from '../gateway-auth.js';
import {
  DEFAULT_GATEWAY_URL,
  loadProfiles,
  profilesPath,
  saveProfiles,
} from '../gateway-profiles.js';
import { maybePromptGithubStar } from '../onboarding/star-prompt.js';
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

/**
 * Ensure .env.local-auth gives the up-managed gateway token auth: reuse or mint
 * FARMSLOT_GATEWAY_TOKEN, and pin FARMSLOT_GATEWAY_AUTH_MODE=token. The gateway
 * force-loads .env then .env.local-auth (last wins) and resolves password /
 * explicit mode over token — without the pin, a password or mode override in
 * .env would start the gateway with auth the stored token profile can't satisfy.
 */
function ensureTokenAuthEnv(): string {
  const envPath = join(repoRoot, '.env.local-auth');
  const original = existsSync(envPath) ? readFileSync(envPath, 'utf-8') : '';
  const lines = original.split('\n');
  // The gateway's env loader applies lines top-to-bottom (last assignment
  // wins) — mirror that when reusing an existing token.
  let token: string | null = null;
  for (const line of lines) {
    const match = line.match(/^FARMSLOT_GATEWAY_TOKEN=(.+)$/);
    if (match) token = match[1].trim();
  }
  const hadToken = token !== null;
  if (!token) token = randomBytes(32).toString('base64url');
  // Drop EVERY AUTH_MODE line (duplicates included — the last one would win in
  // the loader) and pin exactly one token-mode line at the end of the file.
  const kept = lines.filter((line) => !line.startsWith('FARMSLOT_GATEWAY_AUTH_MODE='));
  while (kept.length > 0 && kept[kept.length - 1] === '') kept.pop();
  if (!hadToken) kept.push(`FARMSLOT_GATEWAY_TOKEN=${token}`);
  kept.push('FARMSLOT_GATEWAY_AUTH_MODE=token');
  const next = kept.join('\n') + '\n';
  if (next !== original) writeFileSync(envPath, next, { mode: 0o600 });
  return token;
}

/** Register/refresh the `local` profile; returns true when it is the active profile. */
function registerLocalProfile(port: number, token: string): boolean {
  const profiles = loadProfiles();
  profiles.gateways[LOCAL_PROFILE] = {
    url: port === 7777 ? DEFAULT_GATEWAY_URL : `ws://localhost:${port}`,
    authMode: 'token',
    secret: token,
  };
  // Don't hijack an existing active profile (e.g. a remote gateway the user
  // works against); the printed pair hint targets `local` explicitly instead.
  if (!profiles.active) profiles.active = LOCAL_PROFILE;
  saveProfiles(profiles);
  return profiles.active === LOCAL_PROFILE;
}

function healthOnce(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/health', timeout: 1500 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
  });
}

async function waitForHealth(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    if (await healthOnce(port)) return true;
    await delay(500);
  }
  return false;
}

/**
 * Wait for our spawned gateway to become healthy. Checks child liveness first:
 * if the child died (e.g. EADDRINUSE), a 200 on /health could only come from a
 * foreign process that grabbed the port — never report that as our success.
 */
async function waitForHealthOrExit(
  port: number,
  pid: number,
  timeoutMs: number,
): Promise<'healthy' | 'exited' | 'timeout'> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    if (!isAlive(pid)) return 'exited';
    if (await healthOnce(port)) return 'healthy';
    await delay(500);
  }
  return 'timeout';
}

/** The up-managed gateway must accept our token — anything else is a broken pairing setup. */
async function verifyTokenAuth(port: number, token: string, output: OutputContext): Promise<void> {
  const probe = await probeGatewayAuth(`ws://localhost:${port}`, { token });
  if (probe.state === 'authenticated') return;
  output.error(
    `gateway on :${port} did not accept the local token (auth state: ${probe.state}) — ` +
      `check FARMSLOT_GATEWAY_* overrides in ${join(repoRoot, '.env')} and restart: farmslot down && farmslot up`,
  );
  process.exit(1);
}

function pairHint(localActive: boolean): string {
  return localActive ? 'farmslot pair' : 'farmslot --gateway local pair';
}

async function up(port: number, output: OutputContext): Promise<void> {
  const existingPid = readPid();
  if (existingPid && isAlive(existingPid)) {
    if (await waitForHealth(port, 2000)) {
      const token = ensureTokenAuthEnv();
      await verifyTokenAuth(port, token, output);
      const localActive = registerLocalProfile(port, token);
      output.write(`${green('gateway already running')} ${dim(`pid ${existingPid}`)}\n`);
      output.write(`  ${dim('dashboard')}  ${cyan(`http://localhost:${port}`)}\n`);
      output.write(
        `  ${dim('token')}      ${token} ${dim('(paste into the dashboard to log in)')}\n`,
      );
      output.write(
        `  ${dim('next')}       ${bold(pairHint(localActive))} ${dim('(pair your phone)')}\n`,
      );
      return;
    }
    // Pid alive but our port is not healthy: either a wedged gateway or the OS
    // reused the pid after a crash. Health on the port is the real authority —
    // stop the stale owner and respawn rather than reporting "already running".
    await killGracefully(existingPid);
  }
  if (existingPid) rmSync(pidFilePath(), { force: true }); // stale pidfile from a crash

  // No pidfile of ours owns this port — if something already answers /health
  // there (a dev gateway under tsx watch, another service), spawning would die
  // on EADDRINUSE while the old process keeps answering. Refuse instead of
  // adopting a process we don't manage.
  if (await healthOnce(port)) {
    output.error(
      `port :${port} already serves /health but is not managed by farmslot up — ` +
        `stop that process or pick another port (--port)`,
    );
    process.exit(1);
  }

  const tsx = join(repoRoot, 'node_modules', '.bin', 'tsx');
  const entry = join(repoRoot, 'services', 'gateway', 'src', 'index.ts');
  if (!existsSync(tsx) || !existsSync(entry)) {
    output.error(
      `cannot start gateway: ${tsx} or ${entry} missing — run install.sh / yarn install in ${repoRoot}`,
    );
    process.exit(1);
  }

  const token = ensureTokenAuthEnv();
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
      FARMSLOT_GATEWAY_AUTH_MODE: 'token',
    },
  });
  if (child.pid === undefined) {
    output.error('failed to spawn gateway process');
    process.exit(1);
  }
  writeFileSync(pidFilePath(), `${child.pid}\n`);
  child.unref();

  const boot = await waitForHealthOrExit(port, child.pid, 25_000);
  if (boot !== 'healthy') {
    // Don't leave a half-started daemon + stale pidfile behind (e.g. EADDRINUSE
    // or a boot deadlock that ignores SIGTERM).
    await killGracefully(child.pid);
    rmSync(pidFilePath(), { force: true });
    output.error(
      boot === 'exited'
        ? `gateway exited during startup — see ${logFilePath()}`
        : `gateway did not become healthy on :${port} — see ${logFilePath()}`,
    );
    process.exit(1);
  }
  await verifyTokenAuth(port, token, output);
  const localActive = registerLocalProfile(port, token);

  const dashboardBuilt = existsSync(UI_DIST_INDEX);
  if (output.json) {
    output.writeJson({
      pid: child.pid,
      port,
      url: `ws://localhost:${port}`,
      profile: LOCAL_PROFILE,
      token,
      pairCommand: pairHint(localActive),
      dashboard: dashboardBuilt ? `http://localhost:${port}` : null,
    });
    return;
  }
  output.write(`${green('gateway up')} ${dim(`pid ${child.pid}`)}\n`);
  if (dashboardBuilt) {
    output.write(`  ${dim('dashboard')}  ${cyan(`http://localhost:${port}`)}\n`);
    output.write(
      `  ${dim('token')}      ${token} ${dim('(paste into the dashboard to log in)')}\n`,
    );
  } else {
    output.write(
      `  ${dim('dashboard')}  ${dim('not built — run: yarn --cwd apps/command-center/ui build')}\n`,
    );
  }
  output.write(`  ${dim('gateway')}    ${cyan(`ws://localhost:${port}`)}\n`);
  output.write(
    `  ${dim('next')}       ${bold(pairHint(localActive))} ${dim('(pair your phone)')}\n`,
  );
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
      if (!output.json) await maybePromptGithubStar();
    });

  program
    .command('down')
    .description('Stop the local gateway started by farmslot up')
    .action(async (_opts: unknown, cmd: Command) => {
      const output = new OutputContext(cmd.optsWithGlobals().json ?? false);
      await down(output);
    });
}
