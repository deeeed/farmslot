// Healing policy + recovery bounds — shared by launch, run, and call (policy, not
// per-command). Owns: overlay auto-ensure, failure classification, the recovery
// bounds that stop blind retry loops, and the --heal parser.
//
// Overlay auto-ensure seam (overridable for CI/agents and contract tests):
//   <envPrefix>_INSTALL_BIN — overlay installer (default: handleHarness install)

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import type {
  AdapterFailurePatterns,
  HealBoundViolation,
  HealPolicy,
  HealState,
} from '@farmslot/adapter-sdk';

import { assertAdaptersRegistered, harnessAdapter, harnessAdapters } from './adapters.js';
import { harnessHost, hostEnvName } from './host.js';
import { handleHarness } from './overlay.js';
import { recipeHarnessPath, recipeRuntimePath } from './paths.js';
import { recordingUnsupportedFailure } from './recording-target.js';
import { EXIT } from './shared.js';

export function newHealState(): HealState {
  return { recovered: [], mutations: [], attemptedRecoveries: [] };
}

export function conciseFailureForHuman(output: string): string {
  const errors = output
    .split(/\r?\n/u)
    .map((line) => /^(?:[A-Za-z]*Error):\s*(.+)$/u.exec(line.trim())?.[1])
    .filter((line): line is string => Boolean(line));
  return errors.at(-1) ?? output.trim();
}

export function parseHeal(
  options: Record<string, string | boolean>,
  fallback: HealPolicy,
): HealPolicy | { error: string } {
  const value = options.heal;
  if (value === undefined) return fallback;
  if (value === 'off' || value === 'infra-only' || value === 'auto') return value;
  return { error: `--heal must be off, infra-only, or auto (got "${String(value)}").` };
}

function overlayDir(target: string, adapter: string): string {
  return recipeHarnessPath(target, adapter);
}

function overlayPresent(target: string, adapter: string): boolean {
  try {
    return fs.statSync(overlayDir(target, adapter)).isDirectory();
  } catch {
    return false;
  }
}

// Validates that the installed overlay's runner-source stamp points to an existing
// runner directory whose binary is still present. Two failure modes are detected:
//   1. Stale stamp — runner dir moved or renamed since install (dir absent).
//   2. Stale exec target — runner dir exists but the host bin was removed
//      (e.g. the package was unlinked/purged inside an otherwise-live dir).
// Either way the delegate binary will fail to exec; treat the overlay as absent
// so auto-ensure re-installs it from the current runner.
function overlayDelegateValid(target: string, adapter: string): boolean {
  if (harnessAdapter(adapter).headless) return true;
  const pointer = path.join(recipeHarnessPath(target, adapter), 'runner', '.runner-source');
  if (!fs.existsSync(pointer)) return true; // no stamp = running from local runner, valid
  const runnerPath = fs.readFileSync(pointer, 'utf8').trim();
  if (!runnerPath || !fs.existsSync(runnerPath)) return false;
  // Runner dir is present; verify the binary inside still exists — the directory
  // can survive a package removal while the binary inside is deleted.
  return fs.existsSync(path.join(runnerPath, harnessHost().bin));
}

// Auto-ensure the runtime overlay (install phase). Missing + heal != off →
// install inline, emit a first-install notice to stderr, and record the mutation.
// heal === off disables auto-install (repro-preserving); we proceed and let the
// porcelain surface any missing-overlay failure itself.
export async function ensureOverlay(
  adapter: string,
  target: string,
  heal: HealPolicy,
  state: HealState,
  json: boolean,
): Promise<{ ok: boolean; error?: string }> {
  // A headless platform (core) needs no launch overlay for run/call.
  if (harnessAdapter(adapter).headless) return { ok: true };
  if (overlayPresent(target, adapter) && overlayDelegateValid(target, adapter)) return { ok: true };
  if (heal === 'off') return { ok: true };

  const installBin = process.env[hostEnvName('INSTALL_BIN')];
  let code: number;
  if (installBin) {
    const result = spawnSync(installBin, ['install', '--platform', adapter, '--target', target], {
      cwd: target,
      stdio: ['ignore', 2, 'inherit'],
      env: process.env,
    });
    code = result.status ?? 1;
  } else {
    // Auto-install is an internal phase of the parent command. Keep the nested
    // installer silent so human output has one progress owner and machine
    // output remains one JSON document; the parent records the mutation below.
    code = await handleHarness(['install', '--platform', adapter, '--target', target, '--quiet']);
  }
  if (code !== 0 || !overlayPresent(target, adapter)) {
    return { ok: false, error: `runtime overlay install failed (exit ${code})` };
  }
  const dir = overlayDir(target, adapter);
  state.mutations.push({ type: 'file', action: 'created', path: dir });
  // First-install notice → stderr (human) / mutations[] only (json; stdout clean).
  if (!json) process.stderr.write(`installed ${harnessHost().name} overlay → ${dir}\n`);
  return { ok: true };
}

// A recovery that would need a seeded wallet is NEVER auto-performed (healing
// never touches fixtures). Only POSITIVELY-IDENTIFIED infra transport failures
// are healable. Unknown/unclassified failures → 'app' (safe default: no healing
// attempted, failure surfaced verbatim). Defaulting to 'infra' would cause
// self-healing to mask real app-logic breakage.
// The patterns come from every registered adapter, in this order: capture
// protection, environment gaps, transport errors that look like wallet state,
// wallet state, then transport. Classification does not depend on which adapter
// is running.
export type FailureClass = 'capture-protected' | 'environment' | 'wallet' | 'infra' | 'app';

export function classifyFailure(output: string): FailureClass {
  if (captureProtection(output)) return 'capture-protected';
  if (environmentGap(output)) return 'environment';
  if (matchesAny('transportFirst', output)) return 'infra';
  if (matchesAny('walletState', output)) return 'wallet';
  if (matchesAny('transport', output)) return 'infra';
  return 'app';
}

function adapterPatterns(): AdapterFailurePatterns[] {
  // With no adapters every failure would read as app logic and never heal.
  assertAdaptersRegistered();
  const registry = harnessAdapters();
  return registry.list().flatMap((id) => {
    const patterns = registry.get(id).failurePatterns;
    return patterns ? [patterns] : [];
  });
}

// A global or sticky pattern keeps lastIndex between calls; classification
// tests the same pattern more than once, so every test starts from 0.
function matches(pattern: RegExp | undefined, output: string): boolean {
  if (!pattern) return false;
  pattern.lastIndex = 0;
  return pattern.test(output);
}

function matchesAny(kind: 'transportFirst' | 'walletState' | 'transport', output: string): boolean {
  return adapterPatterns().some((patterns) => matches(patterns[kind], output));
}

function captureProtection(output: string): AdapterFailurePatterns['captureProtected'] {
  return adapterPatterns()
    .map((patterns) => patterns.captureProtected)
    .find((entry) => matches(entry?.pattern, output));
}

function environmentGap(output: string): AdapterFailurePatterns['environment'] {
  return adapterPatterns()
    .map((patterns) => patterns.environment)
    .find((entry) => matches(entry?.pattern, output));
}

// Refuse ALL recovery while a recipe is executing (mid-run recovery would corrupt
// state). Signalled by a lock file or <envPrefix>_RECIPE_RUNNING=1.
export function recipeRunning(target: string): boolean {
  if (process.env[hostEnvName('RECIPE_RUNNING')] === '1') return true;
  return fs.existsSync(recipeRuntimePath(target, 'recipe.lock'));
}

/**
 * Why a command refuses while another recipe runs, and where to look.
 * `targetArg` is the checkout as the caller quotes it for a shell.
 */
export function recipeRunningRefusal(targetArg: string): { message: string; userAction: string } {
  return {
    message: 'a recipe is currently running — refusing to start while another recipe executes.',
    userAction: `inspect the checkout state with: ${harnessHost().name} status --target ${targetArg} --json; retry after the active recipe finishes`,
  };
}

// Returns null (ok to proceed) or a violation descriptor when a bound is hit.
// Using null instead of { ok: true } keeps the return typeof-narrowable without
// relying on discriminated-union narrowing (avoids strict-mode tsconfig issues).
export function checkHealBounds(
  target: string,
  output: string,
  state: HealState,
): HealBoundViolation | null {
  // Carry the original failure output verbatim on every violation so the caller
  // can surface it (--json + human) alongside the classification note.
  const originalError = output.trim() || undefined;
  if (recipeRunning(target)) {
    return {
      code: 'RECIPE_RUNNING',
      exitCode: EXIT.bounded,
      message:
        'a recipe is currently running — refusing recovery to avoid corrupting mid-run state.',
      originalError,
    };
  }
  // A missing harness capability, not app logic.
  const recording = recordingUnsupportedFailure(output);
  if (recording) return { ...recording, exitCode: EXIT.usage, originalError };
  const concise = conciseFailureForHuman(output);
  const failureClass = classifyFailure(concise);
  const protectedCapture =
    failureClass === 'capture-protected' ? captureProtection(concise) : undefined;
  if (protectedCapture) {
    return {
      code: 'SCREENSHOT_PROTECTED',
      exitCode: EXIT.runtime,
      message: protectedCapture.message,
      userAction: protectedCapture.userAction,
      originalError,
    };
  }
  const gap = failureClass === 'environment' ? environmentGap(concise) : undefined;
  if (gap) {
    return {
      code: 'ENVIRONMENT_NOT_READY',
      exitCode: EXIT.bounded,
      message: gap.message,
      userAction: gap.userAction,
      originalError,
    };
  }
  if (failureClass === 'wallet') {
    return {
      code: 'WALLET_STATE_REQUIRED',
      exitCode: EXIT.bounded,
      message: 'wallet prerequisites need attention; healing never changes wallet state.',
      userAction:
        /(?:^|\n)\s*Next:\s*([^\r\n]+)/u.exec(output)?.[1] ??
        `run ${harnessHost().name} doctor --json`,
      originalError,
    };
  }
  if (failureClass === 'app') {
    return {
      code: 'APP_LOGIC_FAILURE',
      exitCode: EXIT.runtime,
      message: 'failure looks like app-logic — healing cannot help; surface verbatim.',
      originalError,
    };
  }
  if (state.attemptedRecoveries.length > 0) {
    return {
      code: 'SAME_RECOVERY_TWICE',
      exitCode: EXIT.bounded,
      message:
        state.recovered.length > 0
          ? 'one recovery already succeeded this invocation — bounded policy refuses a second recovery.'
          : 'one recovery was already attempted this invocation — refusing to loop.',
      originalError,
    };
  }
  return null;
}
