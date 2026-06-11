// onboarding/workspace.ts — workspace layout + state file for installed farmslot workspaces.
//
// A workspace is the directory created by install.sh:
//   <workspace>/farmslot/   — farmslot clone (this repo)
//   <workspace>/repos/      — product repo clones (one per slot)
//   <workspace>/runs/       — run archives
//   <workspace>/state.json  — onboarding state (source, packs, migrations)
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Absolute path to the farmslot repo root that this CLI runs from. */
export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

export const STATE_FILE = 'state.json';
export const STATE_SCHEMA_VERSION = 1;

export interface PackState {
  source: string;
  hash: string;
  projects: string[];
  slots: string[];
}

export interface WorkspaceState {
  schema_version: number;
  source: { mode: 'local'; path: string } | { mode: 'git'; url: string };
  machine: string;
  pool_file: string; // relative to the farmslot clone, e.g. pool/myhost.json
  packs: Record<string, PackState>;
  pool_migrations: { applied: string[] };
}

export interface Workspace {
  root: string;
  farmslotDir: string;
  reposDir: string;
  runsDir: string;
  statePath: string;
}

export function workspaceAt(root: string): Workspace {
  return {
    root,
    farmslotDir: join(root, 'farmslot'),
    reposDir: join(root, 'repos'),
    runsDir: join(root, 'runs'),
    statePath: join(root, STATE_FILE),
  };
}

function expandTilde(p: string): string {
  return p === '~' || p.startsWith('~/') ? join(homedir(), p.slice(1)) : p;
}

/**
 * Resolve the workspace this CLI belongs to.
 * Order: FARMSLOT_WORKSPACE env → parent dir of the repo clone containing state.json.
 * Returns null when this CLI runs from a plain dev checkout with no workspace.
 */
export function resolveWorkspace(env: NodeJS.ProcessEnv = process.env): Workspace | null {
  const fromEnv = env.FARMSLOT_WORKSPACE;
  if (fromEnv) return workspaceAt(resolve(expandTilde(fromEnv)));
  const parent = dirname(repoRoot);
  if (existsSync(join(parent, STATE_FILE))) return workspaceAt(parent);
  return null;
}

export function readState(ws: Workspace): WorkspaceState | null {
  if (!existsSync(ws.statePath)) return null;
  const state = JSON.parse(readFileSync(ws.statePath, 'utf-8')) as WorkspaceState;
  if (typeof state.schema_version !== 'number') {
    throw new Error(`Invalid workspace state (missing schema_version): ${ws.statePath}`);
  }
  return state;
}

export function writeState(ws: Workspace, state: WorkspaceState): void {
  writeFileSync(ws.statePath, JSON.stringify(state, null, 2) + '\n');
}
