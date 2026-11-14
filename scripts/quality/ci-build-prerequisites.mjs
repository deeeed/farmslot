import { spawnSync } from 'node:child_process';

import { loadWorkspacePackages } from '../release/lib/workspace-utils.mjs';

// CI orders package compilers once, rather than recursively invoking build scripts.
const packages = [...loadWorkspacePackages(process.cwd())].filter(
  ([dir, pkg]) => dir.startsWith('packages/') && pkg.scripts?.build,
);
const built = new Set();
function build(dir, pkg) {
  if (built.has(pkg.name)) return;
  for (const dependency of Object.keys(pkg.dependencies ?? {})) {
    const entry = packages.find(([, candidate]) => candidate.name === dependency);
    if (entry) build(...entry);
  }
  const config = pkg.scripts.build.match(/tsc --project (\S+)/)?.[1];
  if (!config) throw new Error(`CI needs an explicit build owner for ${pkg.name}`);
  const result = spawnSync('yarn', ['exec', 'tsc', '--project', config], {
    cwd: dir,
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
  built.add(pkg.name);
}
for (const entry of packages) build(...entry);
