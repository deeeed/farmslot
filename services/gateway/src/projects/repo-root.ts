import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT_MARKERS = ['CLAUDE.md', 'scripts/dev.sh', 'services/gateway/package.json'];

function hasFarmslotRootMarkers(candidate: string): boolean {
  return ROOT_MARKERS.every((marker) => existsSync(path.join(candidate, marker)));
}

export function resolveFarmslotRoot(startDir = import.meta.dirname): string {
  const envRoot = process.env.FARMSLOT_ROOT;
  if (envRoot) {
    const resolvedEnvRoot = path.resolve(envRoot);
    if (!hasFarmslotRootMarkers(resolvedEnvRoot)) {
      throw new Error(`FARMSLOT_ROOT does not point to a Farmslot repo root: ${resolvedEnvRoot}`);
    }
    return resolvedEnvRoot;
  }

  let current = path.resolve(startDir);
  while (true) {
    if (hasFarmslotRootMarkers(current)) return current;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }

  throw new Error(`Could not resolve Farmslot repo root from ${path.resolve(startDir)}`);
}

const thisDir = import.meta.dirname ?? path.dirname(fileURLToPath(import.meta.url));
export const farmslotRoot = resolveFarmslotRoot(thisDir);
