// Process lifecycle for proofs that start their own gateway and node: each workspace process runs
// detached in its own group with its log in the evidence directory, is stopped by group (SIGKILL
// after 5 s), and the proof's cleanup runs once on its normal exit or on SIGINT/SIGTERM from a
// cancelled or timed-out recipe.
import { type ChildProcess, spawn } from 'node:child_process';
import { once } from 'node:events';
import { closeSync, openSync } from 'node:fs';
import { createServer } from 'node:net';
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
