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
  executionNodeId: process.env.FARMSLOT_NATIVE_EXECUTION_NODE_ID ?? 'local',
  pid: process.pid,
  token: randomBytes(32).toString('hex'),
  socket,
});
const extension = import.meta.url.endsWith('.ts') ? 'ts' : 'js';
const child = fork(fileURLToPath(new URL(`./host.${extension}`, import.meta.url)), [root], {
  stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
});
const tree = new NativeProcessTree(child.pid!);
const treeTimer = setInterval(() => tree.capture(), 100);
treeTimer.unref();
durableWrite(join(root, 'worker.json'), { pid: child.pid });
durableWrite(join(root, 'cleanup.json'), { hostPid: child.pid, state: 'pending' });
child.send('start');
// A host crash loses stdin ownership. Clean its recorded process groups before releasing the lock.
child.on('message', (message) => {
  if (message === 'ready') durableWrite(join(root, 'ready.json'), { pid: child.pid });
});
child.on('error', (error) => {
  throw error;
});
child.on('exit', () => {
  void cleanup().then(
    () => process.exit(1),
    (error: Error) => {
      durableWrite(join(root, 'cleanup.json'), {
        hostPid: child.pid,
        state: 'unknown',
        error: error.message,
      });
      // Keep the ownership lock. Replacement must fail closed until cleanup is resolved.
      process.stderr.write(`Native cleanup failed: ${error.message}\n`);
      process.exit(1);
    },
  );
});
async function cleanup(): Promise<void> {
  clearInterval(treeTimer);
  rmSync(join(root, 'ready.json'), { force: true });
  tree.stop();
  const sessions = join(root, 'sessions');
  const records: Array<{ path: string; info: import('@farmslot/protocol').NativeSessionInfo }> = [];
  if (existsSync(sessions))
    for (const name of readdirSync(sessions).filter((name) => name.endsWith('.journal'))) {
      const path = join(sessions, name);
      for (const line of readJournal(path).reverse()) {
        const entry = JSON.parse(line) as { info?: import('@farmslot/protocol').NativeSessionInfo };
        if (!entry.info) continue;
        const info = entry.info;
        if (info.hostPid === child.pid && info.processPid && !info.processStopped) {
          records.push({ path, info });
          if (info.processIdentity && matchesProcess(info.processPid, info.processIdentity))
            signalGroup(info.processPid, 'SIGKILL');
        }
        break;
      }
    }
  const stopped = () => tree.empty() && records.every(({ info }) => !alive(-info.processPid!));
  const deadline = Date.now() + 5_000;
  while (!stopped() && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 25));
  if (!stopped()) throw new Error('Native descendants remain alive; replacement owner is blocked');
  for (const { path, info } of records)
    appendDurable(path, { info: { ...info, processStopped: true } });
  durableWrite(join(root, 'cleanup.json'), { hostPid: child.pid, state: 'complete' });
  rmSync(lock, { recursive: true });
}
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.on(signal, () => child.kill(signal));
