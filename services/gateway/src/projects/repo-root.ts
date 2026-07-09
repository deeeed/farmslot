import { existsSync } from 'node:fs';
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

function expandTilde(p: string): string {
  return p === '~' || p.startsWith('~/') ? path.join(homedir(), p.slice(1)) : p;
}

/**
 * Resolve the install workspace root this gateway belongs to, mirroring the CLI's
 * onboarding `resolveWorkspace` contract: FARMSLOT_WORKSPACE env → parent dir of the
 * farmslot clone that holds state.json. The gateway does not depend on @farmslot/cli,
 * so the algorithm is duplicated here; keep the two in sync.
 *
 * Returns null for a plain dev checkout with no surrounding workspace so callers can
 * leave FARMSLOT_WORKSPACE unset and let downstream defaults apply.
 */
export function resolveWorkspaceRoot(
  env: NodeJS.ProcessEnv = process.env,
  root = farmslotRoot,
): string | null {
  const fromEnv = env.FARMSLOT_WORKSPACE;
  if (fromEnv) return path.resolve(expandTilde(fromEnv));
  const parent = path.dirname(root);
  if (existsSync(path.join(parent, 'state.json'))) return parent;
  return null;
}
