import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { scanTomlLine, tomlSectionHeaderIndexes } from '../../lib/toml-scan.mjs';

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

function rootTomlModelProviderId(content) {
  const lines = content.split('\n');
  const headers = tomlSectionHeaderIndexes(lines);
  const state = { arrayDepth: 0, quote: null };
  let providerId = null;
  for (let index = 0; index < lines.length; index += 1) {
    if (headers.has(index)) break;
    if (
      state.arrayDepth === 0 &&
      state.quote === null &&
      /^\s*model_provider\s*=/.test(lines[index])
    ) {
      const raw = lines[index].replace(/^[^=]*=\s*/, '').trim();
      if (raw.startsWith('"') || raw.startsWith("'")) {
        const quote = raw[0];
        let value = '';
        for (let i = 1; i < raw.length; i += 1) {
          const char = raw[i];
          if (char === '\\' && i + 1 < raw.length) {
            value += raw[i + 1];
            i += 1;
            continue;
          }
          if (char === quote) {
            providerId = value;
            break;
          }
          value += char;
        }
      } else {
        providerId = raw.replace(/\s+#.*$/, '').trim() || null;
      }
    }
    scanTomlLine(lines[index], state);
  }
  return providerId;
}

function hasModelProviderTable(content, providerId) {
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('#') || !trimmed.startsWith('[')) continue;
    const name = trimmed.match(/^\[([^\]]+)\]/)?.[1];
    if (!name) continue;
    const parts = [];
    let current = '';
    let quote = null;
    for (let index = 0; index < name.length; index += 1) {
      const char = name[index];
      if (quote) {
        if (char === quote) {
          quote = null;
          continue;
        }
        current += char;
        continue;
      }
      if (char === '"' || char === "'") {
        quote = char;
        continue;
      }
      if (char === '.') {
        parts.push(current.trim());
        current = '';
        continue;
      }
      current += char;
    }
    parts.push(current.trim());
    if (parts[0] === 'model_providers' && parts[1] === providerId && parts.length === 2) {
      return true;
    }
  }
  return false;
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
  const providerId = rootTomlModelProviderId(operator);
  if (!providerId || !hasModelProviderTable(operator, providerId)) return;
  const isolated = fs.readFileSync(
    path.join(repo, runtimeDir, 'codex-home', 'config.toml'),
    'utf8',
  );
  if (rootTomlModelProviderId(isolated) !== providerId) {
    throw new Error(
      `isolated CODEX_HOME missing root model_provider = "${providerId}" after install`,
    );
  }
  if (!hasModelProviderTable(isolated, providerId)) {
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
