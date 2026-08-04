import os from 'node:os';
import path from 'node:path';

import type { loadSlotVars } from '../core/config.js';
import { shellExpressionForRemotePath } from '../core/remote-paths.js';
import { shellQuote } from '../core/tmux.js';
import { farmslotRoot } from '../projects/repo-root.js';

const REMOTE_AGENT_DIR = '~/farmslot-node';
const INSTALLER_RELATIVE_PATH = 'scripts/install-runner-observability.mjs';
const localHostname = os.hostname().replace(/\.local$/, '');

export function claudeObservabilitySettingsPath(repo: string, runtimeDir: string): string {
  return path.posix.join(repo, runtimeDir, '.observability', 'claude-settings.json');
}

export function buildClaudeObservabilityFallbackCommand(settingsPath: string): string {
  const settingsDir = path.posix.dirname(settingsPath);
  const settingsFile = shellExpressionForRemotePath(settingsPath);
  return `mkdir -p ${shellExpressionForRemotePath(settingsDir)} && printf '{}\\n' > ${settingsFile}`;
}

function farmslotDirForSlot(vars: Awaited<ReturnType<typeof loadSlotVars>>): string {
  const slotHost = vars.host.replace(/\.local$/, '');
  const isLocal =
    slotHost === 'localhost' || slotHost === '127.0.0.1' || slotHost === localHostname;
  return isLocal ? farmslotRoot : REMOTE_AGENT_DIR;
}

export function buildRunnerObservabilityInstallCommand(
  vars: Awaited<ReturnType<typeof loadSlotVars>>,
  runner: string,
  repo: string,
  runtimeDir = '.agent',
  options: {
    /** Prefer accountLabel so the execution host expands credential paths. */
    accountLabel?: string | null;
    /** Explicit path override (tests / rare); expands on the execution host if relative. */
    authSource?: string | null;
  } = {},
): string {
  const installer = path.posix.join(farmslotDirForSlot(vars), INSTALLER_RELATIVE_PATH);
  const parts = [
    `node ${shellExpressionForRemotePath(installer)}`,
    `--runner ${shellQuote(runner)}`,
    `--repo ${shellExpressionForRemotePath(repo)}`,
    `--runtime-dir ${shellQuote(runtimeDir)}`,
    `--slot-id ${shellQuote(vars.slotId)}`,
  ];
  // Codex: pass label for node-local resolution; optional auth-source override for tests.
  if (options.accountLabel?.trim()) {
    parts.push(`--account-label ${shellQuote(options.accountLabel.trim())}`);
  }
  if (options.authSource?.trim()) {
    parts.push(`--auth-source ${shellQuote(options.authSource.trim())}`);
  }
  return parts.join(' ');
}

export function withRunnerObservabilityInstall(
  launchCommand: string,
  installCommand: string,
  fallbackCommand = ':',
): string {
  return `(${installCommand} || { echo '[farmslot-observability] install failed; continuing without hooks' >&2; ${fallbackCommand}; }) && ${launchCommand}`;
}
