// host-services/git.ts — Git service: checkout and ref reads from files, git processes when needed.
//
// All file-based readers answer only what git itself would answer from the same files. Layouts not
// covered (no .git, reftable, symlinked or broken refs, symref chains, config git rejects or that
// includes files, another owner, Git environment overrides) return undefined: the caller then uses git.run, which reads the
// same files and gives the exact answer, failures included. Object-database reads always go through
// git.run — the only place call sites in this workstream spawn git.
import type { Stats } from 'node:fs';
import { lstat, open, readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

import {
  type DefaultBranchProbe,
  defaultBranchRefs,
  readDefaultBranchProbe,
} from '@farmslot/protocol';

import { EXEC_TIMEOUT_EXIT_CODE, execFileArgv } from '../core/exec.js';
import { registerHostOperations, withHostOperation } from '../observability/performance.js';

// ─── Exported types ───

/** A checkout's Git directories, as git resolves them from `<worktree>/.git`. */
export interface GitCheckout {
  worktree: string;
  /** This worktree's own directory: HEAD and per-worktree refs. */
  gitDir: string;
  /** Shared refs, packed-refs and config; gitDir outside linked worktrees. */
  commonDir: string;
}

/** HEAD on a branch (sha null while the branch is unborn) or detached at a commit. */
export type GitHeadState =
  | { kind: 'branch'; ref: string; sha: string | null }
  | { kind: 'detached'; sha: string };

/** A config file's variables in file order: names normalized as git does, null for `key` alone. */
export type GitConfigEntries = ReadonlyArray<readonly [name: string, value: string | null]>;

/** A ref's raw value: a commit SHA or a symbolic reference target. */
export type GitRefValue = { sha: string } | { symref: string };

/** The result of a git process invocation; always resolves, never rejects. */
export interface GitResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface GitRunOptions {
  timeout?: number;
  cwd?: string;
  maxBuffer?: number;
}

// ─── Operation name constants ───

/** Stable names for each GitService operation, for use as metric attribution keys. */
export const GIT_OPS = {
  openCheckout: 'git.openCheckout',
  isGitFile: 'git.isGitFile',
  readHead: 'git.readHead',
  readRef: 'git.readRef',
  readSymbolicRef: 'git.readSymbolicRef',
  shortenRef: 'git.shortenRef',
  readConfig: 'git.readConfig',
  readHeadProbe: 'git.readHeadProbe',
  readDefaultBranchProbe: 'git.readDefaultBranchProbe',
  run: 'git.run',
} as const;
registerHostOperations(Object.values(GIT_OPS));

// ─── Service interface ───

export interface GitService {
  openCheckout(worktree: string): Promise<GitCheckout | undefined>;
  isGitFile(worktree: string): Promise<boolean | undefined>;
  readHead(checkout: GitCheckout): Promise<GitHeadState | undefined>;
  readRef(checkout: GitCheckout, name: string): Promise<GitRefValue | null | undefined>;
  readSymbolicRef(checkout: GitCheckout, name: string): Promise<string | null | undefined>;
  shortenRef(checkout: GitCheckout, ref: string, strict: boolean): Promise<string | undefined>;
  readConfig(checkout: GitCheckout): Promise<GitConfigEntries | undefined>;
  readHeadProbe(checkout: GitCheckout): Promise<{ branch: string; headSha: string } | undefined>;
  readDefaultBranchProbe(
    checkout: GitCheckout,
    defaultBranch: string,
  ): Promise<DefaultBranchProbe | undefined>;
  run(argv: string[], options?: GitRunOptions): Promise<GitResult>;
}

// ─── Private implementation helpers ───

/** Variables that make git read other directories, refs or config than the checkout's own. */
const GIT_ENVIRONMENT = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_COMMON_DIR',
  'GIT_NAMESPACE',
  'GIT_CONFIG',
  'GIT_CONFIG_PARAMETERS',
  'GIT_CONFIG_COUNT',
  'GIT_CONFIG_NOSYSTEM',
];
const HEX = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
/** git's ref_rev_parse_rules, in order: how a short name expands to a full refname. */
const REV_PARSE_RULES = [
  '%s',
  'refs/%s',
  'refs/tags/%s',
  'refs/heads/%s',
  'refs/remotes/%s',
  'refs/remotes/%s/HEAD',
];
const SYMREF_MAX_DEPTH = 5;

/** Sentinel exit code for a git process killed by timeout; matches core/exec.ts EXEC_TIMEOUT_EXIT_CODE. */
const GIT_TIMEOUT_EXIT_CODE = EXEC_TIMEOUT_EXIT_CODE;

function isSystemError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && typeof (error as NodeJS.ErrnoException).code === 'string';
}

function isMissing(error: unknown): boolean {
  return isSystemError(error) && (error.code === 'ENOENT' || error.code === 'ENOTDIR');
}

async function statOrNull(file: string, follow: boolean): Promise<Stats | null> {
  try {
    return await (follow ? stat(file) : lstat(file));
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

/** Runs a read; an unreadable file leaves the answer to git, which meets the same failure. */
async function orGit<T>(read: () => Promise<T | undefined>): Promise<T | undefined> {
  try {
    return await read();
  } catch (error) {
    // Permissions, I/O, or a file replaced mid-read: git reports this case in its own terms, so
    // the caller's git fallback gives the exact result.
    if (isSystemError(error)) return undefined;
    throw error;
  }
}

/** A gitfile or commondir path: git strips only trailing line breaks. */
function pointerPath(content: string): string | undefined {
  const value = content.replace(/[\r\n]+$/, '');
  return value && !/[\r\n\0]/.test(value) ? value : undefined;
}

/**
 * Whether git reads this repository through the files ref backend these readers implement: format
 * version 0 or 1, and `extensions.refStorage` unset, or `files` in a version 1 repository (git
 * refuses the extension in version 0). Reftable or a newer format is left to git.
 */
function filesRefBackend(local: GitConfigEntries): boolean {
  const last = (name: string) => {
    const found = local.filter(([key]) => key === name);
    return found.length ? found[found.length - 1][1] : undefined;
  };
  const version = last('core.repositoryformatversion');
  if (version !== undefined && version !== '0' && version !== '1') return false;
  const storage = last('extensions.refstorage');
  return storage === undefined || (version === '1' && storage === 'files');
}

/**
 * The checkout's Git directories, or undefined when git would not take them from
 * `<worktree>/.git` alone: no `.git` (git searches parent directories), another owner
 * (safe.directory), a Git environment override, or a directory that is not a repository.
 * Also undefined when git would not answer the way these readers do: a config file git rejects or
 * that includes another, or a ref backend other than files. Open a checkout for each read: the
 * config check costs a stat per file while the files are unchanged.
 */
export function openGitCheckout(worktree: string): Promise<GitCheckout | undefined> {
  return orGit(async () => {
    if (GIT_ENVIRONMENT.some((name) => process.env[name] !== undefined)) return undefined;
    const uid = process.getuid?.();
    // Root follows SUDO_UID ownership rules; leave those to git.
    if (uid === undefined || uid === 0) return undefined;
    const marker = path.join(worktree, '.git');
    const markerStat = await statOrNull(marker, true);
    if (!markerStat) return undefined;
    let gitDir: string;
    if (markerStat.isDirectory()) gitDir = marker;
    else if (markerStat.isFile()) {
      const content = await readFile(marker, 'utf8');
      const pointer = content.startsWith('gitdir: ') ? pointerPath(content.slice(8)) : undefined;
      if (!pointer) return undefined;
      // git reports the real path of a gitfile's directory.
      gitDir = await realpath(path.resolve(worktree, pointer));
    } else return undefined;
    const commonFile = await statOrNull(path.join(gitDir, 'commondir'), true);
    let commonDir = gitDir;
    if (commonFile) {
      const pointer = pointerPath(await readFile(path.join(gitDir, 'commondir'), 'utf8'));
      if (!pointer) return undefined;
      commonDir = path.resolve(gitDir, pointer);
    }
    // git's ownership check reads the checkout, its `.git` and the Git directory.
    for (const owned of [worktree, marker, gitDir]) {
      const [link, target] = await Promise.all([lstat(owned), stat(owned)]);
      if (link.uid !== uid || target.uid !== uid) return undefined;
    }
    for (const directory of ['objects', 'refs']) {
      const entry = await statOrNull(path.join(commonDir, directory), true);
      if (!entry?.isDirectory()) return undefined;
    }
    // Every git command loads the whole config and checks the repository format before it reads
    // a ref; where it would fail or read refs another way, so does every read here: git answers.
    const checkout = { worktree, gitDir, commonDir };
    if (!(await readGitConfig(checkout))) return undefined;
    const local = await readConfigFile(path.join(commonDir, 'config'));
    if (!local || !filesRefBackend(local)) return undefined;
    return checkout;
  });
}

/**
 * `test -f <worktree>/.git`: linked worktrees and submodules have a `.git` file. Any stat
 * failure reads as false, as it does for `test -f`.
 */
export async function isGitFile(worktree: string): Promise<boolean | undefined> {
  try {
    return (await stat(path.join(worktree, '.git'))).isFile();
  } catch (error) {
    // `test -f` is false for every path it cannot stat; other failures leave it to the shell.
    if (
      isSystemError(error) &&
      ['ENOENT', 'ENOTDIR', 'EACCES', 'ELOOP', 'ENAMETOOLONG'].includes(error.code ?? '')
    )
      return false;
    if (isSystemError(error)) return undefined;
    throw error;
  }
}

/** Names git would resolve without special rules: no traversal, controls or odd separators. */
function plainRefName(name: string): boolean {
  return (
    !!name &&
    !name.startsWith('/') &&
    !name.endsWith('/') &&
    !name.includes('//') &&
    !name.split('/').some((part) => part === '.' || part === '..') &&
    !/[\0-\x20\x7f~^:?*[\\]/.test(name) &&
    !name.includes('@{') &&
    !name.endsWith('.lock')
  );
}

/** Loose ref contents, as files_read_raw_ref parses them; undefined for a broken ref. */
function parseLooseRef(content: string): GitRefValue | undefined {
  const text = content.replace(/\s+$/, '');
  if (text.startsWith('ref:')) {
    const target = text.slice(4).replace(/^\s+/, '');
    return plainRefName(target) ? { symref: target } : undefined;
  }
  const sha = /^([0-9a-f]{40}|[0-9a-f]{64})(?:\s|$)/.exec(text)?.[1];
  return sha ? { sha } : undefined;
}

interface PackedRefsCache {
  identity: string;
  lookups: Map<string, string | null>;
}
const packedRefsCache = new Map<string, PackedRefsCache>();

function fileIdentity(entry: Stats): string {
  return [entry.dev, entry.ino, entry.size, entry.mtimeMs, entry.ctimeMs].join(':');
}

/** Whether a packed-refs file parses as git's packed backend requires; false leaves it to git. */
function validPackedRefs(buffer: Buffer): boolean {
  const text = buffer.toString('latin1');
  if (text && !text.endsWith('\n')) return false;
  const lines = text.split('\n');
  lines.pop();
  let sorted = false;
  let previous: string | undefined;
  const seen = new Set<string>();
  let canPeel = false;
  for (const [index, line] of lines.entries()) {
    if (index === 0 && line.startsWith('#')) {
      if (!line.startsWith('# pack-refs with: ')) return false;
      sorted = line.slice(18).split(' ').includes('sorted');
      continue;
    }
    if (line.startsWith('^')) {
      if (!canPeel || !HEX.test(line.slice(1))) return false;
      canPeel = false;
      continue;
    }
    const space = line.indexOf(' ');
    const name = line.slice(space + 1);
    if (space < 0 || !HEX.test(line.slice(0, space)) || !name) return false;
    // A duplicate, or a file that claims order it lacks, makes git's lookup differ from a scan.
    if (previous !== undefined && (name === previous || (sorted && name < previous))) return false;
    if (!sorted) {
      if (seen.has(name)) return false;
      seen.add(name);
    }
    previous = name;
    canPeel = true;
  }
  return true;
}

/** A packed ref's value: null when absent, undefined when git must read the file itself. */
async function packedRef(commonDir: string, name: string): Promise<string | null | undefined> {
  const file = path.join(commonDir, 'packed-refs');
  let handle;
  try {
    handle = await open(file, 'r');
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
  try {
    const identity = fileIdentity(await handle.stat());
    let cached = packedRefsCache.get(file);
    if (cached?.identity === identity && cached.lookups.has(name)) return cached.lookups.get(name);
    const buffer = await handle.readFile();
    if (cached?.identity !== identity) {
      // Git rewrites packed-refs through a lock file and rename, so a new identity is a new file.
      if (!validPackedRefs(buffer)) return undefined;
      cached = { identity, lookups: new Map() };
      packedRefsCache.set(file, cached);
    }
    let value: string | null = null;
    const needle = Buffer.from(` ${name}\n`);
    for (let at = buffer.indexOf(needle); at >= 0; at = buffer.indexOf(needle, at + 1)) {
      const start = buffer.lastIndexOf(0x0a, at - 1) + 1;
      const sha = buffer.toString('latin1', start, at);
      if (HEX.test(sha)) {
        value = sha;
        break;
      }
    }
    cached.lookups.set(name, value);
    return value;
  } finally {
    await handle.close();
  }
}

/** Root refs (HEAD, ORIG_HEAD) and per-worktree refs live in gitDir; the rest are shared. */
function looseRefPath(checkout: GitCheckout, name: string): string {
  const perWorktree =
    !name.startsWith('refs/') ||
    ['refs/bisect/', 'refs/worktree/', 'refs/rewritten/'].some((prefix) => name.startsWith(prefix));
  return path.join(perWorktree ? checkout.gitDir : checkout.commonDir, name);
}

/** One ref, loose before packed: null when absent, undefined when git must read it. */
export async function readRef(
  checkout: GitCheckout,
  name: string,
): Promise<GitRefValue | null | undefined> {
  if (!plainRefName(name)) return undefined;
  const file = looseRefPath(checkout, name);
  const entry = await statOrNull(file, false);
  if (entry?.isSymbolicLink()) return undefined;
  if (entry?.isFile()) return parseLooseRef(await readFile(file, 'utf8'));
  // A directory where the loose ref would be still leaves a packed ref possible.
  if (entry && !entry.isDirectory()) return undefined;
  const sha = await packedRef(checkout.commonDir, name);
  return sha === undefined ? undefined : sha === null ? null : { sha };
}

/** The commit a ref resolves to through its symrefs, as `git rev-parse --verify` reads it. */
async function resolveRef(checkout: GitCheckout, name: string): Promise<string | null | undefined> {
  let current = name;
  for (let depth = 0; depth <= SYMREF_MAX_DEPTH; depth++) {
    const value = await readRef(checkout, current);
    if (!value) return value;
    if ('sha' in value) return value.sha;
    current = value.symref;
  }
  return undefined;
}

/** Whether `refs_ref_exists` holds: the name resolves to a commit through any symrefs. */
async function refExists(checkout: GitCheckout, name: string): Promise<boolean | undefined> {
  // A root ref name must be all capitals and underscores, else git does not read it at all.
  if (!name.startsWith('refs/') && !/^[A-Z_]+$/.test(name)) return false;
  const sha = await resolveRef(checkout, name);
  return sha === undefined ? undefined : sha !== null;
}

/** HEAD, read as git reads it. A symref chain or a non-`refs/` target leaves it to git. */
export function readGitHead(checkout: GitCheckout): Promise<GitHeadState | undefined> {
  return orGit(async () => {
    const file = path.join(checkout.gitDir, 'HEAD');
    if ((await lstat(file)).isSymbolicLink()) return undefined;
    const head = parseLooseRef(await readFile(file, 'utf8'));
    if (!head) return undefined;
    if ('sha' in head) return { kind: 'detached', sha: head.sha };
    // Reftable keeps a placeholder HEAD; its refs need git's resolver.
    if (!head.symref.startsWith('refs/') || head.symref === 'refs/heads/.invalid') return undefined;
    const target = await readRef(checkout, head.symref);
    if (target === undefined || (target && 'symref' in target)) return undefined;
    return { kind: 'branch', ref: head.symref, sha: target ? target.sha : null };
  });
}

/** The short name of `ref` under rule `rule`, as git's match_parse_rule reads it. */
function shortNameUnder(rule: string, ref: string): string | undefined {
  const [prefix, suffix] = rule.split('%s');
  if (!ref.startsWith(prefix) || !ref.endsWith(suffix)) return undefined;
  const short = ref.slice(prefix.length, ref.length - suffix.length);
  return short || undefined;
}

/**
 * git's shorten_unambiguous_ref: `strict` (`rev-parse --abbrev-ref` with
 * core.warnAmbiguousRefs) checks every rule for a competing ref, otherwise (`symbolic-ref
 * --short`) only the rules before the matching one.
 */
export function shortenRefName(
  checkout: GitCheckout,
  ref: string,
  strict: boolean,
): Promise<string | undefined> {
  return orGit(async () => {
    for (let rule = REV_PARSE_RULES.length - 1; rule > 0; rule--) {
      const short = shortNameUnder(REV_PARSE_RULES[rule], ref);
      if (short === undefined) continue;
      const checked = strict ? REV_PARSE_RULES.length : rule;
      let ambiguous = false;
      for (let other = 0; other < checked && !ambiguous; other++) {
        if (other === rule) continue;
        const exists = await refExists(checkout, REV_PARSE_RULES[other].replace('%s', short));
        if (exists === undefined) return undefined;
        ambiguous = exists;
      }
      if (!ambiguous) return short;
    }
    return ref;
  });
}

/** `git rev-parse HEAD` and `git rev-parse --abbrev-ref HEAD`; undefined for an unborn HEAD. */
export function readHeadProbe(
  checkout: GitCheckout,
): Promise<{ branch: string; headSha: string } | undefined> {
  return orGit(async () => {
    const head = await readGitHead(checkout);
    // An unborn branch makes rev-parse print its argument and fail; leave that output to git.
    if (!head || head.sha === null) return undefined;
    if (head.kind === 'detached') return { branch: 'HEAD', headSha: head.sha };
    const [strict, loose] = await Promise.all([
      shortenRefName(checkout, head.ref, true),
      shortenRefName(checkout, head.ref, false),
    ]);
    if (strict === undefined || loose === undefined) return undefined;
    // Only a name both modes shorten differently needs core.warnAmbiguousRefs.
    if (strict === loose) return { branch: strict, headSha: head.sha };
    const config = await readGitConfig(checkout);
    const warn = config ? configBool(config, 'core.warnambiguousrefs', true) : undefined;
    return warn === undefined ? undefined : { branch: warn ? strict : loose, headSha: head.sha };
  });
}

/**
 * `git symbolic-ref --quiet --short <name>`: the short target, null when the ref is missing or
 * not symbolic (exit 1), undefined when git must answer.
 */
export function readSymbolicRefShort(
  checkout: GitCheckout,
  name: string,
): Promise<string | null | undefined> {
  return orGit(async () => {
    const value = await readRef(checkout, name);
    if (value === undefined) return undefined;
    if (!value || 'sha' in value) return null;
    // symbolic-ref follows a chain to its last symref; leave chains to git.
    const target = await readRef(checkout, value.symref);
    if (target === undefined || (target && 'symref' in target)) return undefined;
    return shortenRefName(checkout, value.symref, false);
  });
}

/** Whether `git for-each-ref <name>` lists `name` itself. */
export function gitRefListed(checkout: GitCheckout, name: string): Promise<boolean | undefined> {
  return orGit(() => refExists(checkout, name));
}

// ─── Config ───

interface ConfigFileCache {
  identity: string;
  entries: GitConfigEntries | undefined;
}
const configFileCache = new Map<string, ConfigFileCache>();
let configScopePaths: Promise<string[] | undefined> | undefined;

/** git's isspace: space, tab, line feed, carriage return. */
const isGitSpace = (c: string) => c === ' ' || c === '\t' || c === '\n' || c === '\r';
const isKeyChar = (c: string) => /^[A-Za-z0-9-]$/.test(c);

/**
 * A config file's variables, parsed as git's config parser does. Undefined for a file git would
 * reject, or one that includes another file: git must read those itself.
 */
export function parseGitConfig(source: string): GitConfigEntries | undefined {
  const text = source.startsWith('\uFEFF') ? source.slice(1) : source;
  const entries: Array<readonly [string, string | null]> = [];
  let at = 0;
  let eof = false;
  const next = (): string => {
    if (at >= text.length) {
      eof = true;
      return '\n';
    }
    const c = text[at++];
    if (c === '\r' && text[at] === '\n') {
      at++;
      return '\n';
    }
    return c;
  };
  const section = (): string | undefined => {
    let name = '';
    for (;;) {
      let c = next();
      if (eof) return undefined;
      if (c === ']') return name;
      if (isGitSpace(c)) {
        while (isGitSpace(c)) {
          if (c === '\n') return undefined;
          c = next();
        }
        if (c !== '"') return undefined;
        name += '.';
        for (;;) {
          c = next();
          if (c === '\n') return undefined;
          if (c === '"') break;
          if (c === '\\') {
            c = next();
            if (c === '\n') return undefined;
          }
          name += c;
        }
        return next() === ']' ? name : undefined;
      }
      if (!isKeyChar(c) && c !== '.') return undefined;
      name += c.toLowerCase();
    }
  };
  const value = (): string | undefined => {
    let quoted = false;
    let comment = false;
    // Unquoted whitespace after the value so far: dropped at the end, kept inside the value.
    let spaces = '';
    let result = '';
    for (;;) {
      let c = next();
      if (c === '\n') return quoted ? undefined : result;
      if (comment) continue;
      if (isGitSpace(c) && !quoted) {
        if (result) spaces += c;
        continue;
      }
      if (!quoted && (c === ';' || c === '#')) {
        comment = true;
        continue;
      }
      // Git before 2.43 turned each inner whitespace character into a space; later versions keep
      // it. Only spaces read the same under both.
      if (/[^ ]/.test(spaces)) return undefined;
      result += spaces;
      spaces = '';
      if (c === '\\') {
        c = next();
        if (c === '\n') continue;
        const escaped = { t: '\t', b: '\b', n: '\n', '\\': '\\', '"': '"' }[c];
        if (escaped === undefined) return undefined;
        result += escaped;
        continue;
      }
      if (c === '"') {
        quoted = !quoted;
        continue;
      }
      result += c;
    }
  };
  let base = '';
  let comment = false;
  for (;;) {
    let c = next();
    if (c === '\n') {
      if (eof) return entries;
      comment = false;
      continue;
    }
    if (comment || isGitSpace(c)) continue;
    if (c === '#' || c === ';') {
      comment = true;
      continue;
    }
    if (c === '[') {
      const name = section();
      if (!name) return undefined;
      base = name;
      continue;
    }
    if (!/^[A-Za-z]$/.test(c) || !base) return undefined;
    let key = c.toLowerCase();
    for (;;) {
      c = next();
      if (eof || !isKeyChar(c)) break;
      key += c.toLowerCase();
    }
    while (c === ' ' || c === '\t') c = next();
    let entryValue: string | null = null;
    if (c !== '\n') {
      if (c !== '=') return undefined;
      const parsed = value();
      if (parsed === undefined) return undefined;
      entryValue = parsed;
    }
    const name = `${base}.${key}`;
    if (name === 'include.path' || (name.startsWith('includeif.') && name.endsWith('.path')))
      return undefined;
    entries.push([name, entryValue]);
  }
}

/** git's boolean config value; undefined for one git would reject or that needs units. */
function parseConfigBool(value: string | null): boolean | undefined {
  if (value === null) return true;
  if (value === '' || /^(false|no|off)$/i.test(value)) return false;
  if (/^(true|yes|on)$/i.test(value)) return true;
  if (/^[-+]?\d+$/.test(value)) return Number(value) !== 0;
  return undefined;
}

/** The last value of a boolean variable, or `fallback` when unset. */
export function configBool(
  entries: GitConfigEntries,
  name: string,
  fallback: boolean,
): boolean | undefined {
  const found = entries.filter(([key]) => key === name);
  return found.length ? parseConfigBool(found[found.length - 1][1]) : fallback;
}

async function readConfigFile(file: string): Promise<GitConfigEntries | undefined> {
  const entry = await statOrNull(file, true);
  if (!entry) return [];
  const identity = fileIdentity(entry);
  const cached = configFileCache.get(file);
  if (cached?.identity === identity) return cached.entries;
  const content = await readFile(file, 'utf8');
  // Stat after reading: content written in between gets a new identity and is read again.
  const after = await stat(file);
  const entries = parseGitConfig(content);
  if (fileIdentity(after) === identity) configFileCache.set(file, { identity, entries });
  return entries;
}

/** System then global config files as this gateway's git names them; 'retry' after a timeout. */
async function readConfigScopes(): Promise<string[] | undefined | 'retry'> {
  const [system, global] = await Promise.all(
    ['GIT_CONFIG_SYSTEM', 'GIT_CONFIG_GLOBAL'].map((name) =>
      runGit(['var', name], { timeout: 5000, cwd: '/' }),
    ),
  );
  if ([system, global].some((result) => result.exitCode === GIT_TIMEOUT_EXIT_CODE)) return 'retry';
  if (system.exitCode !== 0 || global.exitCode !== 0) {
    // Before git 2.42 these variables do not exist: config reads stay git processes.
    console.warn(
      `[git] git var cannot name the config files; config reads use git: ${(system.stderr || global.stderr).trim()}`,
    );
    return undefined;
  }
  return [...system.stdout.split('\n'), ...global.stdout.split('\n')].filter(Boolean);
}

/** Resolved once per process: the gateway's environment and git do not change under it. */
function configScopes(): Promise<string[] | undefined> {
  if (!configScopePaths) {
    const pending = readConfigScopes().then((scopes) => {
      if (scopes !== 'retry') return scopes;
      // A slow host is not an answer: ask again on the next read.
      if (configScopePaths === pending) configScopePaths = undefined;
      return undefined;
    });
    configScopePaths = pending;
  }
  return configScopePaths;
}

/**
 * The variables `git config` sees in this checkout, in git's order: system, global, local, then
 * the worktree file when extensions.worktreeConfig is on.
 */
export function readGitConfig(checkout: GitCheckout): Promise<GitConfigEntries | undefined> {
  return orGit(async () => {
    const scopes = await configScopes();
    if (!scopes) return undefined;
    const entries: Array<readonly [string, string | null]> = [];
    for (const file of scopes) {
      const read = await readConfigFile(file);
      if (!read) return undefined;
      entries.push(...read);
    }
    const local = await readConfigFile(path.join(checkout.commonDir, 'config'));
    if (!local) return undefined;
    entries.push(...local);
    const worktreeConfig = configBool(local, 'extensions.worktreeconfig', false);
    if (worktreeConfig === undefined) return undefined;
    if (worktreeConfig) {
      const own = await readConfigFile(path.join(checkout.gitDir, 'config.worktree'));
      if (!own) return undefined;
      entries.push(...own);
    }
    return entries;
  });
}

/**
 * What `defaultBranchProbeCommand` reports for this checkout, read from its files: the same
 * output text, read by the same parser.
 */
export function readDefaultBranchProbeFiles(
  checkout: GitCheckout,
  defaultBranch: string,
): Promise<DefaultBranchProbe | undefined> {
  return orGit(async () => {
    const config = await readGitConfig(checkout);
    if (!config) return undefined;
    const refs = Object.values(defaultBranchRefs(defaultBranch)).sort();
    const listed = await Promise.all(refs.map((name) => gitRefListed(checkout, name)));
    if (listed.includes(undefined)) return undefined;
    const values = (name: string) =>
      config.filter(([key]) => key === name).map(([, value]) => value ?? '');
    // `out=$(git config ...)`: each value on its own line, trailing line breaks dropped.
    const captured = (lines: string[]) =>
      lines
        .map((line) => `${line}\n`)
        .join('')
        .replace(/\n+$/, '');
    // `printf '%s\n' "$out" | sed '/^$/d; s/^/<label>=/'`
    const labelled = (label: string, out: string) =>
      out
        .split('\n')
        .filter(Boolean)
        .map((line) => `${label}=${line}\n`)
        .join('');
    const blindRun = values('farmslot.blindrun');
    const fetch = values('remote.origin.fetch');
    const stdout = [
      `blind-run=${captured(blindRun.slice(-1))}\n`,
      `fetch-exit=${fetch.length ? 0 : 1}\n`,
      labelled('fetch', captured(fetch)),
      'refs-exit=0\n',
      labelled('ref', captured(refs.filter((_, index) => listed[index]))),
      'probe=done\n',
    ].join('');
    return readDefaultBranchProbe({ stdout, stderr: '', exitCode: 0 }, defaultBranch);
  });
}

// ─── git.run implementation ───

/**
 * Run git with the given argv; resolves (never rejects) so callers branch on exitCode.
 * Returns GIT_TIMEOUT_EXIT_CODE (124) when the process is killed by the timeout.
 * Routes through execFileArgv to get exec metrics, cleanup scope, and process-group kill.
 */
function runGit(argv: string[], options?: GitRunOptions): Promise<GitResult> {
  return withHostOperation(GIT_OPS.run, () =>
    execFileArgv(['git', ...argv], {
      cwd: options?.cwd,
      timeout: options?.timeout,
      maxBuffer: options?.maxBuffer ?? 64 * 1024,
    }),
  );
}

// ─── Service instance ───

export const gitService: GitService = {
  openCheckout: openGitCheckout,
  isGitFile,
  readHead: readGitHead,
  readRef,
  readSymbolicRef: readSymbolicRefShort,
  shortenRef: shortenRefName,
  readConfig: readGitConfig,
  readHeadProbe,
  readDefaultBranchProbe: readDefaultBranchProbeFiles,
  run: runGit,
};

export default gitService;
