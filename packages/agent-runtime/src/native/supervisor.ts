import { fork } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { socketDirectory } from './ipc.js';
import { NativeProcessTree } from './process-tree.js';
import {
  alive,
  appendDurable,
  durableWrite,
  matchesProcess,
  privateDirectory,
  readJournal,
  readJson,
  signalGroup,
} from './storage.js';

const root = process.argv[2]!;
process.umask(0o077);
privateDirectory(root);
const lock = join(root, 'lock');
// Serializes stale-lock reclamation as well as first start. A torn claim fails closed.
const claim = join(root, 'claim');
try {
  mkdirSync(claim, { mode: 0o700 });
} catch (error) {
  if ((error as NodeJS.ErrnoException).code === 'EEXIST') process.exit(0);
  throw error;
}
let acquired = false;
try {
  let occupied = false;
  if (existsSync(lock)) {
    const previous = readJson<{ pid: number }>(join(lock, 'owner.json'));
    occupied = alive(previous.pid);
    if (!occupied) {
      const previousHost = existsSync(join(root, 'worker.json'))
        ? readJson<{ pid: number }>(join(root, 'worker.json'))
        : undefined;
      if (previousHost && alive(previousHost.pid))
        throw new Error('Native host survived its supervisor; refusing competing ownership');
      const cleanupPath = join(root, 'cleanup.json');
      if (existsSync(cleanupPath) && readJson<{ state: string }>(cleanupPath).state !== 'complete')
        throw new Error(
          'Previous native cleanup is unresolved; verify owned processes before recovery',
        );
      rmSync(lock, { recursive: true });
    }
  }
  if (!occupied) {
    mkdirSync(lock, { mode: 0o700 });
    durableWrite(join(lock, 'owner.json'), { pid: process.pid });
    acquired = true;
  }
} finally {
  rmSync(claim, { recursive: true });
}
if (!acquired) process.exit(0);
rmSync(join(root, 'ready.json'), { force: true });
const socket = join(socketDirectory(root), 's');
privateDirectory(socketDirectory(root));
durableWrite(join(root, 'host.json'), {
  supportsEnsure: true,
  supportsWorkers: true,
  supportsWorkerResumeFence: true,
  supportsWorkerRelocation: true,
  supportsProfiles: true,
  executionNodeId: process.env.FARMSLOT_NATIVE_EXECUTION_NODE_ID ?? 'local',
  pid: process.pid,
  token: randomBytes(32).toString('hex'),
  socket,
});
const extension = import.meta.url.endsWith('.ts') ? 'ts' : 'js';
const child = fork(fileURLToPath(new URL(`./host.${extension}`, import.meta.url)), [root], {
  stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
});
let tree: NativeProcessTree | undefined;
let stopObservingTree: (() => void) | undefined;
let hostReleased = false;
let stopping = false;
let settled = false;
let failure: string | undefined;

function stopHost(error?: unknown): void {
  if (error !== undefined) {
    failure = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Native supervisor stopping host: ${failure}\n`);
  }
  if (stopping) return;
  stopping = true;
  stopObservingTree?.();
  try {
    rmSync(join(root, 'ready.json'), { force: true });
  } catch (error) {
    // Stopping the child still takes precedence; cleanup retries the readiness removal.
    failure = `${failure ?? 'Native stop'}; readiness removal: ${(error as Error).message}`;
  }
  if (child.pid) child.kill(error === undefined ? 'SIGTERM' : 'SIGKILL');
}

// Register failure handlers before any post-fork filesystem or process probes.
child.on('message', (message) => {
  if (message !== 'ready' || stopping) return;
  try {
    durableWrite(join(root, 'ready.json'), { pid: child.pid });
  } catch (error) {
    stopHost(error);
  }
});
child.on('error', (error) => {
  if (stopping) {
    // A failed stop keeps the owner alive and readiness withdrawn. Never release its lock.
    durableWrite(join(root, 'cleanup.json'), {
      hostPid: child.pid,
      state: 'unknown',
      error: error.message,
    });
    process.stderr.write(`Native host stop failed: ${error.message}\n`);
  } else stopHost(error);
});
function settle(): void {
  if (settled) return;
  settled = true;
  void cleanup().then(
    () => process.exit(1),
    (error: Error) => {
      durableWrite(join(root, 'cleanup.json'), {
        hostPid: child.pid,
        state: 'unknown',
        error: error.message,
        observedProcesses: tree?.snapshot(),
      });
      process.stderr.write(`Native cleanup failed: ${error.message}\n`);
      process.exit(1);
    },
  );
}
child.once('exit', settle);
// Spawn failure may emit close without exit; no PID means no host was released.
child.once('close', () => {
  if (!child.pid) settle();
});
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.on(signal, () => stopHost());

try {
  durableWrite(join(root, 'worker.json'), { pid: child.pid });
  durableWrite(join(root, 'cleanup.json'), { hostPid: child.pid, state: 'pending' });
  if (!child.pid) throw new Error('Native host did not obtain a process identity');
  tree = new NativeProcessTree(child.pid);
  stopObservingTree = tree.observe(stopHost);
  child.send('start', (error) => {
    if (error) stopHost(error);
  });
  hostReleased = true;
} catch (error) {
  stopHost(error);
}

async function cleanup(): Promise<void> {
  stopObservingTree?.();
  const errors: unknown[] = [];
  const attempt = (operation: () => void) => {
    try {
      operation();
    } catch (error) {
      errors.push(error);
    }
  };
  attempt(() => rmSync(join(root, 'ready.json'), { force: true }));
  if (tree) attempt(() => tree!.stop());
  else if (hostReleased) errors.push(new Error('Released native host has no process census'));
  const sessions = join(root, 'sessions');
  const records: Array<{ path: string; info: import('@farmslot/protocol').NativeSessionInfo }> = [];
  // A census failure must not skip the independently recorded runner groups.
  if (existsSync(sessions))
    for (const name of readdirSync(sessions).filter((name) => name.endsWith('.journal'))) {
      attempt(() => {
        const path = join(sessions, name);
        for (const line of readJournal(path).reverse()) {
          const entry = JSON.parse(line) as {
            info?: import('@farmslot/protocol').NativeSessionInfo;
          };
          if (!entry.info) continue;
          const info = entry.info;
          if (info.hostPid === child.pid && info.processPid && !info.processStopped) {
            records.push({ path, info });
            if (info.processIdentity && matchesProcess(info.processPid, info.processIdentity))
              signalGroup(info.processPid, 'SIGKILL');
          }
          break;
        }
      });
    }
  const stopped = () =>
    (!tree || tree.empty()) && records.every(({ info }) => !alive(-info.processPid!));
  const deadline = Date.now() + 5_000;
  let confirmedStopped = stopped();
  while (!confirmedStopped && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    confirmedStopped = stopped();
  }
  if (!confirmedStopped)
    errors.push(new Error('Native descendants remain alive; replacement owner is blocked'));
  if (errors.length)
    throw new AggregateError(
      errors,
      `Native cleanup is unconfirmed: ${errors.map((error) => (error instanceof Error ? error.message : String(error))).join('; ')}`,
    );
  for (const { path, info } of records)
    appendDurable(path, { info: { ...info, processStopped: true } });
  durableWrite(join(root, 'cleanup.json'), {
    hostPid: child.pid,
    state: 'complete',
    ...(failure ? { error: failure } : {}),
  });
  rmSync(lock, { recursive: true });
}
