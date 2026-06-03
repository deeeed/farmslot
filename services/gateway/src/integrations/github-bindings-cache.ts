// github-bindings-cache.ts — Disk-backed store for branch→PR number bindings.
// Persists the mapping observed during run pipelines so that after a gateway
// restart we can short-circuit `gh pr list --head <branch>` lookups that are
// otherwise the single biggest source of PR-discovery latency + rate spend.
//
// Layout: FARMSLOT_DIR/.farm-cache/github-bindings.json
//   { [repo]: { [branch]: { prNumber: number, at: string } } }

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { farmslotRoot } from '../core/config.js';

interface Binding {
  prNumber: number;
  at: string; // ISO-8601 when recorded
}

type BindingsFile = Record<string, Record<string, Binding>>;

const CACHE_DIR_NAME = '.farm-cache';
const CACHE_FILE_NAME = 'github-bindings.json';

let cachePath: string | null = null;
let bindings: BindingsFile = {};
let loaded = false;

function ensureCachePath(): string {
  if (cachePath) return cachePath;
  const base =
    process.env.FARMSLOT_DIR && process.env.FARMSLOT_DIR.length > 0
      ? process.env.FARMSLOT_DIR
      : farmslotRoot;
  const dir = path.join(base, CACHE_DIR_NAME);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  cachePath = path.join(dir, CACHE_FILE_NAME);
  return cachePath;
}

export function loadBindingsCache(): void {
  const file = ensureCachePath();
  try {
    if (!existsSync(file)) {
      bindings = {};
      loaded = true;
      console.log(`[github-bindings] cache empty (new file): ${file}`);
      return;
    }
    const raw = readFileSync(file, 'utf-8');
    const parsed = JSON.parse(raw) as BindingsFile;
    bindings = parsed && typeof parsed === 'object' ? parsed : {};
    loaded = true;
    const count = Object.values(bindings).reduce((n, r) => n + Object.keys(r).length, 0);
    console.log(`[github-bindings] loaded ${count} binding(s) from ${file}`);
  } catch (err) {
    console.warn(
      `[github-bindings] failed to load ${file}: ${(err as Error).message} — starting empty`,
    );
    bindings = {};
    loaded = true;
  }
}

function persist(): void {
  const file = ensureCachePath();
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(bindings, null, 2), 'utf-8');
    renameSync(tmp, file);
  } catch (err) {
    console.error(`[github-bindings] persist failed: ${(err as Error).message}`);
  }
}

export function getBinding(branch: string, repo: string): number | null {
  if (!loaded) loadBindingsCache();
  return bindings[repo]?.[branch]?.prNumber ?? null;
}

export function setBinding(branch: string, repo: string, prNumber: number): void {
  if (!loaded) loadBindingsCache();
  const repoMap = bindings[repo] ?? (bindings[repo] = {});
  const existing = repoMap[branch];
  if (existing && existing.prNumber === prNumber) return;
  repoMap[branch] = { prNumber, at: new Date().toISOString() };
  persist();
}

export function invalidateBinding(branch: string, repo: string): void {
  if (!loaded) loadBindingsCache();
  const repoMap = bindings[repo];
  if (!repoMap) return;
  if (!(branch in repoMap)) return;
  delete repoMap[branch];
  if (Object.keys(repoMap).length === 0) delete bindings[repo];
  persist();
}
