import { spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import path from 'node:path';

import { buildProjects, writeBuildReceipt } from './ci-build-state.mjs';

// CI orders package compilers once, rather than recursively invoking build scripts.
const root = process.cwd();
const projects = buildProjects(root);
for (const project of projects) {
  rmSync(path.join(root, project.dir, 'dist'), { recursive: true, force: true });
  const result = spawnSync('yarn', ['exec', 'tsc', '--project', project.config], {
    cwd: path.join(root, project.dir),
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
writeBuildReceipt(root, projects);
