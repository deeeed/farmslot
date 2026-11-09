import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { normalizeRunner } from '@farmslot/protocol';
import { legacyRemoteFarmPaths } from '@farmslot/protocol/node/farm-paths';
import { currentProjectSources, reportedFarmPaths } from '@farmslot/slot-config';

import {
  RUNNER_OBSERVABILITY_COPY_FILES,
  RUNNER_OBSERVABILITY_COPY_PATHS,
  RUNNER_OBSERVABILITY_SOURCE_FILES,
  RUNNER_OBSERVABILITY_SUPPORT_PATHS,
  supportHash,
  supportVerificationProgram,
  verifySupportBundle,
} from '../../../../scripts/lib/runner-observability-bundle.mjs';
import { runnerRuntimeDir } from '../../../../scripts/lib/runner-runtime.cjs';
import type { loadSlotVars } from '../core/config.js';
import { shellExpressionForRemotePath } from '../core/remote-paths.js';
import { shellQuote } from '../core/tmux.js';
import { currentFarmPaths, farmPathsForSlot, farmslotDirForSlot } from '../fleet/farm-paths.js';

export const INSTALLER_RELATIVE_PATH = 'scripts/install-runner-observability.mjs';
export { RUNNER_OBSERVABILITY_COPY_PATHS, RUNNER_OBSERVABILITY_SUPPORT_PATHS };
// Fixed deployment bytes: one asynchronous read at module startup, no per-launch gateway scan.
const gatewayBundle = await verifySupportBundle(
  fileURLToPath(new URL('../../../../', import.meta.url)),
  undefined,
  RUNNER_OBSERVABILITY_SOURCE_FILES,
);
export const RUNNER_OBSERVABILITY_BUNDLE_HASH = gatewayBundle.hash;
const piCopyHash = supportHash(
  gatewayBundle.files.filter((file) => RUNNER_OBSERVABILITY_COPY_PATHS.includes(file.relativePath)),
);

export function runnerUsesObservabilityBundle(runner: string | null | undefined): boolean {
  return ['claude', 'codex', 'pi', 'cursor', 'grok'].includes(
    runner ? normalizeRunner(runner) : '',
  );
}

export function piObservabilityVerificationCommand(obsDir: string): string {
  const packet = JSON.stringify({
    obsDir,
    hash: RUNNER_OBSERVABILITY_BUNDLE_HASH,
    copiedHash: piCopyHash,
    files: RUNNER_OBSERVABILITY_COPY_FILES,
  });
  const program =
    supportVerificationProgram() +
    `
(async()=>{
 const expected=JSON.parse(process.argv[1]),fs=require('node:fs/promises'),path=require('node:path');
 await verifySupportBundle(expected.obsDir,expected.copiedHash,expected.files);
 const manifest=JSON.parse(await fs.readFile(path.join(expected.obsDir,'install.json'),'utf8'));
 if(manifest.bundleHash!==expected.hash)throw new Error('installed bundle identity differs from the gateway');
})().catch(error=>{console.error('RUNNER_OBSERVABILITY_BUNDLE_MISMATCH: '+error.message);process.exitCode=78;});`;
  return `node -e ${shellQuote(program)} ${shellQuote(packet)}`;
}

function verifiedInstallerCommand(sourceExpression: string, args: string): string {
  const packet = JSON.stringify({
    hash: RUNNER_OBSERVABILITY_BUNDLE_HASH,
    files: RUNNER_OBSERVABILITY_SOURCE_FILES,
    installer: INSTALLER_RELATIVE_PATH,
  });
  const program =
    supportVerificationProgram() +
    `
(async()=>{
 const expected=JSON.parse(process.argv[1]),root=process.argv[2],path=require('node:path'),url=require('node:url');
 const bundle=await verifySupportBundle(root,expected.hash,expected.files);
 const installer=await import(url.pathToFileURL(path.join(root,expected.installer)).href);
 await installer.installRunnerObservability(process.argv.slice(3),bundle);
})().catch(error=>{console.error('[farmslot-observability] install failed: '+error.message);process.exitCode=error.code==='RUNNER_OBSERVABILITY_BUNDLE_MISMATCH'?78:1;});`;
  return `node -e ${shellQuote(program)} ${shellQuote(packet)} ${sourceExpression} ${args}`;
}

export const NODE_SUPPORT_HASH_FILENAME = 'node-support-hash';

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
export function nodeSupportSelectionCommand(
  repo: string,
  runtimeDir: string,
  supportRoot = legacyRemoteFarmPaths().code.support,
): string {
  const pointer = shellExpressionForRemotePath(nodeSupportHashPath(repo, runtimeDir));
  const root = shellExpressionForRemotePath(supportRoot);
  return `hash="$(cat ${pointer} 2>/dev/null)"; case "$hash" in (''|*[!0-9a-f]*) false ;; (*) [ \${#hash} -eq 64 ] && printf '%s\\n' ${root}/"$hash" ;; esac`;
}

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
  const configure = `node -e ${shellQuote(
    `const fs = require('node:fs'); const file = process.argv[1]; const settings = JSON.parse(fs.readFileSync(file, 'utf8')); if (!settings || typeof settings !== 'object' || Array.isArray(settings)) process.exit(1); if (settings.promptSuggestionEnabled !== false) { settings.promptSuggestionEnabled = false; fs.writeFileSync(file, JSON.stringify(settings) + '\\n'); }`,
  )} ${settingsFile} >/dev/null 2>&1`;
  return `${configure} || { mkdir -p ${shellExpressionForRemotePath(settingsDir)} && printf '{"promptSuggestionEnabled":false}\\n' > ${settingsFile}; }`;
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
    return verifiedInstallerCommand(
      shellExpressionForRemotePath(options.supportDir),
      parts.join(' '),
    );
  }
  if (
    currentProjectSources() ||
    (farmslotDir === currentFarmPaths('gateway').code.checkout &&
      reportedFarmPaths(vars.machine)?.layout !== 2)
  ) {
    return verifiedInstallerCommand(shellExpressionForRemotePath(farmslotDir), parts.join(' '));
  }

  const selected = nodeSupportSelectionCommand(
    repo,
    runtimeDir,
    farmPathsForSlot(vars).code.support,
  );
  if (runner === 'pi') {
    return [
      `support_dir="$(${selected})" || { echo 'RUNNER_OBSERVABILITY_BUNDLE_MISSING: no selected runner support bundle' >&2; exit 78; }`,
      verifiedInstallerCommand('"$support_dir"', parts.join(' ')),
    ].join('; ');
  }
  const supportReady = RUNNER_OBSERVABILITY_SUPPORT_PATHS.map(
    (relativePath) => `[ -f "$support_dir/${relativePath}" ]`,
  ).join(' && ');
  return [
    `support_dir="$(${selected})" || support_dir=''`,
    `if [ -z "$support_dir" ] || ! { ${supportReady}; }; then support_dir=${shellExpressionForRemotePath(farmslotDir)}; fi`,
    verifiedInstallerCommand('"$support_dir"', parts.join(' ')),
  ].join('; ');
}

export function withRunnerObservabilityInstall(
  launchCommand: string,
  installCommand: string,
  fallbackCommand = ':',
): string {
  return `(${installCommand} || { obs_install_status=$?; [ "$obs_install_status" -ne 78 ] || exit "$obs_install_status"; echo '[farmslot-observability] install failed; continuing without hooks' >&2; }) && (${fallbackCommand}) && ${launchCommand}`;
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
  const selectedHelper = helper.startsWith(`${legacyRemoteFarmPaths().code.node}/`)
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
