import { existsSync, readdirSync, readFileSync, type Stats, statSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { homedir, hostname } from 'node:os';
import path from 'node:path';

import { deepFreeze } from '../deep-freeze.js';
import { isRacyStamp } from '../file-stamp.js';

import { currentFarmPaths, legacyRemoteFarmPaths } from './farm-paths.js';

/** The fields of a pool file the reverse lookup reads; the rest pass through. */
export interface SlotPoolFile {
  machine?: string;
  host?: string;
  slots: SlotPoolEntry[];
}

export interface SlotPoolEntry {
  id: string;
  repo?: string;
  session?: string;
  platform?: string;
  resources?: Record<string, Record<string, string | number | boolean>>;
}

export interface SlotByRepoMatch<P extends SlotPoolFile = SlotPoolFile> {
  pool: P;
  slot: P['slots'][number];
  poolFile: string;
}

export interface SlotByRepoOptions {
  strict?: boolean;
  slotId?: string;
}

export class SlotByRepoError extends Error {
  readonly code: 'SLOT_AMBIGUOUS' | 'SLOT_NOT_FOUND';
  readonly exitCode = 2;
  readonly userAction: string;
  constructor(
    readonly candidates: string[],
    selected?: string,
  ) {
    super(
      selected
        ? `Slot ${selected} does not map this checkout.`
        : `More than one slot maps this checkout: ${candidates.join(', ')}`,
    );
    this.name = 'SlotByRepoError';
    this.code = selected ? 'SLOT_NOT_FOUND' : 'SLOT_AMBIGUOUS';
    this.userAction = 'select one matching slot with --slot <id>';
  }
}

/**
 * Pool files every loader skips: non-JSON, the committed template, and the
 * repo's own demo pool (the self-integration example) unless FARMSLOT_DEMO_POOL=1
 * opts it in — a fresh install must not surface demo slots nobody asked for.
 * readPoolFiles keeps the filtered listing until FARMSLOT_DEMO_POOL changes: another env input
 * here must join that check.
 */
export function isIgnoredPoolFile(file: string, env: NodeJS.ProcessEnv = process.env): boolean {
  if (!file.endsWith('.json')) return true;
  if (/^agent-contexts-\d+\.json$/u.test(file)) return true;
  if (file === 'example.json') return true;
  if (file === 'farmslot-demo.json') return env.FARMSLOT_DEMO_POOL !== '1';
  return false;
}

/** Where `resolveSlotPoolDir` found the pool directory. */
export type SlotPoolDirSource = 'FARMSLOT_POOL_DIR' | 'FARMSLOT_ROOT' | 'farmslot-node';

/**
 * The pool directory a process outside the Farmslot checkout reads:
 * FARMSLOT_POOL_DIR, else `$FARMSLOT_ROOT/pool`, else the node deploy
 * directory's pool (`~/farmslot-node/pool`, where deploy-node.sh installs a
 * node and slot-common.sh falls back) when it exists, else none.
 */
export function resolveSlotPoolDir(
  env: NodeJS.ProcessEnv = process.env,
): { dir: string; source: SlotPoolDirSource } | undefined {
  const poolDir = env.FARMSLOT_POOL_DIR?.trim();
  const selectedEnv = { ...env, FARMSLOT_POOL_DIR: poolDir || undefined };
  if (poolDir)
    return { dir: currentFarmPaths('node', selectedEnv).pool, source: 'FARMSLOT_POOL_DIR' };
  const root = env.FARMSLOT_ROOT?.trim();
  if (root)
    return {
      dir: currentFarmPaths('node', selectedEnv, path.resolve(root)).pool,
      source: 'FARMSLOT_ROOT',
    };
  const paths = currentFarmPaths('node', selectedEnv);
  if (paths.layout === 2) return { dir: paths.pool, source: 'FARMSLOT_ROOT' };
  const nodePool = legacyRemoteFarmPaths({ ...env, HOME: env.HOME?.trim() || homedir() }).pool;
  return existsSync(nodePool) ? { dir: nodePool, source: 'farmslot-node' } : undefined;
}

export interface PoolFileEntry<P> {
  file: string;
  pool: P;
}

/** What a pool file looked like when it was last read; any change means read it again. */
interface PoolFileStamp {
  mtimeMs: number;
  ctimeMs: number;
  size: number;
  ino: number;
}
interface CachedPoolFile {
  stamp: PoolFileStamp;
  /** The file had settled when it was read, so an equal stamp later means equal content. */
  trusted: boolean;
  entry: PoolFileEntry<unknown> | undefined;
}
interface PoolDirCache {
  dirMtimeMs: number;
  /** The directory had settled when it was listed (see CachedPoolFile.trusted). */
  listingTrusted: boolean;
  /** Every directory entry. Backups make it hundreds of entries, so it is filtered once per listing. */
  listing: string[];
  /** The FARMSLOT_DEMO_POOL value `files` was filtered with: the only env input of the filter. */
  demoPool: string | undefined;
  files: string[];
  result: PoolFileEntry<unknown>[];
}
/** Parsed pool files per directory. Slot lookups read pools on every call (several per check). */
const poolDirCache = new Map<string, PoolDirCache>();
/** Parsed pool files by path, shared by directory scans and single-file reads. */
const poolFileCache = new Map<string, CachedPoolFile>();

const stampOf = (stats: Stats): PoolFileStamp => ({
  mtimeMs: stats.mtimeMs,
  ctimeMs: stats.ctimeMs,
  size: stats.size,
  ino: stats.ino,
});
const sameStamp = (a: PoolFileStamp, b: PoolFileStamp) =>
  a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs && a.size === b.size && a.ino === b.ino;

function readPoolFile(fullPath: string): PoolFileEntry<unknown> | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(fullPath, 'utf8'));
  } catch (error) {
    // A half-written/removed pool file is not authority. Other I/O failures are actionable.
    if (
      error instanceof SyntaxError ||
      ['ENOENT', 'EISDIR'].includes((error as NodeJS.ErrnoException).code ?? '')
    )
      return undefined;
    throw error;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
  return { file: fullPath, pool: deepFreeze(parsed) };
}

/**
 * Configured pool readers skip malformed files without echoing parser input.
 *
 * Results are cached per directory and checked against the directory's and each file's stat on
 * every call, so an edited, added, renamed or removed pool file is seen at once. A file or listing
 * changed too recently for its stamp to be trusted is read again (isRacyStamp). Unchanged pools
 * are returned as the same frozen objects; callers must not mutate them.
 */
export function readPoolFiles<P = SlotPoolFile>(poolDir: string): PoolFileEntry<P>[] {
  const now = Date.now();
  const dirMtimeMs = statSync(poolDir).mtimeMs;
  const cached = poolDirCache.get(poolDir);
  const listing =
    cached && cached.listingTrusted && cached.dirMtimeMs === dirMtimeMs
      ? cached.listing
      : readdirSync(poolDir).sort();
  const demoPool = process.env.FARMSLOT_DEMO_POOL;
  const files =
    cached && cached.listing === listing && cached.demoPool === demoPool
      ? cached.files
      : listing.filter((file) => !isIgnoredPoolFile(file));
  const entries = files.flatMap((file) => {
    const entry = cachedPoolFile(path.join(poolDir, file), now)?.entry;
    return entry ? [entry] : [];
  });
  const listingTrusted =
    cached?.listing === listing ? cached.listingTrusted : !isRacyStamp(dirMtimeMs, now);
  // A directory change that adds no pool (a new backup) keeps the result but not the old listing:
  // keep the new one, or every later call lists and filters the directory again.
  const result =
    cached &&
    cached.result.length === entries.length &&
    cached.result.every((entry, index) => entry === entries[index])
      ? cached.result
      : deepFreeze(entries);
  poolDirCache.set(poolDir, { dirMtimeMs, listingTrusted, listing, demoPool, files, result });
  return result as PoolFileEntry<P>[];
}

/** A pool file from the cache, read again only when its stat changed; undefined once it is gone. */
function cachedPoolFile(fullPath: string, now: number): CachedPoolFile | undefined {
  let stats: Stats;
  try {
    stats = statSync(fullPath);
  } catch (error) {
    // Removed between listing and stat: the same as a pool file that vanished mid-read.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      poolFileCache.delete(fullPath);
      return undefined;
    }
    throw error;
  }
  const stamp = stampOf(stats);
  const previous = poolFileCache.get(fullPath);
  if (previous?.trusted && sameStamp(previous.stamp, stamp)) return previous;
  const file: CachedPoolFile = {
    stamp,
    trusted: !isRacyStamp(Math.max(stamp.mtimeMs, stamp.ctimeMs), now),
    entry: readPoolFile(fullPath),
  };
  poolFileCache.set(fullPath, file);
  return file;
}

/**
 * One pool file through the same stat-checked cache, without scanning its directory, so no other
 * pool file's failure affects it. Undefined when the file is absent, unparsable or not an object.
 */
export function readCachedPoolFile<P = SlotPoolFile>(
  fullPath: string,
): PoolFileEntry<P> | undefined {
  return cachedPoolFile(fullPath, Date.now())?.entry as PoolFileEntry<P> | undefined;
}

/**
 * The slot whose `repo` is `realTarget` (already a real path), or null.
 * Prefers a slot on this machine when several pools map the same path; skips
 * ignored and unparsable pool files. An unreadable pool directory throws.
 */
export async function findSlotByRepo<P extends SlotPoolFile = SlotPoolFile>(
  poolDir: string,
  realTarget: string,
  options: SlotByRepoOptions = {},
): Promise<SlotByRepoMatch<P> | null> {
  const localHost = hostname().replace(/\.local$/u, '');
  const isLocalHost = (host: string) =>
    host === 'localhost' || host === '127.0.0.1' || host.replace(/\.local$/u, '') === localHost;
  const local: SlotByRepoMatch<P>[] = [];
  const remote: SlotByRepoMatch<P>[] = [];
  for (const { file, pool } of readPoolFiles<P>(poolDir)) {
    for (const slot of Array.isArray(pool.slots) ? pool.slots : []) {
      if (options.slotId && slot.id !== options.slotId) continue;
      const repo = slot.repo ?? '';
      if (!repo) continue;
      const expanded = repo.startsWith('~/') ? path.join(homedir(), repo.slice(2)) : repo;
      if (!path.isAbsolute(expanded)) continue;
      const real = await realpath(expanded).catch((err: NodeJS.ErrnoException) => {
        // A missing checkout, or one a sandboxed caller may not read, is a normal non-match.
        if (['ENOENT', 'ENOTDIR', 'EPERM', 'EACCES'].includes(err.code ?? '')) return null;
        throw err;
      });
      if (real !== realTarget) continue;
      const match: SlotByRepoMatch<P> = { pool, slot, poolFile: file };
      if (isLocalHost(pool.host ?? '') || pool.machine === localHost) {
        if (!options.strict) return match;
        local.push(match);
      } else {
        remote.push(match);
      }
    }
  }
  const candidates = local.length > 0 ? local : remote;
  if (options.strict && candidates.length > 1) {
    throw new SlotByRepoError(candidates.map((match) => match.slot.id));
  }
  if (options.strict && options.slotId && candidates.length === 0)
    throw new SlotByRepoError([], options.slotId);
  return candidates[0] ?? null;
}

/** One default-off setting, read by gateway routing and the existing node service. */
export const NODE_LINK_FLAG = 'FARMSLOT_NODE_LINK_ENABLED';

export function configuredNodeLinkEnabled(machine: string, poolDirectory: string): boolean {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(machine))
    throw new Error('Invalid node machine identity');
  const file = path.join(poolDirectory, `${machine}.json`);
  // Every remote exec asks this, so the parsed pool comes from the stat-checked cache. Only its own
  // file is read: another machine's broken pool must not switch this one off or fail it.
  let pool: unknown = isIgnoredPoolFile(`${machine}.json`)
    ? undefined
    : readCachedPoolFile(file)?.pool;
  if (pool === undefined) {
    let content: string;
    try {
      content = readFileSync(file, 'utf8');
    } catch (error) {
      // Older/private installations may have no canonical machine pool yet: the pilot stays off.
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false;
      throw error;
    }
    // The cache skips an unparsable pool; this policy must still refuse it, so parse to throw.
    pool = JSON.parse(content);
  }
  if (!pool || typeof pool !== 'object' || !('machine' in pool) || pool.machine !== machine)
    throw new Error('Node-link policy requires its canonical machine pool');
  const env = 'env' in pool ? pool.env : undefined;
  if (!env || typeof env !== 'object') return false;
  const setting = Reflect.get(env, NODE_LINK_FLAG);
  if (setting !== undefined && setting !== '0' && setting !== '1')
    throw new Error(`${NODE_LINK_FLAG} must be 0 or 1`);
  return setting === '1';
}
