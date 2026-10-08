import { readdir, readFile, realpath } from 'node:fs/promises';
import { homedir, hostname } from 'node:os';
import path from 'node:path';

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

/**
 * Pool files every loader skips: non-JSON, the committed template, and the
 * repo's own demo pool (the self-integration example) unless FARMSLOT_DEMO_POOL=1
 * opts it in — a fresh install must not surface demo slots nobody asked for.
 */
export function isIgnoredPoolFile(file: string, env: NodeJS.ProcessEnv = process.env): boolean {
  if (!file.endsWith('.json')) return true;
  if (/^agent-contexts-\d+\.json$/u.test(file)) return true;
  if (file === 'example.json') return true;
  if (file === 'farmslot-demo.json') return env.FARMSLOT_DEMO_POOL !== '1';
  return false;
}

/**
 * The pool directory a process outside the Farmslot checkout can name:
 * FARMSLOT_POOL_DIR, else `$FARMSLOT_ROOT/pool`, else none.
 */
export function slotPoolDir(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const poolDir = env.FARMSLOT_POOL_DIR?.trim();
  if (poolDir) return path.resolve(poolDir);
  const root = env.FARMSLOT_ROOT?.trim();
  return root ? path.join(path.resolve(root), 'pool') : undefined;
}

/**
 * The slot whose `repo` is `realTarget` (already a real path), or null.
 * Prefers a slot on this machine when several pools map the same path; skips
 * ignored and unparsable pool files. An unreadable pool directory throws.
 */
export async function findSlotByRepo<P extends SlotPoolFile = SlotPoolFile>(
  poolDir: string,
  realTarget: string,
): Promise<SlotByRepoMatch<P> | null> {
  const files = await readdir(poolDir);
  const localHost = hostname().replace(/\.local$/u, '');
  const isLocalHost = (host: string) =>
    host === 'localhost' || host === '127.0.0.1' || host.replace(/\.local$/u, '') === localHost;
  let fallback: SlotByRepoMatch<P> | null = null;
  for (const file of [...files].sort()) {
    if (isIgnoredPoolFile(file)) continue;
    let pool: P;
    try {
      pool = JSON.parse(await readFile(path.join(poolDir, file), 'utf-8')) as P;
    } catch {
      // Invalid pool files are skipped, as every pool loader skips them.
      continue;
    }
    for (const slot of Array.isArray(pool.slots) ? pool.slots : []) {
      const repo = slot.repo ?? '';
      if (!repo) continue;
      const expanded = repo.startsWith('~/') ? path.join(homedir(), repo.slice(2)) : repo;
      if (!path.isAbsolute(expanded)) continue;
      const real = await realpath(expanded).catch((err: NodeJS.ErrnoException) => {
        // A pool entry pointing at a missing checkout is a normal non-match.
        if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return null;
        throw err;
      });
      if (real !== realTarget) continue;
      const match: SlotByRepoMatch<P> = { pool, slot, poolFile: path.join(poolDir, file) };
      if (isLocalHost(pool.host ?? '') || pool.machine === localHost) return match;
      fallback = fallback ?? match;
    }
  }
  return fallback;
}
