// methods/slot/prepare-profile.ts — prepare profile resolution + precondition checks (ADR-037)

import {
  PREPARE_PHASES,
  type PreparePhase,
  type PrepareRequirement,
} from '@farmslot/protocol';

import {
  execOnSlot,
  expandHook,
  getProjectField,
  type ProjectVars,
  type RawProjectJson,
  type SlotVars,
} from '../../core/index.js';
import { shellQuote } from '../../core/tmux.js';

import { runHealthCheck } from './check.js';

export interface ResolvedPrepareProfile {
  name: string;
  label?: string;
  phases: Set<PreparePhase>;
  hooks: Record<string, string>;
  requires: PrepareRequirement[];
  fallback?: string;
}

export interface PrepareProfileFallback {
  from: string;
  to: string;
  reason: string;
}

export interface PrepareProfileSelection {
  profile: ResolvedPrepareProfile;
  fallbacks: PrepareProfileFallback[];
}

const IMPLICIT_FULL = 'full';

type RawProfiles = NonNullable<NonNullable<RawProjectJson['prepare']>['profiles']>;

function materialize(name: string, raw: RawProfiles[string]): ResolvedPrepareProfile {
  return {
    name,
    ...(raw.label ? { label: raw.label } : {}),
    phases: new Set((raw.phases ?? []) as PreparePhase[]),
    hooks: raw.hooks ?? {},
    requires: (raw.requires ?? []) as PrepareRequirement[],
    ...(raw.fallback ? { fallback: raw.fallback } : {}),
  };
}

function implicitFullProfile(): ResolvedPrepareProfile {
  return { name: IMPLICIT_FULL, phases: new Set(PREPARE_PHASES), hooks: {}, requires: [] };
}

/**
 * Resolve the starting profile for a prepare run: explicit request →
 * prepare.default → a profile literally named "full" → implicit built-in full
 * (all phases) when the project declares no prepare block.
 *
 * projectJson is assumed validated by validatePrepareConfig (loadProjectVars).
 */
export function resolvePrepareProfile(
  projectJson: RawProjectJson,
  requested?: string,
): ResolvedPrepareProfile {
  const profiles = projectJson.prepare?.profiles;
  if (!profiles) {
    if (requested && requested !== IMPLICIT_FULL) {
      throw new Error(
        `Project defines no prepare profiles; cannot select profile '${requested}'`,
      );
    }
    return implicitFullProfile();
  }
  const name = requested || projectJson.prepare?.default || IMPLICIT_FULL;
  const raw = profiles[name];
  if (!raw) {
    throw new Error(
      `Unknown prepare profile '${name}' (available: ${Object.keys(profiles).join(', ')})`,
    );
  }
  return materialize(name, raw);
}

export interface RequirementCheckResult {
  requirement: PrepareRequirement;
  ok: boolean;
  detail: string;
}

export interface RequirementCheckContext {
  vars: SlotVars;
  projectJson: RawProjectJson;
  projectVars?: ProjectVars;
  runtimeDir: string;
}

// Deps inputs hashed for the deps_current sentinel. Keep in sync with
// @farmslot/recipe-harness/runtime/deps-readiness DEPS_INPUTS.
const DEPS_FINGERPRINT_INPUTS = ['package.json', 'yarn.lock', '.yarnrc.yml', '.tool-versions'];

// Lockfiles hashed when Node is unavailable on the slot (legacy fallback).
const LOCKFILE_CANDIDATES = [
  'yarn.lock',
  'package-lock.json',
  'pnpm-lock.yaml',
  'bun.lockb',
  'Gemfile.lock',
  'Cargo.lock',
  'go.sum',
];

export function depsSentinelPath(runtimeDir: string): string {
  return `${runtimeDir}/deps.lock-hash`;
}

const DEPS_FINGERPRINT_NODE = [
  "const fs=require('fs'),crypto=require('crypto'),path=require('path');",
  `const inputs=${JSON.stringify(DEPS_FINGERPRINT_INPUTS)};`,
  "const h=crypto.createHash('sha256');",
  "for (const rel of inputs) {",
  "  const abs=path.join(process.cwd(),rel);",
  "  if (!fs.existsSync(abs)) continue;",
  "  h.update(rel); h.update('\\0'); h.update(fs.readFileSync(abs)); h.update('\\0');",
  "}",
  "process.stdout.write(h.digest('hex'));",
].join('');

function depsFingerprintSnippet(): string {
  return `node -e ${shellQuote(DEPS_FINGERPRINT_NODE)}`;
}

function lockfileHashSnippet(): string {
  // `cat $files` is deliberately unquoted: word splitting is safe because
  // LOCKFILE_CANDIDATES are space-free by construction.
  return [
    `files=""`,
    `for f in ${LOCKFILE_CANDIDATES.join(' ')}; do [ -f "$f" ] && files="$files $f"; done`,
    `if [ -n "$files" ]; then`,
    `  if command -v sha256sum >/dev/null 2>&1; then cat $files | sha256sum; else cat $files | shasum -a 256; fi | cut -d' ' -f1`,
    `fi`,
  ].join('\n');
}

/** Prefer harness fingerprint via Node; fall back to lockfile hash when Node is absent. */
function depsHashSnippet(): string {
  return [
    `if command -v node >/dev/null 2>&1; then`,
    `  ${depsFingerprintSnippet()}`,
    `else`,
    lockfileHashSnippet()
      .split('\n')
      .map((line) => `  ${line}`)
      .join('\n'),
    `fi`,
  ].join('\n');
}

export function buildDepsFingerprintCommand(repo: string): string {
  return `cd ${shellQuote(repo)} && ${depsHashSnippet()}`;
}

/**
 * Written after a successful deps install so deps_current can compare the
 * deps-input fingerprint the installed tree was built from. No inputs → sentinel
 * is removed, which keeps deps_current failing (conservative).
 */
export function buildDepsSentinelWriteCommand(repo: string, runtimeDir: string): string {
  const sentinel = depsSentinelPath(runtimeDir);
  return [
    `cd ${shellQuote(repo)}`,
    `mkdir -p ${shellQuote(runtimeDir)}`,
    `hash=$(`,
    depsHashSnippet(),
    `)`,
    `if [ -n "$hash" ]; then echo "$hash" > ${shellQuote(sentinel)}; else rm -f ${shellQuote(sentinel)}; fi`,
  ].join(' && ');
}

export async function checkPrepareRequirement(
  requirement: PrepareRequirement,
  ctx: RequirementCheckContext,
): Promise<RequirementCheckResult> {
  const { vars, projectJson, projectVars, runtimeDir } = ctx;
  switch (requirement) {
    case 'deps_current': {
      const sentinel = depsSentinelPath(runtimeDir);
      const r = await execOnSlot(
        vars,
        `cd ${shellQuote(vars.remoteRepo)} && cat ${shellQuote(sentinel)} 2>/dev/null`,
      );
      const recorded = r.stdout.trim();
      if (!recorded) {
        return { requirement, ok: false, detail: `no deps sentinel at ${sentinel}` };
      }
      const currentR = await execOnSlot(vars, buildDepsFingerprintCommand(vars.remoteRepo));
      const current = currentR.stdout.trim();
      if (!current) {
        return { requirement, ok: false, detail: 'no deps inputs found to fingerprint' };
      }
      return current === recorded
        ? { requirement, ok: true, detail: `deps fingerprint ${current.slice(0, 12)} matches sentinel` }
        : { requirement, ok: false, detail: 'deps fingerprint differs from deps sentinel' };
    }
    case 'dev_server_up': {
      const hook = expandHook('dev_server_check', projectJson, vars, projectVars);
      if (!hook) {
        return { requirement, ok: false, detail: 'project has no dev_server_check hook' };
      }
      const r = await execOnSlot(vars, `cd ${shellQuote(vars.remoteRepo)} && ${hook}`);
      return r.exitCode === 0
        ? { requirement, ok: true, detail: 'dev_server_check passed' }
        : { requirement, ok: false, detail: `dev_server_check exited ${r.exitCode}` };
    }
    case 'health_ok': {
      const healthHook = expandHook('health_check', projectJson, vars, projectVars);
      if (!healthHook) {
        return { requirement, ok: false, detail: 'project has no health_check hook' };
      }
      const parseCmd = getProjectField(projectJson, 'health.parse_health');
      const readyIndicator = getProjectField(projectJson, 'health.ready_indicator');
      const value = await runHealthCheck(vars, healthHook, parseCmd, {
        logPrefix: 'prepare-profile',
      });
      if (value && (!readyIndicator || value === readyIndicator)) {
        return { requirement, ok: true, detail: `health ${value}` };
      }
      return {
        requirement,
        ok: false,
        detail: `health value=${value || 'none'}${readyIndicator ? ` expected=${readyIndicator}` : ''}`,
      };
    }
  }
}

/**
 * Walk the requested profile's requires/fallback chain until a profile whose
 * preconditions hold. Validation guarantees requires⇒fallback and acyclic
 * chains, so this always terminates at a runnable profile.
 */
export async function selectPrepareProfile(
  ctx: RequirementCheckContext,
  requested?: string,
  onCheck?: (profile: string, result: RequirementCheckResult) => void,
  check: typeof checkPrepareRequirement = checkPrepareRequirement,
  options?: { strict?: boolean },
): Promise<PrepareProfileSelection> {
  let profile = resolvePrepareProfile(ctx.projectJson, requested);
  const fallbacks: PrepareProfileFallback[] = [];
  while (profile.requires.length > 0) {
    const failures: RequirementCheckResult[] = [];
    for (const requirement of profile.requires) {
      const result = await check(requirement, ctx);
      onCheck?.(profile.name, result);
      if (!result.ok) failures.push(result);
    }
    if (failures.length === 0) break;
    if (options?.strict) {
      const reason = failures.map((f) => `${f.requirement}: ${f.detail}`).join('; ');
      throw new Error(
        `Prepare profile '${profile.name}' preconditions failed (${reason}). ` +
          'Fix slot health or choose a heavier prepare profile.',
      );
    }
    const fallbackName = profile.fallback;
    if (!fallbackName) {
      // Unreachable for validated configs (requires⇒fallback); guard against
      // a profile materialized outside loadProjectVars validation.
      throw new Error(
        `Prepare profile '${profile.name}' preconditions failed and no fallback is declared`,
      );
    }
    const reason = failures.map((f) => `${f.requirement}: ${f.detail}`).join('; ');
    fallbacks.push({ from: profile.name, to: fallbackName, reason });
    profile = resolvePrepareProfile(ctx.projectJson, fallbackName);
  }
  return { profile, fallbacks };
}
