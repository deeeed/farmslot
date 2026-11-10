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
import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, existsSync, openSync, readdirSync, readFileSync } from 'node:fs';
import {
  appendFile,
  copyFile,
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

import type { GatewayConnection } from '../../../packages/cli/src/gateway-client.js';
import { legacyCliBinDirs } from '../../../packages/protocol/src/node/farm-paths.js';
import { RUNNER_OBSERVABILITY_SUPPORT_PATHS } from '../../../services/gateway/src/runners/runner-observability.js';
import {
  testGatewayIdentity,
  testGatewayProfile,
} from '../../lib/test-gateway-identity-source.mjs';

import {
  alive,
  connectGateway,
  freePort,
  issueNodeCredential,
  linkCheckout,
  listProcesses,
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
  gatewayEnv?: NodeJS.ProcessEnv;
  /** Explicit provider environment for this disposable node; never loaded from credential files. */
  nodeEnv?: NodeJS.ProcessEnv;
  /** Exercise the default-off node link in this owned fixture only. */
  nodeLink?: boolean;
  machine: string;
  /** Slot ids; each starts with `<project>-` and belongs to that project's pool. */
  slots: string[];
  /** The packs, given the stack's holds directory. */
  projects: (holds: string) => ProjectPack[];
  /** Files of each project's repository, by project name; its slots clone it. */
  seeds: Record<string, Record<string, string>>;
  /** Untracked files written into a slot's checkout (git-excluded), given its id and the fixture. */
  slotFiles?: (slotId: string, fixture: string) => Record<string, string>;
  /** Fake runner binaries for the fixture's bin, given the stack's holds directory. */
  binFiles?: (holds: string) => Record<string, string>;
  /** Node CLI snapshots by commit, reused across runs. */
  cliSnapshots: string;
  /** A node CLI snapshot to use as is (a host's deployed one) instead of building one. */
  cliSnapshot?: string;
  /** Pin the disposable execution runtime instead of selecting host asdf shims. */
  nodeBin?: string;
  /** Written to `<fixture>/.owner`, so an outside sweep can match a stack it owns. */
  ownerTag: string;
  /** Owned transparent relay for deterministic node-closeout fault injection. */
  nodeProxy?: { start(gatewayUrl: string): Promise<string>; stop(): Promise<void> };
  reaper: Reaper;
  /** Given what stops the stack before anything starts, so a signal during startup can use it. */
  onCleanup?: (cleanup: () => Promise<string[]>) => void;
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
  restartNode(whileStopping: () => Promise<void>): Promise<void>;
  /** The panes of a tmux session on the stack's private server (none when it has no such session). */
  panes(session: string): Array<{ paneId: string; panePid: number; dead: boolean }>;
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
const refuse = (why) => { process.stderr.write('remote-node-stack shim refused ' + tool + ': ' + why + '\\n'); process.exit(255); };
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
    '# Restart-invariant hold: while holds/git exists, a git call whose "$PWD git $*" matches the',
    '# extended regex in it waits (15 min ceiling). Every call made while it exists is logged.',
    `hold=${JSON.stringify(path.join(holds, 'git'))}`,
    'if [ -e "$hold" ]; then',
    '  line="$PWD git $*"',
    `  printf '%s\\n' "$line" >> "$hold.seen"`,
    `  if printf '%s\\n' "$line" | grep -qE -- "$(cat "$hold" 2>/dev/null)"; then`,
    ...shellHold('"$line"'),
    '  fi',
    'fi',
    `exec ${JSON.stringify(realGit)} "$@"`,
    '',
  ].join('\n');

/** The hold's hit is logged, then the call waits while the hold file exists (15 min ceiling). */
const shellHold = (logged: string) => [
  `printf '%s\\n' ${logged} >> "$hold.hit"`,
  'i=0',
  'while [ -e "$hold" ] && [ $i -lt 9000 ]; do sleep 0.1; i=$((i+1)); done',
];

// Every tmux call that could stop a worker (a kill or respawn, C-c, /exit) is logged to
// holds/tmux-stops.log. While holds/tmux exists, a call whose arguments match the extended regex
// in it waits (15 min ceiling). A worker arms that hold itself by renaming holds/tmux.arm (slotCli).
const tmuxWatch = (realTmux: string, holds: string) =>
  [
    '#!/bin/sh',
    `holds=${JSON.stringify(holds)}`,
    'case " $* " in',
    '  *" kill-pane "*|*" kill-window "*|*" kill-session "*|*" respawn-pane "*|*" respawn-window "*|*" C-c "*|*"/exit"*)',
    `    printf '%s %s\\n' "$(date -u +%FT%TZ)" "$(printf '%s' "$*" | tr '\\n' ' ')" >> "$holds/tmux-stops.log" ;;`,
    'esac',
    'hold="$holds/tmux"',
    'if [ -e "$hold" ] && printf \'%s\\n\' "$*" | grep -qE -- "$(cat "$hold" 2>/dev/null)"; then',
    ...shellHold('"$*"'),
    'fi',
    `exec ${JSON.stringify(realTmux)} "$@"`,
    '',
  ].join('\n');

// The reviewer stays a real codex review. Once a `turn/start` request has been answered (the node
// has accepted the reviewer's command), codex's further output waits while holds/review exists,
// so the gateway sees a live, accepted reviewer that cannot finish until the hold is released.
// Requests are answered before the hold, so no native request times out (30 s). `turn/started`
// passes through. Every other invocation (--version, login status) runs codex directly.
// Each turn sent to codex is a model call and is logged to holds/model-calls.log. A hold whose
// marker reads `swallow` answers the turn itself instead: an accepted reviewer, no model call.
// Once the marker reads `complete`, the proxy ends every turn it swallowed (the test has written
// the reviewer's output by then) and logs `completed`; it still swallows any turn that starts then.
export const codexProxy = (realCodex: string, holds: string) => `'use strict';
const { spawn, spawnSync } = require('node:child_process');
const { appendFileSync, existsSync, readFileSync, writeFileSync, watch } = require('node:fs');
const path = require('node:path');
const REAL = ${JSON.stringify(realCodex)};
const HOLD = ${JSON.stringify(path.join(holds, 'review'))};
const CALLS = ${JSON.stringify(path.join(holds, 'model-calls.log'))};
const args = process.argv.slice(2);
if (!args.includes('app-server'))
  process.exit(spawnSync(REAL, args, { stdio: 'inherit' }).status ?? 1);
const child = spawn(REAL, args, { stdio: ['pipe', 'pipe', 'inherit'] });
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, () => child.kill(signal));
// The environment the reviewer's commands get, without secrets, for a test that answers its turn.
writeFileSync(HOLD + '-env.json', JSON.stringify(Object.fromEntries(Object.entries(process.env).filter(([key]) => !/KEY|TOKEN|SECRET|PASSWORD/i.test(key)))), { mode: 0o600 });
const turnStarts = new Set();
const marker = () => (existsSync(HOLD) ? readFileSync(HOLD, 'utf8').trim() : '');
const swallowed = [];
const completeReadyTurns = () => {
  if (!swallowed.length) return;
  const ready = swallowed.filter(({ thread }) => marker() === 'complete' || existsSync(HOLD + '.complete-' + thread));
  for (const { id, thread } of ready) {
    swallowed.splice(swallowed.findIndex(turn => turn.id === id), 1);
    process.stdout.write(JSON.stringify({ method: 'turn/completed', params: { turn: { id, status: 'completed' } } }) + '\\n');
    appendFileSync(HOLD + '.hit', new Date().toISOString() + ' completed\\n');
  }
};
const completionWatcher = watch(path.dirname(HOLD), (_event, file) => {
  if (file && (String(file) === 'review' || String(file).startsWith('review.complete-')))
    completeReadyTurns();
});
completionWatcher.unref();
let input = '';
process.stdin.on('data', (chunk) => {
  input += chunk;
  for (let end; (end = input.indexOf('\\n')) >= 0; input = input.slice(end + 1)) {
    const line = input.slice(0, end + 1);
    let message = {};
    try { message = JSON.parse(line); } catch {}
    if (message.method === 'turn/start' && message.id !== undefined) {
      if (marker() === 'swallow' || marker() === 'complete') {
        const id = 'swallowed-' + message.id;
        appendFileSync(HOLD + '.hit', new Date().toISOString() + ' turn ' + message.id + ' swallowed\\n');
        process.stdout.write(JSON.stringify({ id: message.id, result: { turn: { id } } }) + '\\n');
        process.stdout.write(JSON.stringify({ method: 'turn/started', params: { turn: { id } } }) + '\\n');
        const thread = message.params?.threadId;
        writeFileSync(HOLD + '.env-' + thread + '.json', JSON.stringify(Object.fromEntries(Object.entries(process.env).filter(([key]) => !/KEY|TOKEN|SECRET|PASSWORD/i.test(key)))), { mode: 0o600 });
        swallowed.push({ id, thread });
        completeReadyTurns();
        continue;
      }
      turnStarts.add(String(message.id));
      appendFileSync(CALLS, new Date().toISOString() + ' ' + process.pid + ' turn ' + message.id + '\\n');
    }
    child.stdin.write(line);
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
  completionWatcher.close();
  // The supervisor keeps stdin open until this process exits. Once the real
  // child has exited, stop reading so the proxy can exit and confirm cleanup.
  process.stdin.destroy();
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
  const nodePoolDir = path.join(fixture, 'node-pool');
  const proofHost = `${machine}.invalid`;
  const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
  const tmuxSocket = path.join(tmuxDir, `tmux-${uid}`, 'default');
  const baseEnv = childEnv(fakeBin, tmuxDir);
  // Only ever the stack's own socket: without -S a missing tmux directory falls back to /tmp.
  reaper.command(['tmux', '-S', tmuxSocket, 'kill-server'], baseEnv);
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
  const nativeHostDirectories = () =>
    [nodeNativeRoot, gatewayNativeRoot].flatMap((rootDir) => {
      const nodes = path.join(rootDir, 'nodes');
      return [
        rootDir,
        ...(existsSync(nodes) ? readdirSync(nodes).map((entry) => path.join(nodes, entry)) : []),
      ];
    });
  /** Stops everything the stack started and removes the fixture; returns what went wrong. */
  const stopAll = async (): Promise<string[]> => {
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
    await attempt('node proxy', async () => options.nodeProxy?.stop());
    const nativeDirectories = nativeHostDirectories();
    for (const directory of nativeDirectories) {
      const file = path.join(directory, 'host.json');
      if (!existsSync(file)) continue;
      const pid = (JSON.parse(readFileSync(file, 'utf8')) as { pid?: unknown }).pid;
      if (typeof pid !== 'number') continue;
      await attempt(`native host ${pid}`, async () => {
        process.kill(pid, 'SIGTERM');
        await poll(
          `native host ${pid} to stop`,
          async () => (alive(pid) ? undefined : true),
          15_000,
        );
      });
    }
    await attempt('gateway', () => stopProcess(gateway));
    // A failed cold start may have only host.log. Keep it after the host stops,
    // before deleting the fixture, without copying credential-bearing host.json.
    for (const directory of nativeDirectories)
      await attempt('native host diagnostics', async () => {
        const file = path.join(directory, 'host.log');
        if (existsSync(file))
          await copyFile(
            file,
            path.join(
              evidence,
              `native-${path.relative(fixture, directory).split(path.sep).join('-')}.log`,
            ),
          );
      });
    await attempt('tmux', async () => {
      if (existsSync(tmuxSocket)) {
        try {
          execFileSync('tmux', ['-S', tmuxSocket, 'kill-server'], { stdio: 'ignore' });
        } catch (error) {
          // Cancellation can stop the private server before its socket disappears.
          // Only an already-empty owned fixture makes that cleanup complete.
          if (
            listProcesses().some(
              (entry) => entry.command.includes(fixture) && entry.pid !== process.pid,
            )
          )
            throw error;
        }
      }
    });
    // Anything left that names the fixture (runners, held fixture calls) is reported and killed.
    await attempt('leftovers', async () => {
      const left = listProcesses().filter(
        ({ pid, command }) => command.includes(fixture) && pid !== process.pid,
      );
      for (const { pid, command } of left) {
        errors.push(`leftover ${pid} ${command.slice(0, 160)}`);
        try {
          process.kill(pid, 'SIGKILL');
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
        }
      }
    });
    // Drop the links into the real home first, so no removal below can reach their targets.
    for (const at of createdLinks)
      if ((await lstat(at).catch(() => undefined))?.isSymbolicLink()) await unlink(at);
    // A process that exited during the removal can still write into it: remove until it stays gone.
    await attempt('fixture', async () => {
      const until = Date.now() + 5000;
      do {
        await rm(fixture, { recursive: true, force: true });
        await delay(250);
      } while (existsSync(fixture) && Date.now() < until);
      if (existsSync(fixture)) throw new Error(`${fixture} keeps reappearing`);
    });
    return errors;
  };
  let stopping: Promise<string[]> | undefined;
  const cleanup = () => (stopping ??= stopAll());
  options.onCleanup?.(cleanup);

  try {
    // ---- FARMSLOT_ROOT: the gateway reads its own branch at boot, so it is a checkout.
    await linkCheckout(root, fixture, 'Isolated remote-node stack fixture', {
      packageManager: false,
    });
    await writeFile(
      path.join(fixture, '.owner'),
      `remote-node-stack ${options.ownerTag} ${process.pid}\n`,
    );
    // Node support bundles must resolve inside FARMSLOT_ROOT: give those paths real copies.
    for (const relative of [
      'scripts/write-runtime-context.sh',
      ...RUNNER_OBSERVABILITY_SUPPORT_PATHS,
    ])
      await materialize(root, fixture, relative);
    // The no-checkout clone has no .gitignore; pack ownership depends on it.
    await cp(path.join(root, '.gitignore'), path.join(fixture, '.gitignore'));
    await mkdir(path.join(home, 'run-archive'), { recursive: true, mode: 0o700 });
    await mkdir(nodeHome, { recursive: true, mode: 0o700 });
    for (const name of ['pool', 'node-pool', 'runs', 'slots', 'bin', 'holds', 'origins', 'seeds'])
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
    const selectedNodePath = options.nodeBin ? `${options.nodeBin}:` : '';
    // Node commands run through a login shell, where /etc/zprofile reorders PATH. A real node's
    // profile puts asdf first; an explicitly pinned fixture runtime precedes those shims.
    await writeFile(
      path.join(nodeUserHome, '.zprofile'),
      `export PATH=${JSON.stringify(`${fakeBin}:${selectedNodePath}${path.join(nodeUserHome, '.asdf', 'shims')}`)}:"$PATH"\n`,
    );
    // Pane shells exit during cleanup; a history file written then would recreate the fixture.
    await writeFile(path.join(nodeUserHome, '.zshrc'), 'unset HISTFILE\n');
    // ~/farmslot-node is the node's deployment: for this node, the checkout under test.
    await mkdir(path.join(nodeUserHome, 'farmslot-node'));
    for (const name of ['scripts', 'packages', 'services'])
      await link(path.join(root, name), path.join(nodeUserHome, 'farmslot-node', name));
    // The node's installed CLI: an immutable snapshot of the checkout, which task pinning requires.
    await mkdir(path.join(nodeUserHome, '.local', 'bin'), { recursive: true });
    const cliSnapshot =
      options.cliSnapshot ??
      (await ensureCliSnapshot(
        root,
        options.cliSnapshots,
        path.join(fixture, 'cli-build-home'),
        evidence,
        log,
      ));
    // Helper resolution must use this node's built installation, including its runtime.
    await link(
      path.join(cliSnapshot, 'node_modules'),
      path.join(nodeUserHome, 'farmslot-node', 'node_modules'),
    );
    await link(
      path.join(cliSnapshot, 'packages/cli/bin/farmslot.mjs'),
      path.join(nodeUserHome, '.local', 'bin', 'farmslot'),
    );

    // ---- fixture bin: nothing reaches GitHub, ssh stays local, holds are inert until armed.
    await writeFile(
      path.join(fakeBin, 'gh'),
      '#!/bin/sh\necho "isolated stack: gh is disabled" >&2\nexit 2\n',
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
    await writeFile(path.join(fakeBin, 'tmux'), tmuxWatch(which('tmux', process.env), holds), {
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
    for (const [file, content] of Object.entries(options.binFiles?.(holds) ?? {}))
      await writeFile(path.join(fakeBin, file), content, { mode: 0o755 });

    // ---- origins (one per project) and slots
    const packs = options.projects(holds);
    const origin = (project: string) => path.join(fixture, 'origins', `${project}.git`);
    for (const pack of packs) {
      const seed = path.join(fixture, 'seeds', pack.name);
      for (const [file, content] of Object.entries(options.seeds[pack.name] ?? {})) {
        await mkdir(path.dirname(path.join(seed, file)), { recursive: true });
        await writeFile(path.join(seed, file), content);
      }
      git(fixture, 'init', '-q', '-b', 'main', seed);
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
      git(fixture, 'clone', '-q', '--bare', seed, origin(pack.name));
    }
    const slotRepo = (slotId: string) => path.join(fixture, 'slots', slotId);
    const projectOf = (slotId: string) => {
      const pack = packs.find((candidate) => slotId.startsWith(`${candidate.name}-`));
      if (!pack) throw new Error(`Slot ${slotId} belongs to no project`);
      return pack.name;
    };
    for (const slotId of options.slots) {
      git(fixture, 'clone', '-q', origin(projectOf(slotId)), slotRepo(slotId));
      git(slotRepo(slotId), 'config', 'user.name', 'Fixture Worker');
      git(slotRepo(slotId), 'config', 'user.email', 'fixture@example.invalid');
      const extra = options.slotFiles?.(slotId, fixture) ?? {};
      for (const [file, content] of Object.entries(extra)) {
        await mkdir(path.dirname(path.join(slotRepo(slotId), file)), { recursive: true });
        await writeFile(path.join(slotRepo(slotId), file), content, { mode: 0o755 });
      }
      await appendFile(
        path.join(slotRepo(slotId), '.git', 'info', 'exclude'),
        ['.task/', '.agent/', ...Object.keys(extra).map((file) => `/${file}`), ''].join('\n'),
      );
    }

    // ---- projects and pools
    for (const pack of packs) {
      const dir = path.join(fixture, 'projects', pack.name);
      for (const [file, content] of Object.entries(pack.files)) {
        await mkdir(path.dirname(path.join(dir, file)), { recursive: true });
        await writeFile(path.join(dir, file), content);
      }
      await writeJson(path.join(dir, 'project.json'), {
        ...pack.projectJson,
        name: pack.name,
        repo_url: origin(pack.name),
        default_branch: 'main',
      });
      const pool = (host: string) => ({
        machine,
        host,
        ssh_user: userInfo().username,
        project: pack.name,
        platform: 'cli',
        os: process.platform,
        // A fixture `claude` by its path: a login shell can put a real one first on PATH. Claude
        // launches only through dispatch_cmd, and no other runner's launch reads {claude_path}.
        ...(options.binFiles?.(holds).claude
          ? {
              claude_path: path.join(fakeBin, 'claude'),
              dispatch_cmd: 'cd {repo} && {claude_path} {safety_flags}',
            }
          : {}),
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

    if (options.nodeLink) {
      for (const [directory, host] of [
        [path.join(fixture, 'pool'), proofHost],
        [nodePoolDir, 'localhost'],
      ])
        await writeJson(path.join(directory, `${machine}.json`), {
          machine,
          host,
          ssh_user: userInfo().username,
          os: process.platform,
          slots: [],
          env: { FARMSLOT_NODE_LINK_ENABLED: '1' },
        });
    }

    // ---------------------------------------------------------------- processes
    let port = await freePort();
    while (port === LIVE_PORT) port = await freePort();
    const url = `ws://127.0.0.1:${port}`;
    const nodeGatewayUrl = options.nodeProxy ? await options.nodeProxy.start(url) : url;
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
      // The stack's writes are a few MB; the 50 GB production floor would refuse them on a
      // test host with less free, while 2 GB still keeps it from filling the disk.
      FARMSLOT_HEAVY_WRITE_FLOOR_GB: '2',
      FARMSLOT_ENABLE_SCRIPTED_SCENARIOS: '1',
      FARMSLOT_DEMO_POOL: '0',
      GATEWAY_HOST: '127.0.0.1',
      GATEWAY_PORT: String(port),
      ...options.gatewayEnv,
    });
    const nodeEnv = (): NodeJS.ProcessEnv => ({
      ...baseEnv,
      FARMSLOT_ROOT: fixture,
      HOME: nodeUserHome,
      // A real node resolves node through asdf (~/.tool-versions); worker launch preflight checks it.
      PATH: `${fakeBin}${path.delimiter}${selectedNodePath}${path.join(nodeUserHome, '.asdf', 'shims')}${path.delimiter}${process.env.PATH}`,
      FARMSLOT_HOME: nodeHome,
      FARMSLOT_NATIVE_STATE_DIR: nodeNativeRoot,
      FARMSLOT_POOL_DIR: nodePoolDir,
      FARMSLOT_PROJECTS_DIR: path.join(fixture, 'projects'),
      FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID: OWNER,
      FARMSLOT_NODE_TOKEN: nodeToken,
      FARMSLOT_GATEWAY_TOKEN: '',
      FARMSLOT_ENABLE_SCRIPTED_SCENARIOS: '1',
      ...(options.nodeBin ? { FARMSLOT_NODE22_BIN: options.nodeBin } : {}),
      GATEWAY_URL: nodeGatewayUrl,
      MACHINE_NAME: machine,
      SCREEN_CONTROL_SOCKET: path.join(fixture, 'screen-control.sock'),
      ...options.nodeEnv,
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
      connection = await connectGateway({ url, token, gateway, log, budgetMs: 120_000 });
    };
    const stopGateway = async () => {
      connection?.close();
      connection = undefined;
      await stopProcess(gateway);
    };
    const startNode = () => {
      if (stopping) throw new Error('The isolated node is stopping');
      nodeGeneration += 1;
      const fd = openSync(path.join(evidence, `node-${nodeGeneration}.log`), 'w', 0o600);
      try {
        // Exec requests without a cwd resolve helpers from this node's installation.
        node = spawn(
          process.execPath,
          ['--import', import.meta.resolve('tsx'), path.join(root, 'services/node/src/index.ts')],
          {
            cwd: path.join(nodeUserHome, 'farmslot-node'),
            env: {
              ...nodeEnv(),
              TSX_TSCONFIG_PATH: path.join(root, 'services/node/tsconfig.json'),
            },
            detached: true,
            stdio: ['ignore', fd, fd],
          },
        );
      } finally {
        closeSync(fd);
      }
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
    const nodeCredential = await issueNodeCredential(connection!, machine, 'isolated stack node');
    await call('principal.bindNativeOwner', {
      nodePrincipalId: nodeCredential.principalId,
      ownerPrincipalId: OWNER,
    });
    nodeToken = nodeCredential.secret;
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
      async restartNode(whileStopping) {
        const info = (
          await call<{ nodes: Array<{ machine: string; pid: number }> }>('nodes.list')
        ).nodes.find((entry) => entry.machine === machine);
        const parents = new Map(listProcesses().map((entry) => [entry.pid, entry.ppid]));
        let owner = info?.pid;
        while (owner && owner !== node?.pid) owner = parents.get(owner);
        if (!info || owner !== node?.pid) throw new Error('Node PID is not owned by this fixture');
        process.kill(info.pid, 'SIGTERM');
        await whileStopping();
        await poll('owned node closeout', async () => !alive(info.pid) || undefined, 15_000);
        await stopProcess(node);
        await waitForNode(false);
        startNode();
        await waitForNode(true);
      },
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
      panes(session) {
        // The real tmux on the stack's socket: the fixture's tmux logs and holds.
        let listed = '';
        try {
          listed = execFileSync(
            'tmux',
            [
              '-S',
              tmuxSocket,
              'list-panes',
              '-s',
              '-t',
              `=${session}`,
              '-F',
              '#{pane_id} #{pane_pid} #{pane_dead}',
            ],
            { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
          );
        } catch {
          // No such session (or no server yet): no panes.
        }
        return listed
          .split('\n')
          .filter(Boolean)
          .map((line) => {
            const [paneId, pid, dead] = line.split(' ');
            return { paneId: paneId!, panePid: Number(pid), dead: dead === '1' };
          });
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
 * A node CLI snapshot of the checkout, built by the deploy's own refresh script
 * (scripts/lib/node-cli-refresh.sh). It is the last commit that changed what the snapshot is built
 * from, so a change to runner-validation proofs alone reuses the previous one. Kept per commit
 * under `store`. The script swaps `$HOME/.local/bin/farmslot`, so it runs under `linkHome`, whose
 * link already names this snapshot: no real link moves and no other snapshot is pruned.
 */
async function ensureCliSnapshot(
  root: string,
  storeDir: string,
  linkHome: string,
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
  // The script compares its link with `$store/$sha/…` as text.
  const store = path.resolve(storeDir);
  const snapshot = path.join(store, sha);
  if (existsSync(path.join(snapshot, 'DEPLOYED-REVISION.json'))) return snapshot;
  await log('building node CLI snapshot', { sha });
  await mkdir(store, { recursive: true });
  const refresh = /CLI_REFRESH=\$\(cat << 'REFRESH'\n([\s\S]*?)\nREFRESH\n/.exec(
    readFileSync(path.join(root, 'scripts/lib/node-cli-refresh.sh'), 'utf8'),
  )?.[1];
  if (!refresh) throw new Error('scripts/lib/node-cli-refresh.sh has no refresh script');
  const archive = path.join(evidence, 'cli-snapshot.tar');
  execFileSync('git', ['-C', root, 'archive', '--format=tar', '-o', archive, sha]);
  const sha256 = createHash('sha256').update(readFileSync(archive)).digest('hex');
  await mkdir(path.join(linkHome, '.local', 'bin'), { recursive: true });
  await rm(path.join(linkHome, '.local', 'bin', 'farmslot'), { force: true });
  await symlink(
    path.join(snapshot, 'packages/cli/bin/farmslot.mjs'),
    path.join(linkHome, '.local', 'bin', 'farmslot'),
  );
  const buildLog = openSync(path.join(evidence, 'cli-snapshot-build.log'), 'a');
  const stdin = openSync(archive, 'r');
  const realHome = userInfo().homedir;
  try {
    execFileSync(
      'bash',
      [
        '-c',
        refresh,
        '_',
        store,
        sha,
        sha256,
        path.dirname(process.execPath),
        '600',
        path.join(linkHome, '.farmslot'),
        legacyCliBinDirs(linkHome)[0],
        'legacy',
        ...legacyCliBinDirs(linkHome),
      ],
      {
        stdio: [stdin, buildLog, buildLog],
        env: {
          ...Object.fromEntries(
            Object.entries(process.env).filter(([key]) => !key.startsWith('TSX_')),
          ),
          HOME: linkHome,
          // HOME is a scratch directory; the toolchain's caches stay where they are.
          COREPACK_HOME: process.env.COREPACK_HOME ?? path.join(realHome, '.cache/node/corepack'),
          YARN_GLOBAL_FOLDER: process.env.YARN_GLOBAL_FOLDER ?? path.join(realHome, '.yarn/berry'),
        },
      },
    );
  } catch (error) {
    throw new Error(`CLI snapshot build failed (see cli-snapshot-build.log): ${String(error)}`);
  } finally {
    closeSync(stdin);
    closeSync(buildLog);
    await rm(archive, { force: true });
  }
  await log('node CLI snapshot ready', { snapshot });
  return snapshot;
}
