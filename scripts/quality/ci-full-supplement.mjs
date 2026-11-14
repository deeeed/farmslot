import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

import { workspaceTestCatalog } from './workspace-test-targets.mjs';

// Most package quality scripts own their tests. Keep explicit coverage for suites
// whose quality script only checks formatting/types, and app-only script suites.
for (const workspace of workspaceTestCatalog(process.cwd())) {
  const pkg = JSON.parse(readFileSync(`${workspace.dir}/package.json`, 'utf8'));
  if (!workspace.test || /\byarn(?: run)? test(?:\s|$)/.test(pkg.scripts?.quality ?? '')) continue;
  if (workspace.dir === 'apps/command-center-desktop') continue; // macOS job owns it.
  const result = spawnSync('yarn', ['workspace', workspace.name, 'test'], { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
