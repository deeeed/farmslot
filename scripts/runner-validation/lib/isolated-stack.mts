// Process lifecycle for proofs that start their own gateway and node: each workspace process runs
// detached in its own group with its log in the evidence directory, is stopped by group (SIGKILL
// after 5 s), and the proof's cleanup runs once on its normal exit or on SIGINT/SIGTERM. A
// cancelled recipe SIGKILLs the proof's own group within a second, so a reaper outside that group
// finishes the cleanup whenever the proof dies before it.
import { type ChildProcess, spawn } from 'node:child_process';
import { once } from 'node:events';
import { closeSync, openSync } from 'node:fs';
import { createServer, type Socket } from 'node:net';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export async function freePort(): Promise<number> {
  const probe = createServer().listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const { port } = probe.address() as { port: number };
  await new Promise<void>((resolve, reject) =>
    probe.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}

/** `yarn workspace <name> start` from `root`, logging to `<evidence>/<log>`. */
export function startWorkspaceProcess(
  options: { root: string; evidence: string; env: NodeJS.ProcessEnv },
  workspace: string,
  log: string,
): ChildProcess {
  const fd = openSync(path.join(options.evidence, log), 'w', 0o600);
  const child = spawn('yarn', ['workspace', workspace, 'start'], {
    cwd: options.root,
    detached: true,
    stdio: ['ignore', fd, fd],
    env: options.env,
  });
  closeSync(fd);
  return child;
}

export async function stopProcess(child: ChildProcess | undefined): Promise<void> {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  const stopped = once(child, 'exit');
  process.kill(-child.pid, 'SIGTERM');
  if (!(await Promise.race([stopped.then(() => true), delay(5000).then(() => false)]))) {
    process.kill(-child.pid, 'SIGKILL');
    await stopped;
  }
}

export async function poll<T>(
  description: string,
  read: () => Promise<T | undefined>,
  timeoutMs: number,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${description}`);
    await delay(500);
  }
}

/**
 * Returns `cleanup` made idempotent. A signal runs it too, then fails the proof, so an
 * interrupted proof still stops everything it started.
 */
export function cleanupOnExit(cleanup: () => Promise<void>): () => Promise<void> {
  let running: Promise<void> | undefined;
  const run = () => (running ??= cleanup());
  for (const signal of ['SIGINT', 'SIGTERM'] as const)
    process.once(signal, () => {
      process.stderr.write(`${signal}: stopping the isolated stack\n`);
      void run()
        .catch((error: unknown) => process.stderr.write(`Cleanup failed: ${String(error)}\n`))
        .finally(() => process.exit(1));
    });
  return run;
}

type ReaperEntry =
  | { kind: 'group'; value: number }
  | { kind: 'command'; value: { argv: string[]; env: NodeJS.ProcessEnv } }
  | { kind: 'path'; value: string }
  | { kind: 'done' };

// Runs in its own process group. Its stdin is a pipe from the proof: an entry per owned resource,
// then 'done' once the proof cleaned up itself. If the pipe closes first, the proof died (a recipe
// cancel's SIGKILL included): stop the groups, run the commands, remove the paths.
const REAPER = String.raw`
const { execFileSync } = require('node:child_process');
const { rmSync } = require('node:fs');
const plan = { group: [], command: [], path: [] };
let done = false;
let pending = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  pending += chunk;
  for (let end; (end = pending.indexOf('\n')) >= 0; pending = pending.slice(end + 1)) {
    const entry = JSON.parse(pending.slice(0, end));
    if (entry.kind === 'done') done = true;
    else plan[entry.kind].push(entry.value);
  }
});
process.stdin.on('end', () => {
  if (done) return;
  const signal = (name) => {
    // ESRCH is the only expected failure: that group already exited.
    for (const group of plan.group) try { process.kill(-group, name); } catch {}
  };
  signal('SIGTERM');
  setTimeout(() => {
    signal('SIGKILL');
    for (const { argv, env } of plan.command)
      // The expected failure is a server that is already gone; there is nowhere to report others.
      try { execFileSync(argv[0], argv.slice(1), { env, stdio: 'ignore', timeout: 10000 }); } catch {}
    for (const path of plan.path) rmSync(path, { recursive: true, force: true });
  }, 3000);
});
`;

export interface Reaper {
  /** A detached process group to stop if the proof dies. */
  group(pid: number | undefined): void;
  command(argv: string[], env: NodeJS.ProcessEnv): void;
  path(path: string): void;
  /** The proof stopped everything itself: the reaper exits without touching anything. */
  done(): void;
}

export function startReaper(): Reaper {
  const reaper = spawn(process.execPath, ['-e', REAPER], {
    detached: true,
    stdio: ['pipe', 'ignore', 'ignore'],
  });
  reaper.unref();
  const pipe = reaper.stdin as Socket;
  pipe.unref();
  const send = (entry: ReaperEntry) => pipe.write(`${JSON.stringify(entry)}\n`);
  return {
    group: (pid) => {
      if (pid) send({ kind: 'group', value: pid });
    },
    command: (argv, env) => send({ kind: 'command', value: { argv, env } }),
    path: (path) => send({ kind: 'path', value: path }),
    done: () => {
      send({ kind: 'done' });
      pipe.end();
    },
  };
}
