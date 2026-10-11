import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync } from 'node:fs';
import path from 'node:path';

import { readPoolFiles } from './slot-by-repo.js';

const PRIVATE_PATH =
  /(?:^|[\s"'`(=]|file:\/\/)((?:~|\$HOME|\$\{HOME\})\/xreview(?:\/[^\s"'`)]*)?|\/(?:Users|home)\/[A-Za-z0-9_.-]+(?:\/[^\s"'`)]*)?|\/var\/root(?:\/[^\s"'`)]*)?|[A-Za-z]:[\\/]Users[\\/][A-Za-z0-9_.-]+)/;
const SHELL_WORD = String.raw`(?:[^\s"'\x60]+|"[^"]*"|'[^']*')`;
const SSH_OPTIONS = String.raw`(?:-\S+(?:\s+${SHELL_WORD})?\s+)*`;
const LOCAL_HOST = String.raw`(?:[^\s"'@]+@)?[a-z0-9_-]+\.local`;
const FIXED_HOST = new RegExp(
  String.raw`(?:\b(?:https?|wss?|ssh):\/\/${LOCAL_HOST}(?=[/:\s"'\x60)]|$)|\bssh\s+${SSH_OPTIONS}["']?${LOCAL_HOST}(?=[\s"'\x60)]|$)|\b(?:scp|rsync)\s+${SSH_OPTIONS}(?:${SHELL_WORD}\s+)*?["']?${LOCAL_HOST}:)`,
  'i',
);
const RUNTIME_DIRS = new Set(['tasks', 'runs', 'artifacts', 'temp', '.agent', '.sandbox']);
const quoteRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export interface PackOwnedEntry {
  rel: string;
  /** Symlink targets use the same marker as the pack hash; links are never followed. */
  content: Buffer | string;
}

/** One ownership boundary for pack hashing, admission and gateway sync. */
export function listPackOwnedEntries(root: string): PackOwnedEntry[] {
  const entries: PackOwnedEntry[] = [];
  const walk = (dir: string, prefix: string) => {
    // Git scopes this to dir and honors its owning repository. Submodule entries
    // are directories, so the recursive call switches to the submodule's index.
    const git = spawnSync('git', [
      '-C',
      dir,
      'ls-files',
      '-c',
      '-o',
      '--exclude-standard',
      '-z',
      '--',
      '.',
    ]);
    let names: string[];
    if (git.status === 0 && git.stdout.length) {
      names = [...new Set(git.stdout.toString().split('\0').filter(Boolean))];
    } else if (git.status === 0 || git.status === 128) {
      // A standalone pack, or an untracked pack ignored by its parent repo,
      // still owns its source files. Its top-level runtime state is not source.
      names = readdirSync(dir).filter((name) => prefix !== '' || !RUNTIME_DIRS.has(name));
    } else {
      throw new Error('Cannot list pack-owned files for portability validation');
    }
    for (const name of names.sort()) {
      if (name.split('/').some((part) => part === '.git' || part === 'node_modules')) continue;
      const full = path.join(dir, name);
      if (!existsSync(full)) {
        // A tracked deletion has no shipped bytes. Dangling links still have a target.
        try {
          lstatSync(full);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
          throw error;
        }
      }
      const cleanName = name.replace(/\/+$/, '');
      const rel = prefix ? `${prefix}/${cleanName}` : cleanName;
      const stat = lstatSync(full);
      if (stat.isSymbolicLink()) entries.push({ rel, content: `symlink:${readlinkSync(full)}` });
      else if (stat.isDirectory()) walk(full, rel);
      else if (stat.isFile()) entries.push({ rel, content: readFileSync(full) });
    }
  };
  walk(root, '');
  return entries.sort((a, b) => {
    const left = a.rel.replaceAll('/', '\0');
    const right = b.rel.replaceAll('/', '\0');
    return left < right ? -1 : left > right ? 1 : 0;
  });
}

/** Machine identities come from pool configuration, never a built-in operator list. */
export function packMachineNames(poolDir: string): string[] {
  if (!existsSync(poolDir)) return [];
  return [
    ...new Set(
      readPoolFiles<{ machine?: string; host?: string }>(poolDir).flatMap(({ pool }) =>
        [pool.machine, pool.host].filter(
          (v): v is string =>
            typeof v === 'string' && !['localhost', '127.0.0.1', '::1'].includes(v),
        ),
      ),
    ),
  ];
}

/** Pack admission and gateway sync use the same portability policy. */
export function validatePackFilePortability(
  file: string,
  content: string,
  machines: readonly string[] = [],
): string[] {
  const names = new Set(machines);
  if (file.endsWith('.json')) {
    // Explicit node selectors are forbidden even before a pool is installed.
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch (error) {
      // Structural validators own invalid JSON; fixture JSON may be deliberately malformed.
      if (!(error instanceof SyntaxError)) throw error;
    }
    const visit = (value: unknown) => {
      if (!value || typeof value !== 'object') return;
      for (const [key, entry] of Object.entries(value)) {
        if (['machine', 'allowedMachines', 'hostname', 'ssh_host'].includes(key)) {
          for (const name of Array.isArray(entry) ? entry : [entry]) {
            if (typeof name === 'string' && !name.includes('{{')) names.add(name);
          }
        }
        visit(entry);
      }
    };
    visit(parsed);
  }
  const machine = names.size
    ? new RegExp(`(?<![\\w-])(?:${[...names].map(quoteRegex).join('|')})(?![\\w-])`)
    : null;
  return content.split(/\r?\n/).flatMap((line, index) => {
    const privatePath = PRIVATE_PATH.exec(line);
    const match = privatePath?.[1] ?? FIXED_HOST.exec(line)?.[0] ?? machine?.exec(line)?.[0];
    return match
      ? [
          `${file}:${index + 1}: nonportable reference; use a relative pack path or a pool/slot {{placeholder}} for node-specific values`,
        ]
      : [];
  });
}

export function validatePackBytesPortability(
  file: string,
  bytes: Buffer,
  machines: readonly string[] = [],
): string[] {
  return bytes.includes(0)
    ? []
    : validatePackFilePortability(file, bytes.toString('utf8'), machines);
}

export function validatePackPortability(
  root: string,
  prefix = '',
  machines: readonly string[] = [],
): string[] {
  return listPackOwnedEntries(root).flatMap(({ rel, content }) => {
    const file = prefix ? `${prefix}/${rel}` : rel;
    return typeof content === 'string'
      ? validatePackFilePortability(file, content.slice('symlink:'.length), machines)
      : validatePackBytesPortability(file, content, machines);
  });
}
