// An isolated gateway plus a node agent whose slots the gateway treats as remote, for proofs that
// restart either of them. Everything lives in one fixture under /tmp that the stack owns: its own
// FARMSLOT_ROOT/HOME/RUNS/POOL/PROJECTS, an ephemeral port (never 7801), a private tmux server, a
// node credential this gateway issued, a `gh` that refuses every call, and ssh/scp/rsync shims
// bound to `<machine>.invalid` that act locally for that host only. The gateway's pool names the
// slots' host as `<machine>.invalid`, so every slot command routes through the node, as it does
// for a real remote node; the node's own pool calls them local.
//
// Holds: a test parks a step by creating a marker under `holds/`. `git` waits while `holds/git`
// exists; ssh waits while `holds/ssh` exists and the remote command contains the marker's text;
// the codex reviewer's output waits while `holds/review` exists (see CODEX_PROXY). Each records
// a `<marker>.hit` file when a call is held. Workers can hold on their own markers under `holds/`.
import { type ChildProcess, execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import {
  appendFile,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  realpath,
  rm,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { userInfo } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import {
  GatewayClient,
  GatewayConnectionError,
  type GatewayConnection,
} from '../../../packages/cli/src/gateway-client.js';
import { RUNNER_OBSERVABILITY_SUPPORT_PATHS } from '../../../services/gateway/src/runners/runner-observability.js';
import {
  testGatewayIdentity,
  testGatewayProfile,
} from '../../lib/test-gateway-identity-source.mjs';

import {
  freePort,
  poll,
  type Reaper,
  startWorkspaceProcess,
  stopProcess,
  writeJson,
} from './isolated-stack.mjs';

const LIVE_PORT = 7801;
const OWNER = 'test-automation';

export interface ProjectPack {
  name: string;
  /** project.json; `repo_url` and `node_support` are filled in by the stack. */
  projectJson: Record<string, unknown>;
  /** Pack files relative to the project directory. */
  files: Record<string, string>;
}

export interface RemoteNodeStackOptions {
  /** The checkout under test. */
  root: string;
  evidence: string;
  machine: string;
  /** Slot ids; each starts with `<project>-` and belongs to that project's pool. */
  slots: string[];
  /** The packs, given the stack's holds directory. */
  projects: (holds: string) => ProjectPack[];
  /** Files of the seed repository the slots clone. */
  seed: Record<string, string>;
  /** Node CLI snapshots by commit, reused across runs. */
  cliSnapshots: string;
  /** Written to `<fixture>/.owner`, so an outside sweep can match a stack it owns. */
  ownerTag: string;
  reaper: Reaper;
  log: (event: string, detail?: Record<string, unknown>) => Promise<void>;
}

export interface RemoteNodeStack {
  fixture: string;
  holds: string;
  slotRepo(slotId: string): string;
  connection(): GatewayConnection;
  call<T>(method: string, params?: unknown): Promise<T>;
  /** Stops the gateway; with `nodeAwayMs`, stops the node first and starts it that long after
   * the new gateway is ready. `whileDown` runs between the stop and the start. */
  restartGateway(options: {
    nodeAwayMs?: number;
    whileDown?: () => Promise<void>;
  }): Promise<{ downMs: number; nodeOfflineMs?: number }>;
  waitForNode(connected: boolean, budgetMs?: number): Promise<void>;
  cleanup(): Promise<string[]>;
}

/** Inherited env minus anything that could point a child at live state or carry a provider token. */
function childEnv(fakeBin: string, tmuxDir: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    // TSX_TSCONFIG_PATH is the driver's own source mapping; children use their workspace's.
    if (/^(FARMSLOT_|GATEWAY_|TMUX|TSX_)/.test(key)) continue;
    // The reviewer reaches its model through the local LB with this key; other tokens stay out.
    if (key !== 'CODEX_LB_API_KEY' && /^(GH_|GITHUB_|NPM_)|_TOKEN$|_PAT$|_API_KEY/.test(key))
      continue;
    env[key] = value;
  }
  env.PATH = `${fakeBin}${path.delimiter}${process.env.PATH}`;
  env.TMUX_TMPDIR = tmuxDir;
  env.GIT_TERMINAL_PROMPT = '0';
  return env;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();
}

function which(binary: string, env: NodeJS.ProcessEnv): string {
  const found = execFileSync('sh', ['-c', `command -v ${binary}`], {
    encoding: 'utf8',
    env,
  }).trim();
  if (!found) throw new Error(`${binary} is not on PATH`);
  // An asdf shim needs the shim's own environment; the proxy runs the selected binary directly.
  if (found.includes('/.asdf/shims/'))
    return execFileSync('asdf', ['which', binary], { encoding: 'utf8', env }).trim();
  return found;
}

// ---------------------------------------------------------------- fixture scripts

const remoteShim = (
  proofHost: string,
  nodeUserHome: string,
  log: string,
  holds: string,
) => `'use strict';
// Restart-invariant shim: local ssh/scp/rsync for ${proofHost} only. Never calls a real ssh.
const { spawnSync } = require('node:child_process');
const { appendFileSync, existsSync, readFileSync } = require('node:fs');
const HOST = ${JSON.stringify(proofHost)};
const HOLD = ${JSON.stringify(path.join(holds, 'ssh'))};
const [tool, ...args] = process.argv.slice(2);
appendFileSync(${JSON.stringify(log)}, JSON.stringify({ at: new Date().toISOString(), tool, args }) + '\\n');
const isTarget = (value) => value === HOST || value.endsWith('@' + HOST);
const refuse = (why) => { process.stderr.write('restart-invariant shim refused ' + tool + ': ' + why + '\\n'); process.exit(255); };
// The "remote" side is the stack's node: its HOME, never this host's.
const NODE_HOME = ${JSON.stringify(nodeUserHome)};
const local = (value) => {
  const match = /^([^/:]+):(.*)$/.exec(value);
  if (!match) return value;
  if (!isTarget(match[1])) refuse('remote ' + match[1]);
  return match[2].replace(/^~(?=\\/|$)/, NODE_HOME);
};
const run = (cmd, argv) =>
  process.exit(spawnSync(cmd, argv, { stdio: 'inherit', env: { ...process.env, HOME: NODE_HOME } }).status ?? 1);
const withValue = new Set(['-o', '-p', '-P', '-i', '-l', '-F', '-E', '-J', '-b', '-c', '-D', '-L', '-R', '-W', '-w', '-S', '-O', '-Q', '-m']);
if (tool === 'ssh') {
  let index = 0;
  while (index < args.length && args[index].startsWith('-')) index += withValue.has(args[index]) ? 2 : 1;
  if (!isTarget(args[index] ?? '')) refuse('host ' + (args[index] ?? '(none)'));
  const command = args.slice(index + 1).join(' ');
  // A held command waits while the marker exists and names it (15 min ceiling).
  const marker = existsSync(HOLD) ? readFileSync(HOLD, 'utf8').trim() : '';
  if (marker && command.includes(marker)) {
    appendFileSync(HOLD + '.hit', command.slice(0, 300) + '\\n');
    const until = Date.now() + 15 * 60_000;
    while (existsSync(HOLD) && Date.now() < until) spawnSync('sleep', ['0.1']);
  }
  run('/bin/bash', ['-c', command]);
} else if (tool === 'scp') {
  const paths = [];
  for (let index = 0; index < args.length; index++) {
    if (withValue.has(args[index])) index++;
    else if (!args[index].startsWith('-')) paths.push(local(args[index]));
  }
  run('/bin/cp', ['-R', ...paths]);
} else if (tool === 'rsync') {
  const kept = [];
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '-e' || args[index] === '--rsh') index++;
    else if (args[index].startsWith('--rsh=') || args[index].startsWith('-e')) continue;
    else kept.push(args[index].startsWith('-') ? args[index] : local(args[index]));
  }
  run('/usr/bin/rsync', kept);
} else refuse('unknown tool');
`;

const gitHold = (realGit: string, holds: string) =>
  [
    '#!/bin/sh',
    '# Restart-invariant hold: while holds/git exists every git call waits (15 min ceiling).',
    `if [ -e ${JSON.stringify(path.join(holds, 'git'))} ]; then`,
    `  printf '%s\\n' "$PWD git $*" >> ${JSON.stringify(path.join(holds, 'git.hit'))}`,
    '  i=0',
    `  while [ -e ${JSON.stringify(path.join(holds, 'git'))} ] && [ $i -lt 9000 ]; do sleep 0.1; i=$((i+1)); done`,
    'fi',
    `exec ${JSON.stringify(realGit)} "$@"`,
    '',
  ].join('\n');

// The reviewer stays a real codex review. Once a `turn/start` request has been answered (the node
// has accepted the reviewer's command), codex's further output waits while holds/review exists,
// so the gateway sees a live, accepted reviewer that cannot finish until the hold is released.
// Requests are answered before the hold, so no native request times out (30 s). `turn/started`
// passes through. Every other invocation (--version, login status) runs codex directly.
const codexProxy = (realCodex: string, holds: string) => `'use strict';
const { spawn, spawnSync } = require('node:child_process');
const { appendFileSync, existsSync } = require('node:fs');
const REAL = ${JSON.stringify(realCodex)};
const HOLD = ${JSON.stringify(path.join(holds, 'review'))};
const args = process.argv.slice(2);
if (!args.includes('app-server'))
  process.exit(spawnSync(REAL, args, { stdio: 'inherit' }).status ?? 1);
const child = spawn(REAL, args, { stdio: ['pipe', 'pipe', 'inherit'] });
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, () => child.kill(signal));
const turnStarts = new Set();
let input = '';
process.stdin.on('data', (chunk) => {
  child.stdin.write(chunk);
  input += chunk;
  for (let end; (end = input.indexOf('\\n')) >= 0; input = input.slice(end + 1)) {
    try {
      const message = JSON.parse(input.slice(0, end));
      if (message.method === 'turn/start' && message.id !== undefined) turnStarts.add(String(message.id));
    } catch {}
  }
});
process.stdin.on('end', () => child.stdin.end());
let held = null;
const release = () => {
  if (existsSync(HOLD) && Date.now() < held.until) return;
  clearInterval(held.timer);
  for (const line of held.lines) process.stdout.write(line);
  held = null;
};
let output = '';
child.stdout.on('data', (chunk) => {
  output += chunk;
  for (let end; (end = output.indexOf('\\n')) >= 0; output = output.slice(end + 1)) {
    const line = output.slice(0, end + 1);
    let message;
    try { message = JSON.parse(line); } catch { message = {}; }
    if (held && message.method !== 'turn/started') { held.lines.push(line); continue; }
    process.stdout.write(line);
    if (!held && message.id !== undefined && message.method === undefined && turnStarts.has(String(message.id)) && existsSync(HOLD)) {
      appendFileSync(HOLD + '.hit', new Date().toISOString() + ' turn ' + message.id + '\\n');
      held = { lines: [], until: Date.now() + 20 * 60_000 };
      held.timer = setInterval(release, 100);
    }
  }
});
child.on('exit', (code, signal) => {
  if (held) { clearInterval(held.timer); for (const line of held.lines) process.stdout.write(line); }
  process.exitCode = code ?? (signal ? 1 : 0);
});
`;

// ---------------------------------------------------------------- the stack

export async function startRemoteNodeStack(
  options: RemoteNodeStackOptions,
): Promise<RemoteNodeStack> {
  const { root, evidence, machine, reaper, log } = options;
  // /tmp keeps unix socket paths (tmux, native host) under the macOS 104-byte limit; the real
  // path (/private/tmp) because node-side checks compare realpaths of slot checkouts.
  const fixture = await realpath(await mkdtemp('/tmp/ri-'));
  reaper.path(fixture);
  const home = path.join(fixture, 'home');
  const nodeHome = path.join(fixture, 'node-home');
  const nodeNativeRoot = path.join(nodeHome, 'native-sessions');
  const gatewayNativeRoot = path.join(home, 'native-sessions');
  // The node's HOME: remote slot commands use ~/farmslot-node and its support store, which the
  // host's real node shares with the live fleet. This one links only the runner logins and the
  // toolchain. The gateway's HOME has no runner logins, so its own helpers find no credentials.
  const nodeUserHome = path.join(fixture, 'node-user-home');
  const gatewayUserHome = path.join(fixture, 'gateway-user-home');
  const tmuxDir = path.join(fixture, 'tmux');
  const fakeBin = path.join(fixture, 'bin');
  const holds = path.join(fixture, 'holds');
  const origin = path.join(fixture, 'origin.git');
  const nodePoolDir = path.join(fixture, 'node-pool');
  const proofHost = `${machine}.invalid`;
  const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
  const tmuxSocket = path.join(tmuxDir, `tmux-${uid}`, 'default');
  const baseEnv = childEnv(fakeBin, tmuxDir);
  reaper.command(['tmux', 'kill-server'], baseEnv);
  // Native supervisors and runners are detached from the stack's groups; they all name the fixture.
  reaper.command(['pkill', '-KILL', '-f', fixture], baseEnv);
  const createdLinks: string[] = [];
  const link = async (target: string, at: string) => {
    await symlink(target, at);
    createdLinks.push(at);
  };
  let gateway: ChildProcess | undefined;
  let node: ChildProcess | undefined;
  let connection: GatewayConnection | undefined;
  const nativeHostPids = () =>
    [nodeNativeRoot, gatewayNativeRoot].flatMap((rootDir) => {
      const files = [path.join(rootDir, 'host.json')];
      const nodes = path.join(rootDir, 'nodes');
      if (existsSync(nodes))
        for (const entry of readdirSync(nodes)) files.push(path.join(nodes, entry, 'host.json'));
      return files.flatMap((file) => {
        if (!existsSync(file)) return [];
        const pid = (JSON.parse(readFileSync(file, 'utf8')) as { pid?: unknown }).pid;
        return typeof pid === 'number' ? [pid] : [];
      });
    });
  /** Stops everything the stack started and removes the fixture; returns what went wrong. */
  const cleanup = async (): Promise<string[]> => {
    const errors: string[] = [];
    const attempt = async (label: string, operation: () => Promise<unknown>) => {
      try {
        await operation();
      } catch (error) {
        errors.push(`${label}: ${String(error)}`);
      }
    };
    connection?.close();
    connection = undefined;
    await attempt('node', () => stopProcess(node));
    for (const pid of nativeHostPids())
      await attempt(`native host ${pid}`, async () => {
        process.kill(pid, 'SIGTERM');
        await poll(
          `native host ${pid} to stop`,
          async () => (alive(pid) ? undefined : true),
          15_000,
        );
      });
    await attempt('gateway', () => stopProcess(gateway));
    await attempt('tmux', async () => {
      if (existsSync(tmuxSocket))
        execFileSync('tmux', ['-S', tmuxSocket, 'kill-server'], { stdio: 'ignore' });
    });
    // Anything left that names the fixture (runners, held fixture calls) is reported and killed.
    await attempt('leftovers', async () => {
      const left = execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' })
        .split('\n')
        .map((line) => line.trim().match(/^(\d+)\s+(.*)$/))
        .filter((match): match is RegExpMatchArray => Boolean(match))
        .filter((match) => match[2]!.includes(fixture) && Number(match[1]) !== process.pid);
      for (const match of left) {
        errors.push(`leftover ${match[1]} ${match[2]!.slice(0, 160)}`);
        try {
          process.kill(Number(match[1]), 'SIGKILL');
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
        }
      }
    });
    // Drop the links into the real home first, so no removal below can reach their targets.
    for (const at of createdLinks)
      if ((await lstat(at).catch(() => undefined))?.isSymbolicLink()) await unlink(at);
    await attempt('fixture', () => rm(fixture, { recursive: true, force: true }));
    return errors;
  };

  try {
    // ---- FARMSLOT_ROOT: the gateway reads its own branch at boot, so it is a checkout.
    execFileSync('git', ['clone', '-q', '--shared', '--no-checkout', root, fixture], {
      stdio: 'pipe',
    });
    await writeFile(
      path.join(fixture, '.owner'),
      `restart-invariant ${options.ownerTag} ${process.pid}\n`,
    );
    for (const name of ['scripts', 'services', 'packages', 'node_modules'])
      await symlink(path.join(root, name), path.join(fixture, name));
    // Node support bundles must resolve inside FARMSLOT_ROOT: give those paths real copies.
    for (const relative of RUNNER_OBSERVABILITY_SUPPORT_PATHS)
      await materialize(root, fixture, relative);
    await writeFile(path.join(fixture, 'CLAUDE.md'), '# Isolated restart-invariant fixture\n');
    // The no-checkout clone has no .gitignore; pack ownership depends on it.
    await cp(path.join(root, '.gitignore'), path.join(fixture, '.gitignore'));
    await mkdir(path.join(home, 'run-archive'), { recursive: true, mode: 0o700 });
    await mkdir(nodeHome, { recursive: true, mode: 0o700 });
    for (const name of ['pool', 'node-pool', 'runs', 'slots', 'bin', 'holds'])
      await mkdir(path.join(fixture, name));
    await mkdir(tmuxDir, { mode: 0o700 });

    // ---- homes
    const realHome = userInfo().homedir;
    const homeLinks: Array<[string, string[]]> = [
      [nodeUserHome, ['.codex', '.claude', '.claude.json', '.asdf', '.tool-versions']],
      [gatewayUserHome, ['.asdf', '.tool-versions']],
    ];
    for (const [userHome, names] of homeLinks) {
      await mkdir(userHome, { recursive: true, mode: 0o700 });
      for (const name of names)
        if (existsSync(path.join(realHome, name)))
          await link(path.join(realHome, name), path.join(userHome, name));
    }
    // Node commands run through a login shell, where /etc/zprofile reorders PATH. A real node's
    // profile then puts asdf first; this one does the same and keeps the fixture bin first.
    await writeFile(
      path.join(nodeUserHome, '.zprofile'),
      `export PATH=${JSON.stringify(`${fakeBin}:${path.join(nodeUserHome, '.asdf', 'shims')}`)}:"$PATH"\n`,
    );
    // ~/farmslot-node is the node's deployment: for this node, the checkout under test.
    await mkdir(path.join(nodeUserHome, 'farmslot-node'));
    for (const name of ['scripts', 'packages', 'services', 'node_modules'])
      await link(path.join(root, name), path.join(nodeUserHome, 'farmslot-node', name));
    // The node's installed CLI: an immutable snapshot of the checkout, which task pinning requires.
    await mkdir(path.join(nodeUserHome, '.local', 'bin'), { recursive: true });
    await link(
      path.join(
        await ensureCliSnapshot(root, options.cliSnapshots, evidence, log),
        'packages/cli/bin/farmslot.mjs',
      ),
      path.join(nodeUserHome, '.local', 'bin', 'farmslot'),
    );

    // ---- fixture bin: nothing reaches GitHub, ssh stays local, holds are inert until armed.
    await writeFile(
      path.join(fakeBin, 'gh'),
      '#!/bin/sh\necho "restart-invariant: gh is disabled in the isolated stack" >&2\nexit 2\n',
      { mode: 0o755 },
    );
    await writeFile(
      path.join(fakeBin, 'remote-shim.cjs'),
      remoteShim(proofHost, nodeUserHome, path.join(fixture, 'remote-shim.log'), holds),
    );
    for (const tool of ['ssh', 'scp', 'rsync'])
      await writeFile(
        path.join(fakeBin, tool),
        `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(path.join(fakeBin, 'remote-shim.cjs'))} ${tool} "$@"\n`,
        { mode: 0o755 },
      );
    await writeFile(path.join(fakeBin, 'git'), gitHold(which('git', process.env), holds), {
      mode: 0o755,
    });
    await writeFile(
      path.join(fakeBin, 'codex-proxy.cjs'),
      codexProxy(which('codex', process.env), holds),
    );
    await writeFile(
      path.join(fakeBin, 'codex'),
      `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(path.join(fakeBin, 'codex-proxy.cjs'))} "$@"\n`,
      { mode: 0o755 },
    );

    // ---- origin and slots
    const seed = path.join(fixture, 'seed');
    for (const [file, content] of Object.entries(options.seed)) {
      await mkdir(path.dirname(path.join(seed, file)), { recursive: true });
      await writeFile(path.join(seed, file), content);
    }
    git(seed, 'init', '-q', '-b', 'main');
    git(seed, 'add', '-A');
    git(
      seed,
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      'commit',
      '-q',
      '-m',
      'fixture: seed',
    );
    git(fixture, 'clone', '-q', '--bare', seed, origin);
    const slotRepo = (slotId: string) => path.join(fixture, 'slots', slotId);
    for (const slotId of options.slots) {
      git(fixture, 'clone', '-q', origin, slotRepo(slotId));
      git(slotRepo(slotId), 'config', 'user.name', 'Fixture Worker');
      git(slotRepo(slotId), 'config', 'user.email', 'fixture@example.invalid');
      await appendFile(path.join(slotRepo(slotId), '.git', 'info', 'exclude'), '.task/\n.agent/\n');
    }

    // ---- projects and pools
    for (const pack of options.projects(holds)) {
      const dir = path.join(fixture, 'projects', pack.name);
      for (const [file, content] of Object.entries(pack.files)) {
        await mkdir(path.dirname(path.join(dir, file)), { recursive: true });
        await writeFile(path.join(dir, file), content);
      }
      await writeJson(path.join(dir, 'project.json'), {
        ...pack.projectJson,
        name: pack.name,
        repo_url: origin,
        default_branch: 'main',
        // Scripted command mode reads the command from the node's support bundle.
        node_support: { paths: [`projects/${pack.name}/project.json`] },
      });
      const pool = (host: string) => ({
        machine,
        host,
        ssh_user: userInfo().username,
        project: pack.name,
        platform: 'cli',
        os: process.platform,
        slots: options.slots
          .filter((slotId) => slotId.startsWith(`${pack.name}-`))
          .map((slotId) => ({
            id: slotId,
            enabled: true,
            mode: 'dispatch',
            repo: slotRepo(slotId),
            session: slotId,
            resources: {},
          })),
      });
      // Gateway view: not this host's name, so every slot command routes through the node.
      await writeJson(path.join(fixture, 'pool', `${pack.name}.json`), pool(proofHost));
      // Node view: its slots are local to it (node-side commands check this).
      await writeJson(path.join(nodePoolDir, `${pack.name}.json`), pool('localhost'));
    }

    // ---------------------------------------------------------------- processes
    let port = await freePort();
    while (port === LIVE_PORT) port = await freePort();
    const url = `ws://127.0.0.1:${port}`;
    const token = testGatewayIdentity(home);
    testGatewayProfile(home, url, token);
    let nodeToken = '';
    let gatewayGeneration = 0;
    let nodeGeneration = 0;

    const gatewayEnv = (): NodeJS.ProcessEnv => ({
      ...baseEnv,
      HOME: gatewayUserHome,
      FARMSLOT_ROOT: fixture,
      FARMSLOT_HOME: home,
      FARMSLOT_PROJECTS_DIR: path.join(fixture, 'projects'),
      FARMSLOT_POOL_DIR: path.join(fixture, 'pool'),
      FARMSLOT_RUNS_DIR: path.join(fixture, 'runs'),
      FARMSLOT_DISPATCH_QUEUE_FILE: path.join(fixture, 'queue.json'),
      FARMSLOT_NATIVE_STATE_DIR: gatewayNativeRoot,
      FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID: OWNER,
      FARMSLOT_GATEWAY_PROFILE: 'proof',
      FARMSLOT_DISPATCH_PRESSURE_ADMISSION: 'off',
      FARMSLOT_ENABLE_SCRIPTED_SCENARIOS: '1',
      FARMSLOT_DEMO_POOL: '0',
      GATEWAY_HOST: '127.0.0.1',
      GATEWAY_PORT: String(port),
    });
    const nodeEnv = (): NodeJS.ProcessEnv => ({
      ...baseEnv,
      FARMSLOT_ROOT: fixture,
      HOME: nodeUserHome,
      // A real node resolves node through asdf (~/.tool-versions); worker launch preflight checks it.
      PATH: `${fakeBin}${path.delimiter}${path.join(nodeUserHome, '.asdf', 'shims')}${path.delimiter}${process.env.PATH}`,
      FARMSLOT_HOME: nodeHome,
      FARMSLOT_NATIVE_STATE_DIR: nodeNativeRoot,
      FARMSLOT_POOL_DIR: nodePoolDir,
      FARMSLOT_PROJECTS_DIR: path.join(fixture, 'projects'),
      FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID: OWNER,
      FARMSLOT_NODE_TOKEN: nodeToken,
      FARMSLOT_GATEWAY_TOKEN: '',
      FARMSLOT_ENABLE_SCRIPTED_SCENARIOS: '1',
      GATEWAY_URL: url,
      MACHINE_NAME: machine,
      SCREEN_CONTROL_SOCKET: path.join(fixture, 'screen-control.sock'),
    });

    const startGateway = async () => {
      gatewayGeneration += 1;
      const log = `gateway-${gatewayGeneration}.log`;
      gateway = startWorkspaceProcess(
        { root, evidence, env: gatewayEnv() },
        '@farmslot/gateway',
        log,
      );
      reaper.group(gateway.pid);
      const client = new GatewayClient({ url, timeout: 30_000, credential: { token } });
      const started = gateway;
      connection = await poll(
        'the isolated gateway',
        async () => {
          if (started.exitCode !== null)
            throw new Error(`Isolated gateway exited (${started.exitCode}); see ${log}`);
          try {
            return await client.connect();
          } catch (error) {
            // Connection refusal is expected while the gateway starts on its isolated port.
            if (!(error instanceof GatewayConnectionError)) throw error;
            return undefined;
          }
        },
        120_000,
      );
    };
    const stopGateway = async () => {
      connection?.close();
      connection = undefined;
      await stopProcess(gateway);
    };
    const startNode = () => {
      nodeGeneration += 1;
      node = startWorkspaceProcess(
        { root, evidence, env: nodeEnv() },
        '@farmslot/node',
        `node-${nodeGeneration}.log`,
      );
      reaper.group(node.pid);
    };
    const call = <T,>(method: string, params?: unknown) => {
      if (!connection) throw new Error(`The isolated gateway is not connected (${method})`);
      return connection.call<T>(method, params);
    };
    const waitForNode = async (connected: boolean, budgetMs = 120_000) => {
      await poll(
        `node ${machine} to ${connected ? 'connect' : 'disconnect'}`,
        async () => {
          const { nodes } = await call<{ nodes: Array<{ machine: string }> }>('nodes.list');
          return nodes.some((entry) => entry.machine === machine) === connected ? true : undefined;
        },
        budgetMs,
      );
    };

    await startGateway();
    const { principal } = await call<{ principal: { id: string } }>('principal.create', {
      subject: { type: 'node', displayName: 'restart-invariant node', machine },
      roles: [],
    });
    await call('principal.bindNativeOwner', {
      nodePrincipalId: principal.id,
      ownerPrincipalId: OWNER,
    });
    const issued = await call<{ secret: string }>('credential.issue', {
      principalId: principal.id,
      displayName: 'restart-invariant node',
    });
    nodeToken = issued.secret;
    // The node loader prefers FARMSLOT_ROOT/.env over its env; the credential stays in the fixture.
    await writeFile(path.join(fixture, '.env'), `FARMSLOT_NODE_TOKEN=${nodeToken}\n`, {
      mode: 0o600,
    });
    startNode();
    await waitForNode(true);
    // The startup fleet refresh can still be running; FIND_SLOT reads the fleet snapshot.
    await call('fleet.refresh', {});
    await poll(
      'the fleet to list every slot',
      async () => {
        const { fleet } = await call<{ fleet: { slots: Array<{ slot: string }> } }>('fleet.status');
        return options.slots.every((slotId) => fleet.slots.some((slot) => slot.slot === slotId))
          ? true
          : undefined;
      },
      120_000,
    );
    await log('stack ready', { fixture, port, machine, slots: options.slots.length });

    return {
      fixture,
      holds,
      slotRepo,
      connection: () => {
        if (!connection) throw new Error('The isolated gateway is not connected');
        return connection;
      },
      call,
      waitForNode,
      async restartGateway({ nodeAwayMs, whileDown }) {
        const away = nodeAwayMs !== undefined;
        if (away) {
          await stopProcess(node);
          await waitForNode(false, 60_000);
        }
        const stoppedAt = Date.now();
        await stopGateway();
        await whileDown?.();
        await startGateway();
        const readyAt = Date.now();
        await log(`gateway ${gatewayGeneration} ready`, { nodeAway: away });
        if (!away) {
          await waitForNode(true);
          return { downMs: readyAt - stoppedAt };
        }
        // The node stays away for nodeAwayMs after the new gateway is ready.
        while (Date.now() - readyAt < nodeAwayMs) await delay(Math.min(200, nodeAwayMs));
        startNode();
        await waitForNode(true);
        return { downMs: readyAt - stoppedAt, nodeOfflineMs: Date.now() - readyAt };
      },
      cleanup,
    };
  } catch (error) {
    // A stack that failed to start stops what it did start before the caller sees the error.
    const errors = await cleanup();
    if (errors.length)
      throw new AggregateError([error, ...errors], `Stack startup failed: ${String(error)}`);
    throw error;
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Replace the fixture's symlinked path with a real copy, splitting symlinked parents into real dirs. */
async function materialize(root: string, fixture: string, relative: string) {
  const parts = relative.split('/');
  if (!existsSync(path.join(root, relative))) return;
  let current = fixture;
  for (let index = 0; index < parts.length; index++) {
    const next = path.join(current, parts[index]!);
    const source = path.join(root, ...parts.slice(0, index + 1));
    const stat = await lstat(next).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    });
    if (index === parts.length - 1) {
      if (stat?.isSymbolicLink()) await unlink(next);
      if (!stat || stat.isSymbolicLink())
        await cp(source, next, { recursive: true, dereference: true });
    } else if (stat?.isSymbolicLink()) {
      await unlink(next);
      await mkdir(next);
      for (const entry of await readdir(source))
        await symlink(path.join(source, entry), path.join(next, entry));
    }
    current = next;
  }
}

/**
 * A node CLI snapshot of the checkout, built the way scripts/lib/node-cli-refresh.sh builds one
 * on a node. It is the last commit that changed what the snapshot is built from, so a change to
 * runner-validation proofs alone reuses the previous one. Kept per commit under `store`.
 */
async function ensureCliSnapshot(
  root: string,
  store: string,
  evidence: string,
  log: RemoteNodeStackOptions['log'],
): Promise<string> {
  const sha = git(
    root,
    'log',
    '-1',
    '--format=%H',
    'HEAD',
    '--',
    'packages',
    'package.json',
    'yarn.lock',
    '.yarnrc.yml',
    '.yarn',
    'scripts',
    ':(exclude)scripts/runner-validation',
  );
  const snapshot = path.join(store, sha);
  if (existsSync(path.join(snapshot, 'DEPLOYED-REVISION.json'))) return snapshot;
  await log('building node CLI snapshot', { sha });
  await mkdir(store, { recursive: true });
  const partial = await mkdtemp(`${snapshot}.partial.`);
  const buildLog = path.join(evidence, 'cli-snapshot-build.log');
  const env = {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('TSX_'))),
    YARN_ENABLE_IMMUTABLE_INSTALLS: '1',
    COREPACK_ENABLE_DOWNLOAD_PROMPT: '0',
  };
  try {
    for (const command of [
      `git -C ${JSON.stringify(root)} archive --format=tar ${sha} | tar -xf -`,
      'yarn workspaces focus @farmslot/cli',
      'yarn workspace @farmslot/recipe-cli build',
    ])
      execFileSync('bash', ['-c', `${command} >> ${JSON.stringify(buildLog)} 2>&1`], {
        cwd: partial,
        env,
      });
  } catch (error) {
    await rm(partial, { recursive: true, force: true });
    throw new Error(`CLI snapshot build failed (see cli-snapshot-build.log): ${String(error)}`);
  }
  await writeFile(
    path.join(partial, 'DEPLOYED-REVISION.json'),
    `${JSON.stringify({ sha, sha256: '' }, null, 2)}\n`,
  );
  execFileSync('mv', [partial, snapshot]);
  await log('node CLI snapshot ready', { snapshot });
  return snapshot;
}
