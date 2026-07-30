import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const semver = require('semver') as {
  satisfies(version: string, range: string): boolean;
};

/** Lock/manifest inputs hashed for the deps baseline. */
export const DEPS_INPUTS = ['package.json', 'yarn.lock', '.yarnrc.yml', '.tool-versions'];

/** Runtime dependency surfaces produced by Yarn's supported linkers. */
export const INSTALL_MARKERS = ['node_modules/.yarn-state.yml', '.pnp.cjs'];

const DEPS_BASELINE_SCHEMA_VERSION = 2;

export interface DepsCheck {
  installed: boolean;
  status: 'current' | 'stale' | 'missing' | 'partial';
  hasBaseline: boolean;
  missingProducts?: string[];
}

const STATE_NAMESPACE = 'farmslot-recipe-runtime-decision';

export function dependencyVersionSatisfies(version: string, range: string): boolean {
  if (!version.trim() || !range.trim()) return false;
  return semver.satisfies(version, range);
}

function stateDir(target: string): string {
  const key = crypto.createHash('sha1').update(path.resolve(target)).digest('hex').slice(0, 16);
  return path.join(os.tmpdir(), STATE_NAMESPACE, key);
}

function readBaseline(target: string, name: string): Record<string, unknown> | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(stateDir(target), name), 'utf8'));
  } catch {
    return null;
  }
}

function writeBaseline(target: string, name: string, value: Record<string, unknown>): void {
  const dir = stateDir(target);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), `${JSON.stringify(value, null, 2)}\n`);
}

function newestMtime(target: string, rels: string[]): number {
  let newest = 0;
  for (const rel of rels) {
    const abs = path.join(target, rel);
    if (fs.existsSync(abs)) newest = Math.max(newest, fs.statSync(abs).mtimeMs);
  }
  return newest;
}

export function depsFingerprint(target: string, extraInputs: string[] = []): string {
  const hash = crypto.createHash('sha256');
  for (const rel of [...DEPS_INPUTS, ...extraInputs]) {
    const abs = path.join(target, rel);
    if (!fs.existsSync(abs)) continue;
    hash.update(rel);
    hash.update('\0');
    hash.update(fs.readFileSync(abs));
    hash.update('\0');
  }
  return hash.digest('hex');
}

function missingProductMarkers(target: string, markers: string[]): string[] {
  return markers.filter((rel) => !fs.existsSync(path.join(target, rel)));
}

function readYarnNodeLinker(target: string): string | undefined {
  const yarnrcPath = path.join(target, '.yarnrc.yml');
  if (!fs.existsSync(yarnrcPath)) return undefined;
  const yarnrc = fs.readFileSync(yarnrcPath, 'utf8');
  return /^nodeLinker:\s*["']?([^"'\s#]+)["']?/mu.exec(yarnrc)?.[1];
}

function installSurfaceMarkers(target: string): string[] {
  const linker = readYarnNodeLinker(target);
  if (linker === 'node-modules') {
    return ['node_modules/.yarn-state.yml'];
  }
  if (linker === 'pnp') return ['.pnp.cjs'];
  return INSTALL_MARKERS;
}

function installFreshnessMarkers(target: string): string[] {
  const linker = readYarnNodeLinker(target);
  if (linker === 'node-modules') {
    return ['node_modules/.yarn-state.yml'];
  }
  if (linker === 'pnp') return ['.pnp.cjs', '.yarn/install-state.gz'];
  return [...INSTALL_MARKERS, '.yarn/install-state.gz'];
}

function hasInstallSurface(target: string): boolean {
  return installSurfaceMarkers(target).some((rel) => fs.existsSync(path.join(target, rel)));
}

/** Record the current deps fingerprint after a successful dependency install. */
export function recordDepsBaseline(target: string): void {
  writeBaseline(target, 'deps-state.json', {
    schemaVersion: DEPS_BASELINE_SCHEMA_VERSION,
    source: 'dependency-install',
    fingerprint: depsFingerprint(target),
  });
}

export function readDecisionState(target: string, name: string): Record<string, unknown> | null {
  return readBaseline(target, name);
}

export function writeDecisionState(
  target: string,
  name: string,
  value: Record<string, unknown>,
): void {
  writeBaseline(target, name, value);
}

export function clearDecisionState(target: string, name: string): void {
  try {
    fs.unlinkSync(path.join(stateDir(target), name));
  } catch {
    // no prior state
  }
}

export function depsCheck(target: string, options: { productMarkers?: string[] } = {}): DepsCheck {
  const productMarkers = options.productMarkers ?? [];
  const inputs = DEPS_INPUTS.filter((rel) => fs.existsSync(path.join(target, rel)));
  const markers = installFreshnessMarkers(target);
  const installed = inputs.length > 0 && hasInstallSurface(target);
  if (!installed) return { installed: false, status: 'missing', hasBaseline: false };

  const missingProducts = missingProductMarkers(target, productMarkers);
  if (missingProducts.length > 0) {
    return {
      installed: true,
      status: 'partial',
      hasBaseline: false,
      missingProducts,
    };
  }

  const rawBaseline = readBaseline(target, 'deps-state.json');
  const baseline =
    rawBaseline?.schemaVersion === DEPS_BASELINE_SCHEMA_VERSION &&
    rawBaseline.source === 'dependency-install'
      ? rawBaseline
      : null;
  if (!baseline) {
    const drift = newestMtime(target, inputs) > newestMtime(target, markers);
    return { installed: true, status: drift ? 'stale' : 'current', hasBaseline: false };
  }
  const fingerprintMatches = baseline.fingerprint === depsFingerprint(target);
  const installedAfterInputs = newestMtime(target, markers) >= newestMtime(target, inputs);
  const status = fingerprintMatches || installedAfterInputs ? 'current' : 'stale';
  return { installed: true, status, hasBaseline: true };
}
