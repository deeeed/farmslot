import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { currentFarmPaths } from '@farmslot/protocol/node/farm-paths';

/** Absolute path to the farmslot repo root that this CLI runs from. */
export function repoRoot(): string {
  return currentFarmPaths(
    'gateway',
    process.env,
    resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..'),
  ).code.checkout;
}
