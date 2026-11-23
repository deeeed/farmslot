import { existsSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';

import type { FarmPaths, LegacyFarmStorageFacts } from './farm-paths.js';
import { expandHome } from './farmslot-home.js';

function readOptional(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
    throw error;
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** Read the same configuration and durable pairing as run-bundle/retained.ts:294.
 * Reporting never creates a store or recovers a migration.
 */
export function readLegacyStorageFacts(paths: FarmPaths): LegacyFarmStorageFacts {
  const document = readOptional(
    path.join(path.dirname(paths.data.runBundles), 'run-bundle-retention.json'),
  );
  let configured: string | undefined;
  if (document !== undefined) {
    if (!record(document) || !record(document.runBundleRetention))
      throw new Error('Invalid runBundleRetention settings.');
    const root = document.runBundleRetention.storeRoot;
    if (root !== undefined) {
      if (typeof root !== 'string') throw new Error('Invalid runBundleRetention.storeRoot.');
      configured = expandHome(root);
      if (!path.isAbsolute(configured))
        throw new Error('runBundleRetention.storeRoot must be absolute.');
      configured = path.resolve(configured);
    }
  }
  const binding = readOptional(path.join(paths.state.runs, 'bundle-store.json'));
  if (binding === undefined) return { runBundles: configured ?? paths.data.runBundles };
  // The store may sit on a volume that is not mounted. Its pairing cannot be
  // checked then, but reporting must not fail: a node that threw here never
  // connected (macwork, c910ssd unmounted). The bound root is reported as is,
  // and whatever uses it meets the outage there.
  if (record(binding) && typeof binding.root === 'string') {
    const missing = [binding.root, configured].find(
      (root): root is string => typeof root === 'string' && !existsSync(root),
    );
    if (missing)
      return {
        runBundles: binding.root,
        unavailable: `Run bundle store ${missing} is unavailable (is its volume mounted?)`,
      };
  }
  if (
    !record(binding) ||
    binding.version !== 1 ||
    typeof binding.id !== 'string' ||
    !binding.id ||
    binding.runsDir !== realpathSync(paths.state.runs) ||
    typeof binding.root !== 'string' ||
    !path.isAbsolute(binding.root)
  )
    throw new Error('Run bundle store pairing does not match the canonical Run store.');
  if (configured && realpathSync(configured) !== realpathSync(binding.root))
    throw new Error(
      'Run bundle store pairing does not match the configured root; use the migration command.',
    );
  const owner = readOptional(path.join(binding.root, 'store.json'));
  if (!owner || JSON.stringify(owner) !== JSON.stringify(binding))
    throw new Error('Run bundle root belongs to a different Run store.');
  return { runBundles: binding.root };
}
