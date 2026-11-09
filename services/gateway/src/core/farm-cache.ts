// farm-cache.ts — location of the gateway's small on-disk caches.
//
// Layout: FARMSLOT_DIR/.farm-cache/<file>. FARMSLOT_DIR falls back to the
// checkout root. Shared by the branch→PR bindings cache and the warm PR list.
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';

import { currentFarmPaths } from '@farmslot/protocol/node/farm-paths';

/** Absolute path of `fileName` under the farm cache directory, creating the directory on demand. */
export function farmCacheFile(fileName: string): string {
  const dir = currentFarmPaths('gateway').state.cache;
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return path.join(dir, fileName);
}
