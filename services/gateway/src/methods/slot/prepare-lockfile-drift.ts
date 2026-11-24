import { open } from 'node:fs/promises';
import path from 'node:path';
import { stripVTControlCharacters } from 'node:util';

const LOCKFILES = new Set([
  'yarn.lock',
  'package-lock.json',
  'npm-shrinkwrap.json',
  'pnpm-lock.yaml',
]);

/** A lockfile a package manager rewrites when it and package.json disagree. */
export function isLockfile(file: string): boolean {
  return LOCKFILES.has(path.posix.basename(file));
}

/**
 * A run on an existing PR branch may have to fix that branch's lockfile, so its install may
 * update it (MetaMask/metamask-mobile#39654: package.json pinned a release the lock did not).
 */
export function lockfileDriftAllowed(flowType: string | undefined, branchPublished: boolean) {
  return flowType === 'pr-complete' || (flowType === 'dev' && branchPublished);
}

/**
 * Whether an install failed because the lockfile does not match package.json, and the package it
 * names when it does; null for any other failure.
 */
export function lockfileDrift(log: string): { package: string | null } | null {
  const text = stripVTControlCharacters(log);
  const missing =
    /(\S+?)@(?:npm:)?[^\s:]+: This package doesn't seem to be present in your lockfile/.exec(
      text,
    ) ?? /Missing: (\S+?)@\S+ from lock file/.exec(text);
  if (missing) return { package: missing[1] ?? null };
  if (
    !/YN0028|lockfile would have been modified by this install|Your lockfile needs to be updated, but yarn was run with `--frozen-lockfile`|package\.json and package-lock\.json or npm-shrinkwrap\.json are in sync/.test(
      text,
    )
  )
    return null;
  // Yarn prints the lockfile change it refused; its first added entry names the package.
  const added = /^(?:➤ YN0028: │ )?\+\s*"?((?:@[^/\s"]+\/)?[^@\s"]+)@/m.exec(text);
  return { package: added?.[1] ?? null };
}

/** The last `bytes` of a log, enough for an install's failure output. */
export async function readLogTail(file: string, bytes = 512 * 1024): Promise<string> {
  const handle = await open(file, 'r');
  try {
    const { size } = await handle.stat();
    const length = Math.min(size, bytes);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, size - length);
    return buffer.toString('utf8');
  } finally {
    await handle.close();
  }
}
