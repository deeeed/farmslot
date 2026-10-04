import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { ensureRuntimeDirectory, processIdentity } from '@farmslot/recipe-runner/runtime/operation';

import { hostEnvName } from './host.js';
import { recipeRuntimeDir } from './paths.js';

const lockTokenEnv = (): string => hostEnvName('CHECKOUT_LOCK_TOKEN');

export interface CheckoutLock {
  path: string;
  release: () => void;
}

export interface CheckoutLockFailure {
  path: string;
  owner: Record<string, unknown> | null;
  message: string;
}

export function acquireCheckoutLock(
  target: string,
  operation: string,
): CheckoutLock | CheckoutLockFailure {
  const repoRoot = fs.realpathSync(target);
  const lockPath = path.join(repoRoot, recipeRuntimeDir(), 'sandbox.lock');
  ensureRuntimeDirectory(path.dirname(lockPath));
  const tokenEnv = lockTokenEnv();
  const inheritedToken = process.env[tokenEnv];

  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const identity = processIdentity(process.pid);
      if (!identity) throw new Error('Cannot identify checkout lock owner process');
      const fd = fs.openSync(lockPath, 'wx', 0o600);
      fs.fchmodSync(fd, 0o600);
      const token = randomUUID();
      const owner = {
        schemaVersion: 1,
        pid: process.pid,
        processStartedAt: identity,
        operation,
        repoRoot,
        token,
        startedAt: new Date().toISOString(),
      };
      fs.writeFileSync(fd, `${JSON.stringify(owner, null, 2)}\n`);
      fs.closeSync(fd);
      process.env[tokenEnv] = token;
      return {
        path: lockPath,
        release: () => {
          const current = readOwner(lockPath);
          if (current?.pid === process.pid && current.token === token && !childrenAlive(current)) {
            fs.rmSync(lockPath, { force: true });
            fs.rmSync(path.join(path.dirname(lockPath), 'lock-members', token), {
              recursive: true,
              force: true,
            });
          }
          if (process.env[tokenEnv] === token) {
            if (inheritedToken) process.env[tokenEnv] = inheritedToken;
            else delete process.env[tokenEnv];
          }
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const owner = readOwner(lockPath);
      if (
        inheritedToken &&
        owner?.token === inheritedToken &&
        owner.repoRoot === repoRoot &&
        typeof owner.pid === 'number' &&
        ownerAlive(owner)
      ) {
        trackCheckoutChild(repoRoot, process.pid);
        return { path: lockPath, release: () => undefined };
      }
      if (owner && typeof owner.pid === 'number' && ownerAlive(owner)) {
        return {
          path: lockPath,
          owner,
          message: `checkout sandbox is busy with ${String(owner.operation ?? 'another operation')} (pid ${owner.pid}).`,
        };
      }
      if (!owner || childrenAlive(owner)) {
        return {
          path: lockPath,
          owner,
          message: `checkout sandbox owner is unreadable or has surviving child processes. Inspect ${lockPath} and its lock-members directory; remove the lock only after verifying all recorded processes have exited.`,
        };
      }
      claimStaleLock(lockPath, owner);
    }
  }
  return {
    path: lockPath,
    owner: readOwner(lockPath),
    message: 'checkout sandbox lock could not be acquired.',
  };
}

function claimStaleLock(lockPath: string, expectedOwner: Record<string, unknown> | null): void {
  const claimedPath = `${lockPath}.stale-${process.pid}-${randomUUID()}`;
  try {
    fs.renameSync(lockPath, claimedPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }

  try {
    const claimedOwner = readOwner(claimedPath);
    if (
      !sameOwner(claimedOwner, expectedOwner) ||
      (claimedOwner &&
        typeof claimedOwner.pid === 'number' &&
        (ownerAlive(claimedOwner) || childrenAlive(claimedOwner)))
    ) {
      try {
        // Restore only when nobody else acquired the now-empty canonical path.
        // linkSync is atomic and never overwrites a newer owner's lock.
        fs.linkSync(claimedPath, lockPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
    } else if (
      typeof claimedOwner?.token === 'string' &&
      /^[a-f0-9-]{36}$/.test(claimedOwner.token)
    ) {
      fs.rmSync(path.join(path.dirname(lockPath), 'lock-members', claimedOwner.token), {
        recursive: true,
        force: true,
      });
    }
  } finally {
    fs.rmSync(claimedPath, { force: true });
  }
}

function sameOwner(
  left: Record<string, unknown> | null,
  right: Record<string, unknown> | null,
): boolean {
  if (!left || !right) return left === right;
  return (
    left.pid === right.pid &&
    left.token === right.token &&
    left.startedAt === right.startedAt &&
    left.repoRoot === right.repoRoot
  );
}

function readOwner(lockPath: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function ownerAlive(owner: Record<string, unknown>): boolean {
  if (typeof owner.pid !== 'number') return true;
  if (typeof owner.processStartedAt === 'string')
    return processIdentity(owner.pid) === owner.processStartedAt;
  return processAlive(owner.pid);
}

function childrenAlive(owner: Record<string, unknown>): boolean {
  if (
    typeof owner.repoRoot !== 'string' ||
    typeof owner.token !== 'string' ||
    !/^[a-f0-9-]{36}$/.test(owner.token)
  )
    return false;
  const directory = path.join(owner.repoRoot, recipeRuntimeDir(), 'lock-members', owner.token);
  if (!fs.existsSync(directory)) return false;
  return fs
    .readdirSync(directory)
    .filter((name) => name.endsWith('.json'))
    .some((name) => {
      const child = readOwner(path.join(directory, name));
      if (child && typeof child.processGroupId === 'number' && child.processGroupId > 0)
        return processAlive(-child.processGroupId);
      // An incomplete membership write is uncertain ownership, never permission to reclaim.
      return (
        !child ||
        typeof child.pid !== 'number' ||
        typeof child.processStartedAt !== 'string' ||
        (child.pid !== owner.pid && processIdentity(child.pid) === child.processStartedAt)
      );
    });
}

/** Each nested launcher records its child independently under the inherited lock. */
export function trackCheckoutChild(
  target: string,
  pid: number,
  ownsProcessGroup = false,
): () => void {
  const repoRoot = fs.realpathSync(target);
  const lockPath = path.join(repoRoot, recipeRuntimeDir(), 'sandbox.lock');
  const owner = readOwner(lockPath);
  if (
    !owner ||
    owner.token !== process.env[lockTokenEnv()] ||
    typeof owner.token !== 'string' ||
    !/^[a-f0-9-]{36}$/.test(owner.token)
  )
    return () => undefined;
  const identity = processIdentity(pid);
  if (!identity && !ownsProcessGroup) return () => undefined;
  const directory = path.join(repoRoot, recipeRuntimeDir(), 'lock-members', owner.token);
  ensureRuntimeDirectory(directory);
  const file = path.join(directory, `${pid}.json`);
  const previous = readOwner(file);
  const group =
    ownsProcessGroup ||
    (previous?.processStartedAt === identity && previous?.processGroupId === pid);
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  fs.writeFileSync(
    temporary,
    JSON.stringify({ pid, processStartedAt: identity, ...(group ? { processGroupId: pid } : {}) }),
    { mode: 0o600 },
  );
  fs.chmodSync(temporary, 0o600);
  fs.renameSync(temporary, file);
  return () => {
    const current = readOwner(file);
    if (current?.pid === pid && current.processStartedAt === identity)
      fs.rmSync(file, { force: true });
  };
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}
