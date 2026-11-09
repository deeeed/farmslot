import { currentFarmPaths } from '@farmslot/protocol/node/farm-paths';
import { existsSync } from 'node:fs';
import path from 'node:path';

const ROOT_MARKERS = ['CLAUDE.md', 'scripts/dev.sh', 'services/gateway/package.json'];

export function hasFarmslotRootMarkers(candidate: string): boolean {
  return ROOT_MARKERS.every((marker) => existsSync(path.join(candidate, marker)));
}

export function resolveFarmslotRoot(
  startDir = process.cwd(),
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (env.FARMSLOT_ROOT) {
    const resolved = path.resolve(env.FARMSLOT_ROOT);
    if (!hasFarmslotRootMarkers(resolved)) {
      throw new Error(`FARMSLOT_ROOT does not point to a Farmslot repo root: ${resolved}`);
    }
    return resolved;
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

export function resolveRunsDir(farmslotRoot: string, env: NodeJS.ProcessEnv = process.env): string {
  return currentFarmPaths('gateway', env, farmslotRoot).state.runs;
}

export function sanitizeBundleRunId(runId: string): string {
  return runId.replace(/[^a-zA-Z0-9._-]/g, '_');
}
