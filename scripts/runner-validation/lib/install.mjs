import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { ROOT } from './common.mjs';

export function installHooks(runner, repo, runtimeDir, slotId) {
  execFileSync(
    process.execPath,
    [
      path.join(ROOT, 'scripts', 'install-runner-observability.mjs'),
      '--runner',
      runner,
      '--repo',
      repo,
      '--runtime-dir',
      runtimeDir,
      '--slot-id',
      slotId,
    ],
    { stdio: 'pipe' },
  );
}

export function readRegisteredEvents(runner, repo, runtimeDir = '.agent') {
  if (runner === 'claude') {
    const settings = JSON.parse(
      fs.readFileSync(
        path.join(repo, runtimeDir, '.observability', 'claude-settings.json'),
        'utf8',
      ),
    );
    return Object.keys(settings.hooks).sort();
  }
  const hooksDoc = JSON.parse(fs.readFileSync(path.join(repo, '.codex', 'hooks.json'), 'utf8'));
  return Object.keys(hooksDoc.hooks).sort();
}

export function obsDirFor(repo, runtimeDir) {
  return path.join(repo, runtimeDir, '.observability');
}
