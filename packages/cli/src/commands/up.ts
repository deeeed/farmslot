// commands/up.ts — start/stop the local gateway as a background service.
//
// `farmslot up` runs the gateway daemon detached with token auth and an
// all-interfaces bind, so a phone (see `farmslot pair`) can reach it, and serves
// the built Command Center dashboard on the same port. It registers a `local`
// authed profile for subsequent commands (pair, fleet, …). `farmslot down`
// stops it. pid + log live under <FARMSLOT_HOME> (default ~/.farmslot).
import { spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
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
import { pathToFileURL } from 'node:url';

import type { Command } from 'commander';

import {
  CredentialStoreRuntime,
  CredentialStoreWriter,
  parseCredentialWire,
  verifySecret,
} from '@farmslot/credential-store';
import {
  type CredentialIssueResult,
  type CredentialListResult,
  hasAuthErrorCode,
  type PairingCreateResult,
  parsePersonSessionToken,
  PersonSessionChangedError,
  type PrincipalCreateResult,
  type PrincipalListResult,
  samePersonSessionAuthority,
} from '@farmslot/protocol';
import { farmslotHome } from '@farmslot/protocol/node/farmslot-home';

import { bold, cyan, dim, green, red, yellow } from '../colors.js';
import { probeGatewayAuth } from '../gateway-auth.js';
import {
  GatewayClient,
  GatewayConnectionError,
  type GatewayCredential,
  GatewayRpcError,
} from '../gateway-client.js';
import {
  DEFAULT_GATEWAY_PORT,
  DEFAULT_GATEWAY_URL,
  loadProfiles,
  saveProfiles,
  storedProfileCredential,
} from '../gateway-profiles.js';
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

// Without a token the payload still pre-fills the gateway candidates; the Command
// Center then reuses a token it already stores or asks for one.
function hostedCommandCenterUrl(
  port: number,
  token: string | null,
  tlsPort: number | null,
  code?: string,
): string {
  const payload = {
    v: 1,
    gateways: hostedGatewayCandidates(port, tlsPort),
    ...(token ? { token } : {}),
    ...(code ? { code } : {}),
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

/** First interactive startup issues a person credential; subsequent starts reuse its profile. */
export function ensureLocalCredential(port: number): GatewayCredential {
  const profile = loadProfiles().gateways[LOCAL_PROFILE];
  const url = port === DEFAULT_GATEWAY_PORT ? DEFAULT_GATEWAY_URL : `ws://localhost:${port}`;
  const runtime = new CredentialStoreRuntime();
  if (profile?.url === url && profile.authMode === 'token' && profile.personSession) {
    const profileAuth = storedProfileCredential(LOCAL_PROFILE, profile);
    if (profileAuth) return profileAuth;
  }
  if (
    profile?.url === url &&
    profile.authMode === 'token' &&
    profile.secret &&
    parseCredentialWire(profile.secret)
  ) {
    const parsed = parseCredentialWire(profile.secret)!;
    const credential = runtime.findCredential(parsed.credentialId);
    const principal = credential ? runtime.findPrincipal(credential.principalId) : undefined;
    if (
      !credential ||
      credential.revokedAt !== null ||
      !verifySecret(parsed.secret, credential.secret) ||
      !principal ||
      principal.subject.type === 'node'
    ) {
      throw new Error(
        'The local profile credential is invalid or revoked. Log in again before starting the gateway.',
      );
    }
    const profileAuth = storedProfileCredential(LOCAL_PROFILE, profile);
    if (profileAuth) return profileAuth;
    throw new Error('The local profile has no usable credential. Sign in again.');
  }
  if (profile?.url === url && (profile.secret || profile.personSession))
    throw new Error(
      'The local profile has an unverified credential. Verify or replace it explicitly before starting a new gateway.',
    );
  if (runtime.isActivated() || !process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error(
      'A verified local profile is required. Add the local gateway profile and log in with a person pairing code; for recovery, stop every gateway and use credential issue --offline.',
    );
  }
  const writer = new CredentialStoreWriter(runtime, true);
  const principal = writer.createPrincipal({ type: 'person', displayName: 'owner' }, [
    { role: 'admin', scope: { kind: 'global' } },
  ]);
  const issued = writer.issueCredential(principal.id, 'local-cli');
  // The existing offline first-owner bootstrap uses the same locked issuer as the gateway.
  // Persist its device authority before boot so a failed daemon start cannot lose the only login.
  const grant = writer.exchangePersonCredential(issued.secret, {
    deviceName: `CLI on ${hostname()}`.slice(0, 128),
    deviceKind: 'cli',
  });
  registerLocalProfile(port, {
    personSession: { session: grant.session, refreshToken: grant.refreshToken },
  });
  const credential = storedProfileCredential(LOCAL_PROFILE, loadProfiles().gateways[LOCAL_PROFILE]);
  if (!credential) throw new Error('The local device sign-in could not be saved.');
  return credential;
}

/** The local node has its own machine-bound credential, never the CLI's identity. */
async function localNodeCredential(port: number, credential: GatewayCredential): Promise<string> {
  const machine = hostname().replace(/\.local$/, '');
  const secretPath = join(farmslotHome(), 'node.secret');
  // Use the node's own install/reconnect resolution before the startup cache.
  // A verified rotation must also survive a later up without the inherited env.
  const { resolveGatewayCredential } = await import(
    pathToFileURL(join(repoRoot, 'services/node/src/gateway-credential.ts')).href
  );
  const installed: string | undefined = resolveGatewayCredential(process.env, repoRoot)?.token;
  if (installed || existsSync(secretPath)) {
    const secret = installed ?? readFileSync(secretPath, 'utf8').trim();
    const runtime = new CredentialStoreRuntime();
    const parsed = parseCredentialWire(secret);
    const credential = parsed ? runtime.findCredential(parsed.credentialId) : undefined;
    const principal = credential ? runtime.findPrincipal(credential.principalId) : undefined;
    if (
      !parsed ||
      credential?.revokedAt !== null ||
      !verifySecret(parsed.secret, credential.secret) ||
      principal?.subject.type !== 'node' ||
      principal.subject.machine !== machine
    ) {
      throw new Error(
        'The local node credential is invalid. Rotate it with credential issue --principal <node-id>, verify the replacement, and revoke the old credential.',
      );
    }
    if (installed) {
      writeFileSync(secretPath, `${secret}\n`, { mode: 0o600 });
      chmodSync(secretPath, 0o600);
    }
    return secret;
  }
  const client = new GatewayClient({
    url: `ws://localhost:${port}`,
    timeout: 5000,
    credential,
  });
  const listed = await client.call<PrincipalListResult>('principal.list', {});
  const nodes = listed.principals.filter(
    (principal) => principal.subject.type === 'node' && principal.subject.machine === machine,
  );
  if (nodes.length > 1)
    throw new Error('Consolidate node principals for this machine before starting its local node');
  const existing = nodes[0];
  if (existing) {
    const credentials = await client.call<CredentialListResult>('credential.list', {});
    if (credentials.credentials.some((credential) => credential.principalId === existing.id)) {
      throw new Error(
        'This machine already has an active node credential. Install that credential rather than creating a duplicate.',
      );
    }
  }
  const created =
    existing ??
    (
      await client.call<PrincipalCreateResult>('principal.create', {
        subject: { type: 'node', displayName: `node-${machine}`, machine },
        roles: [],
      })
    ).principal;
  const issue = await client.call<CredentialIssueResult>('credential.issue', {
    principalId: created.id,
    displayName: machine,
  });
  try {
    writeFileSync(secretPath, `${issue.secret}\n`, { flag: 'wx', mode: 0o600 });
    chmodSync(secretPath, 0o600);
  } catch (error) {
    await client.call('credential.revoke', { credentialId: issue.credential.id });
    throw error;
  }
  return issue.secret;
}

/** Register/refresh the `local` profile; returns true when it is the active profile. */
function registerLocalProfile(port: number, credential: GatewayCredential): boolean {
  const profiles = loadProfiles();
  const current = profiles.gateways[LOCAL_PROFILE];
  if (credential.personSession && current?.personSession) {
    if (!samePersonSessionAuthority(credential.personSession, current.personSession))
      throw new PersonSessionChangedError();
    // Verification already persisted fresh metadata through the shared controller.
  } else
    profiles.gateways[LOCAL_PROFILE] = {
      url: port === DEFAULT_GATEWAY_PORT ? DEFAULT_GATEWAY_URL : `ws://localhost:${port}`,
      authMode: 'token',
      ...(credential.personSession
        ? { personSession: credential.personSession }
        : { secret: credential.token }),
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
async function verifyTokenAuth(
  port: number,
  credential: GatewayCredential,
  output: OutputContext,
): Promise<void> {
  const probe = await probeGatewayAuth(`ws://localhost:${port}`, credential);
  if (probe.state === 'authenticated') return;
  if (probe.errorCode === 'AUTH_PERSON_SESSION_REQUIRED')
    throw Object.assign(
      new Error(
        'The local person login needs a device session. The gateway is running; use farmslot login local --token <credential> or --code <pairing-code>, then retry farmslot up.',
      ),
      { code: probe.errorCode },
    );
  output.error(
    `gateway on :${port} did not accept the local token (auth state: ${probe.state}) — ` +
      `check the local gateway profile and restart: farmslot down && farmslot up`,
  );
  throw new Error(`Local gateway credential verification failed: ${probe.state}`);
}

function pairHint(localActive: boolean): string {
  return localActive ? 'farmslot pair' : 'farmslot --gateway local pair';
}

export function writeUpResult(params: {
  output: OutputContext;
  status: 'gateway up' | 'gateway already running';
  pid: number;
  port: number;
  token?: string;
  pairingCode?: string;
  localActive: boolean;
  dashboardBuilt: boolean;
  openBrowser: boolean;
  printConnectUrl: boolean;
  tlsPort: number | null;
  open?: (url: string) => boolean;
}): void {
  // The connect link carries the gateway token, so it only reaches stdout (terminals,
  // agent transcripts, logs) on explicit --print-connect-url; the browser gets it directly.
  const hostedDashboard = hostedCommandCenterUrl(params.port, null, params.tlsPort);
  const token = params.token && !parsePersonSessionToken(params.token, 'fsa') ? params.token : null;
  const connectUrl = hostedCommandCenterUrl(params.port, token, params.tlsPort, params.pairingCode);
  const fallbackDashboard = `http://localhost:${params.port}`;
  if (params.output.json) {
    params.output.writeJson({
      pid: params.pid,
      port: params.port,
      url: `ws://localhost:${params.port}`,
      profile: LOCAL_PROFILE,
      pairCommand: pairHint(params.localActive),
      dashboard: params.dashboardBuilt ? fallbackDashboard : null,
      hostedDashboard,
      // The raw token, like the link that carries it, only on --print-connect-url.
      ...(params.printConnectUrl ? { ...(token ? { token } : {}), connectUrl } : {}),
      fallbackDashboard,
      tlsUrl: params.tlsPort ? `wss://localhost:${params.tlsPort}/ws` : null,
    });
    return;
  }

  // Open the hosted Command Center by default: its connect link auto-registers this
  // gateway, so there is nothing local to run. Opening is not connecting: the HTTPS
  // page blocks ws:// as mixed content, so without TLS it cannot reach the gateway.
  // The local UI (if built) stays as a printed fallback.
  const opened = params.openBrowser && (params.open ?? openUrl)(connectUrl);
  params.output.write(`${green(params.status)} ${dim(`pid ${params.pid}`)}\n`);
  params.output.write(`  ${dim('dashboard')}      ${cyan(hostedDashboard)}\n`);
  if (opened) {
    params.output.write(
      `  ${dim('browser')}        opened the auto-connect link${params.tlsPort ? '' : dim(' (the HTTPS page needs wss:// to connect: farmslot certs setup)')}\n`,
    );
  }
  if (params.printConnectUrl) {
    params.output.write(
      `  ${dim('connect url')}    ${cyan(connectUrl)} ${dim(token ? '(contains the gateway token)' : '(sign in separately in this browser)')}\n`,
    );
  } else {
    const portFlag = params.port === DEFAULT_GATEWAY_PORT ? '' : ` --port ${params.port}`;
    params.output.write(
      `  ${dim('connect url')}    ${dim(`run \`farmslot up${portFlag} --print-connect-url\` for the auto-connect link (it contains the gateway token)`)}\n`,
    );
  }
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
// metrics). It connects over loopback with a node credential. There is no separate
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
      FARMSLOT_NODE_TOKEN: token,
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
  printConnectUrl: boolean,
  startNode: boolean,
): Promise<void> {
  // TLS is opt-in: present only after `farmslot certs setup`. When it resolves,
  // the gateway also serves wss:// (on tls.port) and the hosted-CC connect payload
  // leads with the wss:// candidate. Absent, everything stays ws:// as before.
  const tls = resolveGatewayTls();

  // Don't silently ignore a half-set env config: without both vars TLS stays off,
  // and the spawned gateway never sees the half-config to teach it, so warn here.
  const tlsCertEnv = process.env.FARMSLOT_GATEWAY_TLS_CERT?.trim();
  const tlsKeyEnv = process.env.FARMSLOT_GATEWAY_TLS_KEY?.trim();
  if (!tls && Boolean(tlsCertEnv) !== Boolean(tlsKeyEnv)) {
    const missing = tlsCertEnv ? 'FARMSLOT_GATEWAY_TLS_KEY' : 'FARMSLOT_GATEWAY_TLS_CERT';
    output.write(
      `${yellow('  gateway TLS half-configured')} ${dim(
        `— ${missing} is not set; serving ws:// only. Set both (or run \`farmslot certs setup\`).`,
      )}\n`,
    );
  }

  const existingPid = readPid();
  if (existingPid && isAlive(existingPid)) {
    if (await waitForHealth(port, 2000)) {
      const credential = ensureLocalCredential(port);
      await verifyTokenAuth(port, credential, output);
      const localActive = registerLocalProfile(port, credential);
      if (startNode)
        await startLocalNode(port, await localNodeCredential(port, credential), output);
      writeUpResult({
        output,
        status: 'gateway already running',
        pid: existingPid,
        port,
        token: credential.personSession ? undefined : credential.token,
        pairingCode: await startupBrowserInvitation(
          port,
          credential,
          openBrowser || printConnectUrl,
        ),
        localActive,
        dashboardBuilt: existsSync(UI_DIST_INDEX),
        openBrowser,
        printConnectUrl,
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

  const credential = ensureLocalCredential(port);
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
  closeSync(logFd);
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
  let localActive: boolean;
  try {
    await verifyTokenAuth(port, credential, output);
    localActive = registerLocalProfile(port, credential);
    if (startNode) await startLocalNode(port, await localNodeCredential(port, credential), output);
  } catch (error) {
    if (!hasAuthErrorCode(error, 'AUTH_PERSON_SESSION_REQUIRED')) {
      await killGracefully(child.pid);
      rmSync(pidFilePath(), { force: true });
    }
    throw error;
  }

  writeUpResult({
    output,
    status: 'gateway up',
    pid: child.pid,
    port,
    token: credential.personSession ? undefined : credential.token,
    pairingCode: await startupBrowserInvitation(port, credential, openBrowser || printConnectUrl),
    localActive,
    dashboardBuilt: existsSync(UI_DIST_INDEX),
    openBrowser,
    printConnectUrl,
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
    .option('--port <port>', 'gateway port', String(DEFAULT_GATEWAY_PORT))
    .option('--no-open', 'print Command Center URLs without opening a browser')
    .option(
      '--print-connect-url',
      'also print the auto-connect Command Center link (contains the gateway token)',
    )
    .option('--no-node', 'do not co-launch the local node (degraded: no device feed/file-watch)')
    .action(
      async (
        opts: { port: string; open?: boolean; node?: boolean; printConnectUrl?: boolean },
        cmd: Command,
      ) => {
        const output = new OutputContext(cmd.optsWithGlobals().json ?? false);
        const startNode = opts.node !== false && process.env.FARMSLOT_SKIP_LOCAL_NODE !== '1';
        await up(
          Number(opts.port),
          output,
          opts.open !== false && !output.json,
          opts.printConnectUrl === true,
          startNode,
        );
      },
    );

  program
    .command('down')
    .description('Stop the local gateway started by farmslot up')
    .action(async (_opts: unknown, cmd: Command) => {
      const output = new OutputContext(cmd.optsWithGlobals().json ?? false);
      await down(output);
    });
}

async function startupBrowserInvitation(
  port: number,
  credential: GatewayCredential,
  requested: boolean,
): Promise<string | undefined> {
  if (!requested || !credential.personSession) return undefined;
  const client = new GatewayClient({ url: `ws://localhost:${port}`, timeout: 5000, credential });
  try {
    const invitation = await client.call<PairingCreateResult>('pairing.create', {
      gatewayUrl: `ws://localhost:${port}`,
      authority: {
        kind: 'existing-principal',
        principalId: credential.personSession.session.principalId,
      },
    });
    return invitation.code;
  } catch (error) {
    if (
      error instanceof GatewayConnectionError ||
      (error instanceof GatewayRpcError && error.code === 'AUTH_FORBIDDEN')
    ) {
      // The daemon remains usable. The opened browser asks for its own sign-in when
      // this caller cannot issue an invitation or a deploy interrupts that optional handoff.
      return undefined;
    }
    throw error;
  }
}
