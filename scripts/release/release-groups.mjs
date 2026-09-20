import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packagesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../packages');

/**
 * Every workspace under packages/ that is not private, dependency-first so a
 * cut lists @farmslot/protocol before the packages that pin it. Derived from
 * the manifests rather than hand-listed: the list used to omit packages that
 * were published (handoff) or bumped but never published (capabilities 0.1.1).
 */
export function publishableWorkspaces() {
  const manifests = [];
  for (const dir of readdirSync(packagesDir, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    const manifestPath = path.join(packagesDir, dir.name, 'package.json');
    let pkg;
    try {
      pkg = JSON.parse(readFileSync(manifestPath, 'utf8'));
    } catch (error) {
      if (error && error.code === 'ENOENT') continue;
      throw error;
    }
    if (pkg.private === true) continue;
    const deps = Object.keys({
      ...(pkg.dependencies ?? {}),
      ...(pkg.peerDependencies ?? {}),
    }).filter((name) => name.startsWith('@farmslot/'));
    manifests.push({ name: pkg.name, dir: `packages/${dir.name}`, deps });
  }
  const byName = new Map(manifests.map((entry) => [entry.name, entry]));
  const ordered = [];
  const state = new Map();
  const visit = (entry) => {
    const seen = state.get(entry.name);
    if (seen === 'done') return;
    if (seen === 'visiting') throw new Error(`dependency cycle through ${entry.name}`);
    state.set(entry.name, 'visiting');
    for (const dep of entry.deps) {
      const target = byName.get(dep);
      if (target) visit(target);
    }
    state.set(entry.name, 'done');
    ordered.push(entry.dir);
  };
  for (const entry of manifests.sort((a, b) => a.name.localeCompare(b.name))) visit(entry);
  return ordered;
}

/** @typedef {{ id: string; label: string; workspaces: string[] }} ReleaseGroup */

/** @type {ReleaseGroup[]} */
export const RELEASE_GROUPS = [
  {
    id: 'hosted-cc',
    label: 'Hosted Command Center',
    workspaces: [
      'apps/command-center/ui',
      'apps/command-center',
      'services/gateway',
      'packages/protocol',
    ],
  },
  {
    id: 'companion',
    label: 'Mobile Companion',
    workspaces: ['apps/companion'],
  },
  {
    id: 'npm',
    label: 'Published npm packages',
    workspaces: publishableWorkspaces(),
  },
];

export function resolveReleaseGroup(groupId) {
  const group = RELEASE_GROUPS.find((entry) => entry.id === groupId);
  if (!group) {
    const ids = RELEASE_GROUPS.map((entry) => entry.id).join(', ');
    throw new Error(`Unknown release group '${groupId}'. Expected one of: ${ids}`);
  }
  return group;
}
