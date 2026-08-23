import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
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
  if (runner === 'codex') assertIsolatedCodexRouting(repo, runtimeDir);
}

function assertIsolatedCodexRouting(repo, runtimeDir) {
  const operatorPath = path.join(os.homedir(), '.codex', 'config.toml');
  let operator = '';
  try {
    operator = fs.readFileSync(operatorPath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  const providerMatch = operator.match(/^model_provider\s*=\s*"([^"]+)"/m);
  if (!providerMatch) return;
  const providerId = providerMatch[1];
  const hasOperatorTable =
    operator.includes(`[model_providers.${providerId}]`) ||
    operator.includes(`[model_providers."${providerId}"]`);
  if (!hasOperatorTable) return;
  const isolatedPath = path.join(repo, runtimeDir, 'codex-home', 'config.toml');
  const isolated = fs.readFileSync(isolatedPath, 'utf8');
  if (!isolated.includes(`model_provider = "${providerId}"`)) {
    throw new Error(`isolated CODEX_HOME missing model_provider = "${providerId}" after install`);
  }
  const hasIsolatedTable =
    isolated.includes(`[model_providers.${providerId}]`) ||
    isolated.includes(`[model_providers."${providerId}"]`);
  if (!hasIsolatedTable) {
    throw new Error(`isolated CODEX_HOME missing [model_providers.${providerId}] after install`);
  }
}

export function readRegisteredEvents(runner, repo, runtimeDir) {
  if (runner === 'claude') {
    const settings = JSON.parse(
      fs.readFileSync(
        path.join(repo, runtimeDir, '.observability', 'claude-settings.json'),
        'utf8',
      ),
    );
    return Object.keys(settings.hooks).sort();
  }
  const hooksDoc = JSON.parse(
    fs.readFileSync(path.join(repo, runtimeDir, 'codex-home', 'hooks.json'), 'utf8'),
  );
  return Object.keys(hooksDoc.hooks).sort();
}

export function obsDirFor(repo, runtimeDir) {
  return path.join(repo, runtimeDir, '.observability');
}
