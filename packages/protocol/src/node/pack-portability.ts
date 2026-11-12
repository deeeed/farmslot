import { spawnSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  type Stats,
} from 'node:fs';
import { lstat, readFile, readlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { validateQaConfig } from '../contracts/qa.js';

import { isLoopbackHost } from './loopback-host.js';
import { readPoolFiles } from './slot-by-repo.js';

const PRIVATE_PATH =
  /(?:^|[\s"'`(=:>]|file:\/\/)((?:~|\$HOME|\$\{HOME\})\/[A-Za-z0-9_.-][^\s"'`)]*|\/(?:Users|home|Volumes)\/(?:[A-Za-z0-9_$.-]+|\$\{[A-Za-z0-9_]+\})(?:\/[^\s"'`)]*)?|\/(?:root|(?:private\/)?var\/root)(?:\/[^\s"'`)]*)?|[A-Za-z]:[\\/]Users[\\/][A-Za-z0-9_.-]+)/;
const PRIVATE_TOOL = /\b(?:slot-lock|xreview\/)/;
const SHELL_WORD = String.raw`(?:[^\s"'\x60]+|"[^"]*"|'[^']*')`;
const SSH_OPTIONS = String.raw`(?:-\S+(?:\s+${SHELL_WORD})?\s+)*`;
function hostReference(host: string): RegExp {
  const target = String.raw`(?:[^\s"'@]+@)?(?:${host})`;
  return new RegExp(
    String.raw`(?:\b(?:https?|wss?|ssh):\/\/${target}(?=[/:\s"'\x60)]|$)|\bssh\s+${SSH_OPTIONS}["']?${target}(?=[\s"'\x60)]|$)|\b(?:scp|rsync)\s+${SSH_OPTIONS}(?:${SHELL_WORD}\s+)*?["']?${target}:)`,
    'i',
  );
}
const FIXED_HOST = hostReference(String.raw`[a-z0-9_-]+\.local`);
const RUNTIME_DIRS = new Set(['tasks', 'runs', 'artifacts', 'temp', '.agent', '.sandbox']);
const quoteRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const namesPattern = (values: Iterable<string>) => [...new Set(values)].map(quoteRegex).join('|');

export interface PackOwnedEntry {
  rel: string;
  /** Symlink targets use the same marker as the pack hash; links are never followed. */
  content: Buffer | string;
}

/** The owned-entry encoding belongs beside its producer and validators. */
export function packEntryLinkTarget(entry: PackOwnedEntry & { content: string }): string;
export function packEntryLinkTarget(entry: PackOwnedEntry): string | undefined;
export function packEntryLinkTarget(entry: PackOwnedEntry): string | undefined {
  return typeof entry.content === 'string' ? entry.content.slice('symlink:'.length) : undefined;
}

/** One `git` invocation's answer, as `spawnSync` reports it: exit status (null if it did not run) and stdout. */
export interface PackGitResult {
  status: number | null;
  stdout: Buffer;
}

/** Runs `git` with these arguments. The gateway passes one that does not block its event loop. */
export type PackGitRunner = (args: string[]) => Promise<PackGitResult>;

/** What a listed path is, without following links: a tracked deletion is missing. */
type PackPathKind = 'missing' | 'file' | 'directory' | 'other' | { link: string };

/** The ownership walk's requests: run `git`, or say what some paths are. A driver answers each. */
type PackStep = { git: string[] } | { paths: string[] };
type PackWalk<T> = Generator<PackStep, T, PackGitResult | PackPathKind[]>;

function* gitStep(args: string[]): PackWalk<PackGitResult> {
  const reply = yield { git: args };
  if (Array.isArray(reply)) throw new Error('The pack walk asked for git and got paths');
  return reply;
}

function* pathsStep(paths: string[]): PackWalk<PackPathKind[]> {
  const reply = yield { paths };
  if (!Array.isArray(reply)) throw new Error('The pack walk asked for paths and got git');
  return reply;
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

function pathKindSync(file: string): PackPathKind {
  let stat: Stats;
  try {
    stat = lstatSync(file);
  } catch (error) {
    if (isMissing(error)) return 'missing';
    throw error;
  }
  if (stat.isSymbolicLink()) return { link: readlinkSync(file) };
  return stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : 'other';
}

async function pathKind(file: string): Promise<PackPathKind> {
  let stat: Stats;
  try {
    stat = await lstat(file);
  } catch (error) {
    if (isMissing(error)) return 'missing';
    throw error;
  }
  if (stat.isSymbolicLink()) return { link: await readlink(file) };
  return stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : 'other';
}

/** Concurrent file system calls on one pack in the asynchronous driver. */
const PACK_IO_CONCURRENCY = 8;

/** `items.map(map)`, at most PACK_IO_CONCURRENCY at a time, in order. */
async function mapBounded<T, R>(items: readonly T[], map: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = [];
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await map(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(PACK_IO_CONCURRENCY, items.length) }, worker));
  return results;
}

function runPackWalk<T>(walk: PackWalk<T>): T {
  let step = walk.next();
  while (!step.done) {
    const request = step.value;
    let reply: PackGitResult | PackPathKind[];
    try {
      reply = 'git' in request ? spawnSync('git', request.git) : request.paths.map(pathKindSync);
    } catch (error) {
      // Raised inside the walk so its cleanup runs; the walk does not catch it.
      step = walk.throw(error);
      continue;
    }
    step = walk.next(reply);
  }
  return step.value;
}

async function runPackWalkAsync<T>(walk: PackWalk<T>, git: PackGitRunner): Promise<T> {
  let step = walk.next();
  while (!step.done) {
    const request = step.value;
    let reply: PackGitResult | PackPathKind[];
    try {
      reply = 'git' in request ? await git(request.git) : await mapBounded(request.paths, pathKind);
    } catch (error) {
      // Raised inside the walk so its cleanup runs; the walk does not catch it.
      step = walk.throw(error);
      continue;
    }
    step = walk.next(reply);
  }
  return step.value;
}

/** A pack-owned file whose bytes the driver reads after the walk; links carry their target. */
type PackOwnedPath = { rel: string; file: string } | (PackOwnedEntry & { content: string });

/** Removes the walk's temporary repository; each driver removes it its own way. */
type RemoveTemp = (dir: string) => void;

const removeTempSync: RemoveTemp = (dir) => rmSync(dir, { recursive: true, force: true });

/** A copied pack still owns its ignore rules, even without its original Git index. */
function* listUnindexedPackFiles(
  dir: string,
  prefix: string,
  removeTemp: RemoveTemp,
): PackWalk<string[]> {
  const gitDir = mkdtempSync(path.join(tmpdir(), 'pack-ignore-'));
  try {
    const initialized = yield* gitStep(['init', '--bare', '--quiet', gitDir]);
    if (initialized.status !== 0) throw new Error('Cannot initialize pack ownership scan');
    const listed = yield* gitStep([
      '--git-dir',
      gitDir,
      '--work-tree',
      dir,
      '-c',
      'core.excludesfile=/dev/null',
      'ls-files',
      '--others',
      '--exclude-standard',
      '-z',
    ]);
    if (listed.status !== 0) throw new Error('Cannot list copied pack-owned files');
    return listed.stdout
      .toString()
      .split('\0')
      .filter(Boolean)
      .filter((name) => prefix !== '' || !RUNTIME_DIRS.has(name.split('/')[0]));
  } finally {
    removeTemp(gitDir);
  }
}

/** One ownership boundary for pack hashing, admission and gateway sync. */
export function listPackOwnedEntries(root: string): PackOwnedEntry[] {
  return runPackWalk(walkPackOwnedEntries(root, removeTempSync)).map((entry) =>
    'file' in entry ? { rel: entry.rel, content: readFileSync(entry.file) } : entry,
  );
}

/**
 * `listPackOwnedEntries` off the caller's event loop: `git` runs through `git`, and the paths are
 * read, the files read and the temporary repository removed with `fs/promises`.
 */
export async function listPackOwnedEntriesAsync(
  root: string,
  git: PackGitRunner,
): Promise<PackOwnedEntry[]> {
  const removals: Promise<void>[] = [];
  let owned: PackOwnedPath[];
  try {
    owned = await runPackWalkAsync(
      walkPackOwnedEntries(root, (dir) => removals.push(rm(dir, { recursive: true, force: true }))),
      git,
    );
  } finally {
    await Promise.all(removals);
  }
  return mapBounded(owned, async (entry) =>
    'file' in entry ? { rel: entry.rel, content: await readFile(entry.file) } : entry,
  );
}

function* walkPackOwnedEntries(root: string, removeTemp: RemoveTemp): PackWalk<PackOwnedPath[]> {
  const entries: PackOwnedPath[] = [];
  const walk = function* (dir: string, prefix: string): PackWalk<void> {
    // Git scopes this to dir and honors its owning repository. Submodule entries
    // are directories, so the recursive call switches to the submodule's index.
    const git = yield* gitStep([
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
      names = yield* listUnindexedPackFiles(dir, prefix, removeTemp);
    } else {
      throw new Error('Cannot list pack-owned files for portability validation');
    }
    const owned = names
      .sort()
      .filter(
        (name) => !name.split('/').some((part) => part === '.git' || part === 'node_modules'),
      );
    const kinds = yield* pathsStep(owned.map((name) => path.join(dir, name)));
    for (const [index, name] of owned.entries()) {
      const kind = kinds[index];
      // A tracked deletion has no shipped bytes. Dangling links still have a target.
      if (kind === 'missing' || kind === 'other') continue;
      const cleanName = name.replace(/\/+$/, '');
      const rel = prefix ? `${prefix}/${cleanName}` : cleanName;
      if (typeof kind === 'object') entries.push({ rel, content: `symlink:${kind.link}` });
      else if (kind === 'directory') yield* walk(path.join(dir, name), rel);
      else entries.push({ rel, file: path.join(dir, name) });
    }
  };
  yield* walk(root, '');
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
          (v): v is string => typeof v === 'string' && !isLoopbackHost(v),
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
  // Control tests deliberately contain invalid fixtures. They stay in pack hashes,
  // while admission checks runtime files, templates and ordinary fixture files.
  if (/(?:^|\/)[^/]+\.(?:test|spec)\.(?:[cm]?[jt]sx?|sh|bats|py)$/.test(file)) return [];
  const names = new Set<string>();
  const flowErrors: string[] = [];
  if (file.endsWith('.json')) {
    // Explicit node selectors are forbidden even before a pool is installed.
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch (error) {
      // Structural validators own invalid JSON; fixture JSON may be deliberately malformed.
      if (!(error instanceof SyntaxError)) throw error;
    }
    if (path.basename(file) === 'project.json' && parsed && typeof parsed === 'object') {
      const qa = (parsed as { qa?: unknown }).qa;
      try {
        validateQaConfig(qa);
      } catch (error) {
        const reason =
          qa === undefined
            ? 'missing required qa flow'
            : `invalid qa flow: ${(error as Error).message}`;
        flowErrors.push(`${file}:1: ${reason}; configure qa.profiles selecting a QA checklist`);
      }
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
  const selector = names.size
    ? new RegExp(`(?<![\\w-])(?:${namesPattern(names)})(?![\\w-])`)
    : null;
  const registered = namesPattern(machines);
  const host = registered ? hostReference(registered) : null;
  const machineOption = registered
    ? new RegExp(
        String.raw`(?:--machine(?:=|\s+)|(?:^|[\s;])(?:HOST|FARMSLOT_MACHINE)=)["']?(?:${registered})(?=[\s"'\x60)]|$)`,
      )
    : null;
  const portabilityErrors = content.split(/\r?\n/).flatMap((line, index) => {
    const privatePath = PRIVATE_PATH.exec(line);
    const match =
      privatePath?.[1] ??
      PRIVATE_TOOL.exec(line)?.[0] ??
      FIXED_HOST.exec(line)?.[0] ??
      selector?.exec(line)?.[0] ??
      host?.exec(line)?.[0] ??
      machineOption?.exec(line)?.[0];
    return match
      ? [
          `${file}:${index + 1}: nonportable reference; use a relative pack path or a pool/slot {{placeholder}} for node-specific values`,
        ]
      : [];
  });
  return [...flowErrors, ...portabilityErrors];
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

function validatePackEntries(
  entries: PackOwnedEntry[],
  prefix: string,
  machines: readonly string[],
): string[] {
  return entries.flatMap(({ rel, content }) => {
    const file = prefix ? `${prefix}/${rel}` : rel;
    return typeof content === 'string'
      ? validatePackFilePortability(file, packEntryLinkTarget({ rel, content }), machines)
      : validatePackBytesPortability(file, content, machines);
  });
}

export function validatePackPortability(
  root: string,
  prefix = '',
  machines: readonly string[] = [],
): string[] {
  return validatePackEntries(listPackOwnedEntries(root), prefix, machines);
}

/** `validatePackPortability` with the ownership walk's `git` calls run by `git`. */
export async function validatePackPortabilityAsync(
  root: string,
  prefix: string,
  machines: readonly string[],
  git: PackGitRunner,
): Promise<string[]> {
  return validatePackEntries(await listPackOwnedEntriesAsync(root, git), prefix, machines);
}
