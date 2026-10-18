// repo-root.ts — locate the farmslot checkout from any consumer (gateway,
// CLI verb, test) without configuration. FARMSLOT_ROOT overrides discovery.

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
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

export const WORKSPACE_STATE_FILE = 'state.json';

function expandTilde(p: string): string {
  return p === '~' || p.startsWith('~/') ? path.join(homedir(), p.slice(1)) : p;
}

/**
 * The install workspace a farmslot clone belongs to: FARMSLOT_WORKSPACE, else the clone's parent
 * dir when it holds state.json. Null for a plain dev checkout with no surrounding workspace.
 */
export function resolveWorkspaceRoot(
  env: NodeJS.ProcessEnv = process.env,
  root = farmslotRoot,
): string | null {
  const fromEnv = env.FARMSLOT_WORKSPACE;
  if (fromEnv) return path.resolve(expandTilde(fromEnv));
  const parent = path.dirname(root);
  if (existsSync(path.join(parent, WORKSPACE_STATE_FILE))) return parent;
  return null;
}

/** A workspace's onboarding state (state.json), or null when it has none. */
export function readWorkspaceState<T extends { schema_version: number }>(
  workspaceRoot: string,
): T | null {
  const file = path.join(workspaceRoot, WORKSPACE_STATE_FILE);
  let state: T | null;
  try {
    state = JSON.parse(readFileSync(file, 'utf-8')) as T | null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    if (error instanceof SyntaxError)
      throw new Error(`Invalid workspace state ${file}: ${error.message}`);
    throw error;
  }
  if (typeof state?.schema_version !== 'number') {
    throw new Error(`Invalid workspace state (missing schema_version): ${file}`);
  }
  return state;
}
