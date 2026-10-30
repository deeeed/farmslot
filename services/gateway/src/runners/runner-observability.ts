import os from 'node:os';
import path from 'node:path';

import { runnerRuntimeDir } from '../../../../scripts/lib/runner-runtime.cjs';
import type { loadSlotVars } from '../core/config.js';
import { shellExpressionForRemotePath } from '../core/remote-paths.js';
import { shellQuote } from '../core/tmux.js';
import { farmslotRoot } from '../projects/repo-root.js';

const REMOTE_AGENT_DIR = '~/farmslot-node';
export const INSTALLER_RELATIVE_PATH = 'scripts/install-runner-observability.mjs';
export const RUNNER_OBSERVABILITY_COPY_PATHS = [
  'scripts/runners/hook-progress.mjs',
  'scripts/runners/pi-farmslot-observability.ts',
  'scripts/runners/pi-farmslot-hook-writer.mjs',
  'scripts/runners/pi-farmslot-providers.mjs',
  'scripts/runners/pi-farmslot-task.mjs',
] as const;

export const RUNNER_OBSERVABILITY_SUPPORT_PATHS = [
  INSTALLER_RELATIVE_PATH,
  'scripts/lib/runner-runtime.cjs',
  'scripts/lib/provider-accounts.mjs',
  'packages/agent-runtime/scripts/toml-scan.cjs',
  'packages/agent-runtime/scripts/review-account-preflight.cjs',
  'packages/agent-runtime/scripts/workspace-trust.cjs',
  ...RUNNER_OBSERVABILITY_COPY_PATHS,
] as const;
export const NODE_SUPPORT_HASH_FILENAME = 'node-support-hash';

/** Where nodes keep content-addressed support bundles (ADR-035). */
export const NODE_SUPPORT_ROOT = '~/farmslot-node/support';

/** The slot's node-support bundle selection, outside the checkout (ADR-035). */
export function nodeSupportHashPath(repo: string, runtimeDir: string): string {
  return path.posix.join(
    runnerRuntimeDir(repo, runtimeDir),
    '.observability',
    NODE_SUPPORT_HASH_FILENAME,
  );
}

/**
 * Shell printing the slot's selected bundle directory; non-zero without a valid
 * selection. Case patterns carry a leading `(` so bash 3.2 parses them inside `$(...)`.
 */
export function nodeSupportSelectionCommand(repo: string, runtimeDir: string): string {
  const pointer = shellExpressionForRemotePath(nodeSupportHashPath(repo, runtimeDir));
  const root = shellExpressionForRemotePath(NODE_SUPPORT_ROOT);
  return `hash="$(cat ${pointer} 2>/dev/null)"; case "$hash" in (''|*[!0-9a-f]*) false ;; (*) [ \${#hash} -eq 64 ] && printf '%s\\n' ${root}/"$hash" ;; esac`;
}
const localHostname = os.hostname().replace(/\.local$/, '');

export function claudeObservabilitySettingsPath(repo: string, runtimeDir: string): string {
  return path.posix.join(
    runnerRuntimeDir(repo, runtimeDir),
    '.observability',
    'claude-settings.json',
  );
}

export function buildClaudeObservabilityFallbackCommand(settingsPath: string): string {
  const settingsDir = path.posix.dirname(settingsPath);
  const settingsFile = shellExpressionForRemotePath(settingsPath);
  const validate = `node -e ${shellQuote(
    `JSON.parse(require('node:fs').readFileSync(process.argv[1], 'utf8'))`,
  )} ${settingsFile} >/dev/null 2>&1`;
  return `${validate} || { mkdir -p ${shellExpressionForRemotePath(settingsDir)} && printf '{}\\n' > ${settingsFile}; }`;
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
    /** Already verified bundle, independent of the account-state destination. */
    supportDir?: string;
  } = {},
): string {
  const farmslotDir = farmslotDirForSlot(vars);
  const localInstaller = path.posix.join(farmslotDir, INSTALLER_RELATIVE_PATH);
  const parts = [
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
  if (options.supportDir) {
    const installer = path.posix.join(options.supportDir, INSTALLER_RELATIVE_PATH);
    return `node ${shellExpressionForRemotePath(installer)} ${parts.join(' ')}`;
  }
  if (farmslotDir !== REMOTE_AGENT_DIR) {
    return `node ${shellExpressionForRemotePath(localInstaller)} ${parts.join(' ')}`;
  }

  const fallbackInstaller = '${HOME}/farmslot-node/' + INSTALLER_RELATIVE_PATH;
  const supportReady = RUNNER_OBSERVABILITY_SUPPORT_PATHS.map(
    (relativePath) => `[ -f "$support_dir/${relativePath}" ]`,
  ).join(' && ');
  return [
    `support_dir="$(${nodeSupportSelectionCommand(repo, runtimeDir)})" || support_dir=''`,
    `installer="${fallbackInstaller}"`,
    `if [ -n "$support_dir" ] && ${supportReady}; then installer="$support_dir/${INSTALLER_RELATIVE_PATH}"; fi`,
    `node "$installer" ${parts.join(' ')}`,
  ].join('; ');
}

export function withRunnerObservabilityInstall(
  launchCommand: string,
  installCommand: string,
  fallbackCommand = ':',
): string {
  return `(${installCommand} || echo '[farmslot-observability] install failed; continuing without hooks' >&2) && (${fallbackCommand}) && ${launchCommand}`;
}

/** Auth discovery uses the provider catalog from the selected node support bundle. */
export function buildPiAuthCheckCommand(
  vars: Awaited<ReturnType<typeof loadSlotVars>>,
  binary: string,
  model: string,
): string {
  const helper = path.posix.join(
    farmslotDirForSlot(vars),
    'scripts/runners',
    'pi-farmslot-providers.mjs',
  );
  // Preserve the literal remote-root prefix consumed by execOnSlot's immutable
  // support-bundle resolver. Expanding it to HOME here would bypass that owner.
  const selectedHelper = helper.startsWith(`${REMOTE_AGENT_DIR}/`)
    ? helper
    : shellExpressionForRemotePath(helper);
  return `cd ${shellExpressionForRemotePath(vars.remoteRepo)} && node ${selectedHelper} ${shellExpressionForRemotePath(binary)} ${shellQuote(model)}`;
}

/**
 * Like withRunnerObservabilityInstall, but the install step is load-bearing:
 * when it fails the runner must not start (the installer's error is the last
 * pane output, so launch detection reports it instead of a ready timeout).
 */
export function withRequiredRunnerInstall(launchCommand: string, installCommand: string): string {
  // The launch is grouped so a `;` inside a pool dispatch_cmd cannot detach
  // the runner from the install result.
  return `(${installCommand}) && { ${launchCommand}; }`;
}
