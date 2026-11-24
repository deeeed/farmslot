import { open } from 'node:fs/promises';
import path from 'node:path';
import { stripVTControlCharacters } from 'node:util';

import { shellQuote } from '../../core/tmux.js';

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
 * One slot command that exits 0 only when the install rewrote `file` in the working tree, not only
 * in the index. A Git error refuses it: `git diff --quiet` exits 1 for a change, 0 for none.
 */
export function lockfileRewrittenCommand(repo: string, file: string): string {
  return `cd ${shellQuote(repo)} && test -f ${shellQuote(file)} && { git diff --quiet -- ${shellQuote(file)}; test $? -eq 1; }`;
}

/**
 * A run on an existing PR branch may have to fix that branch's lockfile, so its install may
 * update it (MetaMask/metamask-mobile#39654: package.json pinned a release the lock did not).
 */
export function lockfileDriftAllowed(flowType: string | undefined, branchPublished: boolean) {
  return flowType === 'pr-complete' || (flowType === 'dev' && branchPublished);
}

/**
 * The line a deps hook prints once it updated a drifted lockfile under
 * `FARMSLOT_PREPARE_LOCKFILE_DRIFT=allow`; a failure after it is not drift.
 */
export const LOCKFILE_DRIFT_FALLBACK_MARKER = '[farmslot] lockfile drift fallback';

/**
 * Whether an install failed because the lockfile does not match package.json, and the package it
 * names when it does; null for any other failure.
 */
export function lockfileDrift(log: string): { package: string | null } | null {
  const text = stripVTControlCharacters(log);
  // Yarn names the descriptor: `name@npm:1.0.0`, `name@patch:…`, `name@npm:>=1 <2`, `name@workspace:…`.
  const missing =
    /(?:^|│ )((?:@[^/\s@]+\/)?[^@\s/][^@\s]*)@[^\n]*?: This package doesn't seem to be present in your lockfile/m.exec(
      text,
    ) ?? /Missing: (\S+?)@\S+ from lock file/.exec(text);
  if (missing) return { package: missing[1] ?? null };
  if (
    !/YN0028|lockfile would have been modified by this install|doesn't seem to be present in your lockfile|Your lockfile needs to be updated, but yarn was run with `--frozen-lockfile`|package\.json and package-lock\.json or npm-shrinkwrap\.json are in sync/.test(
      text,
    )
  )
    return null;
  // Yarn berry prints the lockfile change it refused; its first added entry names the package.
  const added = /^(?:➤ )?YN0028: │ \+\s*"?((?:@[^/\s"]+\/)?[^@\s"]+)@/m.exec(text);
  return { package: added?.[1] ?? null };
}

/** The last `bytes` of a log, enough for an install's failure output. */
export async function readLogTail(file: string, bytes = 512 * 1024): Promise<string> {
  const handle = await open(file, 'r').catch((error: unknown) => {
    // A command that wrote no log has no drift to read.
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
    throw error;
  });
  if (!handle) return '';
  try {
    const { size } = await handle.stat();
    const length = Math.min(size, bytes);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, size - length);
    const text = buffer.toString('utf8');
    // A tail that starts mid-file may start mid-character: drop its partial first line.
    return length < size ? text.slice(text.indexOf('\n') + 1) : text;
  } finally {
    await handle.close();
  }
}
