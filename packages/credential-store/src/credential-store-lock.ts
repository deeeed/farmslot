import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

import { farmslotHome } from '@farmslot/protocol/node/farmslot-home';

import {
  markCredentialStoreLockHeld,
  markCredentialStoreLockReleased,
} from './credential-lock-state.js';
import {
  type CredentialStore,
  credentialStorePath,
  loadCredentialStore,
  saveCredentialStore,
} from './credential-store.js';

const LOCK_RETRY_COUNT = 20;
const LOCK_RETRY_MS = 25;

export interface CredentialStoreLockOptions {
  env?: NodeJS.ProcessEnv;
  beforeRead?: () => void;
}

export class CredentialStoreRefusalError extends Error {
  constructor(
    message: string,
    readonly diagnostic?: string,
  ) {
    super(message);
    this.name = 'CredentialStoreRefusalError';
  }
}

export function withCredentialStoreLock<T>(
  fn: (store: CredentialStore) => { next: CredentialStore; result: T },
  options: CredentialStoreLockOptions = {},
): T {
  return withCredentialLock(() => {
    const env = options.env ?? process.env;
    options.beforeRead?.();
    const path = credentialStorePath(env);
    const current = loadCredentialStore(path);
    const { next, result } = fn(current);
    if (next !== current) saveCredentialStore(next, path);
    return result;
  }, options.env);
}

export function withCredentialLock<T>(fn: () => T, env: NodeJS.ProcessEnv = process.env): T {
  const lockPath = join(farmslotHome(env), 'credentials.lock');
  const release = acquireCredentialStoreLock(lockPath);
  try {
    return fn();
  } finally {
    release();
  }
}

export function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function acquireCredentialStoreLock(lockPath: string): () => void {
  let holder = NaN;
  for (let attempt = 0; attempt <= LOCK_RETRY_COUNT; attempt += 1) {
    let fd: number | null = null;
    try {
      // The home may not exist yet. Creating it here does not create the store.
      const home = dirname(lockPath);
      mkdirSync(home, { recursive: true, mode: 0o700 });
      chmodSync(home, 0o700);
      fd = openSync(lockPath, 'wx', 0o600);
      writeFileSync(fd, `${process.pid}\n`, 'utf8');
      markCredentialStoreLockHeld(lockPath);
      return () => releaseCredentialStoreLock(lockPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      holder = readLockPid(lockPath);
      if (!Number.isInteger(holder) || holder <= 0 || !processIsAlive(holder)) {
        try {
          unlinkSync(lockPath);
        } catch (unlinkError) {
          if ((unlinkError as NodeJS.ErrnoException).code !== 'ENOENT') throw unlinkError;
        }
        continue;
      }
      if (attempt < LOCK_RETRY_COUNT) waitSynchronously(LOCK_RETRY_MS);
    } finally {
      if (fd !== null) closeSync(fd);
    }
  }
  throw new CredentialStoreRefusalError(
    'Another Farmslot process is writing the credential store.\n' +
      'Next: wait for it to finish, or stop that process and retry.',
    `credential store lock contention at ${lockPath}; holder pid ${holder}`,
  );
}

function releaseCredentialStoreLock(lockPath: string): void {
  markCredentialStoreLockReleased(lockPath);
  if (!existsSync(lockPath)) return;
  if (readLockPid(lockPath) === process.pid) unlinkSync(lockPath);
}

function readLockPid(lockPath: string): number {
  try {
    return Number(readFileSync(lockPath, 'utf8').trim());
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return NaN;
    throw error;
  }
}

function waitSynchronously(milliseconds: number): void {
  const waitBuffer = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(waitBuffer, 0, 0, milliseconds);
}
