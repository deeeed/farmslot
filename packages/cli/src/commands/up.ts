// commands/up.ts — start/stop the local gateway as a background service.
//
// `farmslot up` runs the gateway daemon detached with token auth and an
// all-interfaces bind, so a phone (see `farmslot pair`) can reach it, and serves
// the built Command Center dashboard on the same port. It registers a `local`
// authed profile for subsequent commands (pair, fleet, …). `farmslot down`
// stops it. pid + log live under <FARMSLOT_HOME> (default ~/.farmslot).
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import http from 'node:http';
import { hostname, networkInterfaces } from 'node:os';
import { join } from 'node:path';

import type { Command } from 'commander';

import { farmslotHome } from '@farmslot/protocol/node/farmslot-home';

import { bold, cyan, dim, green, red, yellow } from '../colors.js';
import { probeGatewayAuth } from '../gateway-auth.js';
import { DEFAULT_GATEWAY_URL, loadProfiles, saveProfiles } from '../gateway-profiles.js';
import { resolveGatewayTls } from '../gateway-tls.js';
import { repoRoot } from '../onboarding/workspace.js';
import { OutputContext } from '../output.js';

const LOCAL_PROFILE = 'local';
const UI_DIST_INDEX = join(repoRoot, 'apps', 'command-center', 'ui', 'dist', 'index.html');
const HOSTED_COMMAND_CENTER_BASE = 'https://farmslot.io/cc';

interface HostedGatewayCandidate {
  url: string;
  label: string;
}

function encodeBase64UrlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function lanIPv4s(): string[] {
  const all: string[] = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const iface of list ?? []) {
      if (iface.family === 'IPv4' && !iface.internal) all.push(iface.address);
    }
  }
  const isPrivate = (ip: string): boolean =>
    /^10\./.test(ip) || /^192\.168\./.test(ip) || /^172\.(1[6-9]|2\d|3[01])\./.test(ip);
  const privateIps = all.filter(isPrivate);
  return [...new Set(privateIps.length > 0 ? privateIps : all)];
}

// When TLS is active, the wss:// candidates come FIRST: a hosted HTTPS Command
// Center refuses ws:// as mixed content (Chrome 150) and will pick the first
// reachable wss:// candidate, while the ws:// entries remain for an http-origin
// CC or the local UI fallback. Pure (host + IPs injected) so the ordering is unit-testable.
export function buildHostedGatewayCandidates(
  port: number,
  tlsPort: number | null,
  host: string,
  lanIps: string[],
): HostedGatewayCandidate[] {
  const secure: HostedGatewayCandidate[] = tlsPort
    ? [
        { url: `wss://localhost:${tlsPort}/ws`, label: 'Local gateway (TLS)' },
        ...lanIps.map((ip) => ({ url: `wss://${ip}:${tlsPort}/ws`, label: `${host} LAN (TLS)` })),
      ]
    : [];
  return [
    ...secure,
    { url: `ws://localhost:${port}/ws`, label: 'Local gateway' },
    ...lanIps.map((ip) => ({ url: `ws://${ip}:${port}/ws`, label: `${host} LAN` })),
  ];
}

function hostedGatewayCandidates(port: number, tlsPort: number | null): HostedGatewayCandidate[] {
  return buildHostedGatewayCandidates(
    port,
    tlsPort,
    hostname().replace(/\.local$/, ''),
    lanIPv4s(),
  );
}

function hostedCommandCenterUrl(port: number, token: string, tlsPort: number | null): string {
  const payload = {
    v: 1,
    gateways: hostedGatewayCandidates(port, tlsPort),
    token,
  };
  return `${HOSTED_COMMAND_CENTER_BASE}#doctor?connect=${encodeBase64UrlJson(payload)}`;
}

function openUrl(url: string): boolean {
  if (process.platform === 'darwin') {
    return spawnSync('open', [url], { stdio: 'ignore' }).status === 0;
  }
  const opener = process.platform === 'win32' ? 'start' : 'xdg-open';
  return (
    spawnSync(opener, [url], { stdio: 'ignore', shell: process.platform === 'win32' }).status === 0
  );
}

function pidFilePath(): string {
  return join(farmslotHome(), 'gateway.pid');
}

function logFilePath(): string {
  return join(farmslotHome(), 'gateway.log');
}

function nodePidFilePath(): string {
  return join(farmslotHome(), 'node.pid');
}

function nodeLogFilePath(): string {
  return join(farmslotHome(), 'node.log');
}

function readNodePid(): number | null {
  const path = nodePidFilePath();
  if (!existsSync(path)) return null;
  const pid = Number(readFileSync(path, 'utf-8').trim());
  return Number.isInteger(pid) && pid > 0 ? pid : null;
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

// The node.pid file can go stale and the OS can reuse that pid for an unrelated process.
// Before trusting it (skip respawn) or killing it, confirm the pid is actually THIS repo's
// node — its command line runs `tsx services/node/src/index.ts` from repoRoot. Prevents both
// "won't start because a foreign pid looks alive" and "down() kills an unrelated process".
function isLocalNodeProcess(pid: number): boolean {
  const entry = join(repoRoot, 'services', 'node', 'src', 'index.ts');
  const res = spawnSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf-8' });
  if (res.status !== 0 || !res.stdout) return false;
  return res.stdout.includes(entry);
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

function writeUpResult(params: {
  output: OutputContext;
  status: 'gateway up' | 'gateway already running';
  pid: number;
  port: number;
  token: string;
  localActive: boolean;
  dashboardBuilt: boolean;
  openBrowser: boolean;
  tlsPort: number | null;
}): void {
  const hostedDashboard = hostedCommandCenterUrl(params.port, params.token, params.tlsPort);
  const fallbackDashboard = `http://localhost:${params.port}`;
  if (params.output.json) {
    params.output.writeJson({
      pid: params.pid,
      port: params.port,
      url: `ws://localhost:${params.port}`,
      profile: LOCAL_PROFILE,
      token: params.token,
      pairCommand: pairHint(params.localActive),
      dashboard: params.dashboardBuilt ? fallbackDashboard : null,
      hostedDashboard,
      fallbackDashboard,
      tlsUrl: params.tlsPort ? `wss://localhost:${params.tlsPort}/ws` : null,
    });
    return;
  }

  // Open the hosted Command Center by default: its connect link auto-registers this
  // gateway, so there is nothing local to run. Chrome/Edge treat ws://localhost as a
  // secure context, so the HTTPS page reaches the local gateway. The local UI (if
  // built) stays as a printed fallback for browsers that block ws://localhost.
  const opened = params.openBrowser && openUrl(hostedDashboard);
  params.output.write(`${green(params.status)} ${dim(`pid ${params.pid}`)}\n`);
  params.output.write(
    `  ${dim('dashboard')}      ${cyan(hostedDashboard)}${opened ? dim(' (opened — auto-connects this gateway)') : ''}\n`,
  );
  params.output.write(
    `  ${dim('local ui')}       ${cyan(fallbackDashboard)} ${dim(
      params.dashboardBuilt
        ? '(fallback if your browser blocks ws://localhost from HTTPS)'
        : '(optional — build: yarn --cwd apps/command-center/ui build)',
    )}\n`,
  );
  params.output.write(`  ${dim('gateway')}        ${cyan(`ws://localhost:${params.port}/ws`)}\n`);
  if (params.tlsPort) {
    params.output.write(
      `  ${dim('gateway (TLS)')}  ${cyan(`wss://localhost:${params.tlsPort}/ws`)} ${dim('(hosted HTTPS Command Center)')}\n`,
    );
  }
  params.output.write(
    `  ${dim('next')}           ${bold(pairHint(params.localActive))} ${dim('(pair your phone)')}\n`,
  );
}

// Co-launch a local node so the gateway host is a real, ONLINE node in the fleet and
// local slots get the node's capability layers (device feed, file-watch, resource-watch,
// metrics). It connects to this gateway over loopback with the same token — no separate
// launchd service, so dev (7801) and prod (7777) each get their own node with no
// cross-gateway conflict. Best-effort: if it can't start, the farm runs degraded, never
// fatal. See ADR-046.
async function startLocalNode(port: number, token: string, output: OutputContext): Promise<void> {
  const existing = readNodePid();
  if (existing && isAlive(existing) && isLocalNodeProcess(existing)) return; // already running
  if (existing) rmSync(nodePidFilePath(), { force: true }); // stale/foreign pid — clear and start fresh

  const tsx = join(repoRoot, 'node_modules', '.bin', 'tsx');
  const entry = join(repoRoot, 'services', 'node', 'src', 'index.ts');
  if (!existsSync(tsx) || !existsSync(entry)) {
    output.write(
      `${yellow('  local node not started')} ${dim('(node service missing — degraded)')}\n`,
    );
    return;
  }

  const machine = hostname().replace(/\.local$/, '');
  const logFd = openSync(nodeLogFilePath(), 'a');
  const child = spawn(tsx, [entry], {
    cwd: repoRoot,
    detached: true,
    stdio: ['ignore', logFd, logFd],
    env: {
      ...process.env,
      GATEWAY_URL: `ws://127.0.0.1:${port}`,
      MACHINE_NAME: machine,
      FARMSLOT_GATEWAY_TOKEN: token,
      FARMSLOT_GATEWAY_AUTH_MODE: 'token',
    },
  });
  closeSync(logFd); // the detached child owns its own dup of the fd now
  if (child.pid === undefined) {
    output.write(`${yellow('  local node failed to spawn')} ${dim('(degraded)')}\n`);
    return;
  }
  writeFileSync(nodePidFilePath(), `${child.pid}\n`);
  child.unref();

  // Soft readiness: confirm it didn't immediately exit (auth/token/crash surfaces here).
  // Full "registered" confirmation is left to the fleet; the node log has the detail.
  await delay(2500);
  if (!isAlive(child.pid)) {
    rmSync(nodePidFilePath(), { force: true });
    output.write(
      `${yellow('  local node exited on startup')} ${dim(`— see ${nodeLogFilePath()} (degraded)`)}\n`,
    );
  }
}

async function up(
  port: number,
  output: OutputContext,
  openBrowser: boolean,
  startNode: boolean,
): Promise<void> {
  // TLS is opt-in: present only after `farmslot certs setup`. When it resolves,
  // the gateway also serves wss:// (on tls.port) and the hosted-CC connect payload
  // leads with the wss:// candidate. Absent, everything stays ws:// as before.
  const tls = resolveGatewayTls();

  const existingPid = readPid();
  if (existingPid && isAlive(existingPid)) {
    if (await waitForHealth(port, 2000)) {
      const token = ensureTokenAuthEnv();
      await verifyTokenAuth(port, token, output);
      const localActive = registerLocalProfile(port, token);
      if (startNode) await startLocalNode(port, token, output);
      writeUpResult({
        output,
        status: 'gateway already running',
        pid: existingPid,
        port,
        token,
        localActive,
        dashboardBuilt: existsSync(UI_DIST_INDEX),
        openBrowser,
        tlsPort: tls?.port ?? null,
      });
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
      // Hand the gateway the resolved cert so it serves wss:// on tls.port too.
      ...(tls
        ? {
            FARMSLOT_GATEWAY_TLS_CERT: tls.certPath,
            FARMSLOT_GATEWAY_TLS_KEY: tls.keyPath,
            FARMSLOT_GATEWAY_TLS_PORT: String(tls.port),
          }
        : {}),
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
  if (startNode) await startLocalNode(port, token, output);

  writeUpResult({
    output,
    status: 'gateway up',
    pid: child.pid,
    port,
    token,
    localActive,
    dashboardBuilt: existsSync(UI_DIST_INDEX),
    openBrowser,
    tlsPort: tls?.port ?? null,
  });
}

async function down(output: OutputContext): Promise<void> {
  // Stop the co-launched local node first (best-effort), then the gateway. Only kill it if
  // the pid is really this repo's node — a stale pidfile could otherwise point at a reused pid.
  const nodePid = readNodePid();
  if (nodePid && isAlive(nodePid) && isLocalNodeProcess(nodePid)) {
    await killGracefully(nodePid);
    output.write(`${red('local node stopped')} ${dim(`pid ${nodePid}`)}\n`);
  }
  rmSync(nodePidFilePath(), { force: true });

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
    .option('--no-open', 'print Command Center URLs without opening a browser')
    .option('--no-node', 'do not co-launch the local node (degraded: no device feed/file-watch)')
    .action(async (opts: { port: string; open?: boolean; node?: boolean }, cmd: Command) => {
      const output = new OutputContext(cmd.optsWithGlobals().json ?? false);
      const startNode = opts.node !== false && process.env.FARMSLOT_SKIP_LOCAL_NODE !== '1';
      await up(Number(opts.port), output, opts.open !== false && !output.json, startNode);
    });

  program
    .command('down')
    .description('Stop the local gateway started by farmslot up')
    .action(async (_opts: unknown, cmd: Command) => {
      const output = new OutputContext(cmd.optsWithGlobals().json ?? false);
      await down(output);
    });
}
