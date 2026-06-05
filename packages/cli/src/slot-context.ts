import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const FARMSLOT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

interface PoolSlot {
  id?: unknown;
  repo?: unknown;
}

interface PoolConfig {
  machine?: unknown;
  host?: unknown;
  slots?: unknown;
}

export interface CurrentSlotMatch {
  slotId: string;
  repo: string;
  poolFile: string;
}

function expandHome(input: string): string {
  if (input === '~') return os.homedir();
  if (input.startsWith('~/')) return path.join(os.homedir(), input.slice(2));
  return input;
}

function realpathIfExists(input: string): string {
  return existsSync(input) ? realpathSync(input) : path.resolve(input);
}

function isPathInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function normalizeLocalName(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\.local$/u, '') : '';
}

function isLocalPool(pool: PoolConfig): boolean {
  const hostname = normalizeLocalName(os.hostname());
  const host = normalizeLocalName(pool.host);
  const machine = normalizeLocalName(pool.machine);
  return (
    pool.host === 'localhost' ||
    pool.host === '127.0.0.1' ||
    host === hostname ||
    machine === hostname
  );
}

function readPoolConfig(poolFile: string): PoolConfig {
  try {
    return JSON.parse(readFileSync(poolFile, 'utf8')) as PoolConfig;
  } catch (err) {
    throw new Error(
      `Invalid pool config ${poolFile}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

export function resolveCurrentSlot(
  cwd = process.cwd(),
  farmslotRoot = process.env.FARMSLOT_ROOT || FARMSLOT_ROOT,
): CurrentSlotMatch | null {
  const poolDir = path.join(farmslotRoot, 'pool');
  if (!existsSync(poolDir)) return null;

  const target = realpathIfExists(cwd);
  const matches: Array<CurrentSlotMatch & { local: boolean }> = [];

  for (const fileName of readdirSync(poolDir)) {
    if (!fileName.endsWith('.json')) continue;
    const poolFile = path.join(poolDir, fileName);
    const pool = readPoolConfig(poolFile);
    if (!Array.isArray(pool.slots)) continue;

    for (const rawSlot of pool.slots) {
      const slot = rawSlot as PoolSlot;
      if (typeof slot.id !== 'string' || typeof slot.repo !== 'string') continue;
      const expandedRepo = expandHome(slot.repo);
      const repo = realpathIfExists(
        path.isAbsolute(expandedRepo) ? expandedRepo : path.resolve(farmslotRoot, expandedRepo),
      );
      if (!isPathInside(repo, target)) continue;
      matches.push({ slotId: slot.id, repo, poolFile, local: isLocalPool(pool) });
    }
  }

  const localMatch = matches.find((match) => match.local);
  const match = localMatch ?? matches[0];
  if (!match) return null;
  return { slotId: match.slotId, repo: match.repo, poolFile: match.poolFile };
}

export function resolveSlotId(id?: string): string {
  if (id) return id;
  const match = resolveCurrentSlot();
  if (match) return match.slotId;
  throw new Error('Could not infer slot from current directory; pass a slot id.');
}
