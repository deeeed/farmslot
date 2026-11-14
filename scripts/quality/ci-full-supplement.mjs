import { spawnSync } from 'node:child_process';

import { isMainModule } from './lib/step-timing.mjs';
import { workspaceTestCatalog } from './workspace-test-targets.mjs';

export function needsSupplementarySuite(workspace) {
  if (!workspace.test || workspace.dir === 'apps/command-center-desktop') return false;
  const qualityRuns =
    workspace.dir.startsWith('packages/') || workspace.dir.startsWith('services/');
  return !qualityRuns || !/\byarn(?: run)? test(?:\s|$)/.test(workspace.quality ?? '');
}

// Package/service quality runs upstream. Apps and packages whose quality script
// omits tests need explicit full-suite ownership here. macOS owns desktop tests.
if (isMainModule(import.meta.url)) {
  for (const workspace of workspaceTestCatalog(process.cwd()).filter(needsSupplementarySuite)) {
    const result = spawnSync('yarn', ['workspace', workspace.name, 'test'], { stdio: 'inherit' });
    if (result.error) throw result.error;
    if (result.status !== 0) process.exit(result.status ?? 1);
  }
}
