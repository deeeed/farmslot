// farm-cache.ts — location of the gateway's small on-disk caches.
//
// Layout: FARMSLOT_DIR/.farm-cache/<file>. FARMSLOT_DIR falls back to the
// checkout root. Shared by the branch→PR bindings cache and the warm PR list.

import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';

import { farmslotRoot } from './config.js';

const CACHE_DIR_NAME = '.farm-cache';

/** Absolute path of `fileName` under the farm cache directory, creating the directory on demand. */
export function farmCacheFile(fileName: string): string {
  const base =
    process.env.FARMSLOT_DIR && process.env.FARMSLOT_DIR.length > 0
      ? process.env.FARMSLOT_DIR
      : farmslotRoot;
  const dir = path.join(base, CACHE_DIR_NAME);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return path.join(dir, fileName);
}
