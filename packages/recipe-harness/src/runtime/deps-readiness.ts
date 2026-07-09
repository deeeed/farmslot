import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Lock/manifest inputs hashed for the deps baseline. */
export const DEPS_INPUTS = ['package.json', 'yarn.lock', '.yarnrc.yml', '.tool-versions'];

/** Yarn install-state markers. */
export const INSTALL_MARKERS = ['node_modules/.yarn-state.yml', '.yarn/install-state.gz'];

export interface DepsCheck {
  installed: boolean;
  status: 'current' | 'stale' | 'missing' | 'partial';
  hasBaseline: boolean;
  missingProducts?: string[];
}

const STATE_NAMESPACE = 'farmslot-recipe-runtime-decision';

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

/** Record the current deps fingerprint as the install baseline (OS temp dir). */
export function recordDepsBaseline(target: string): void {
  writeBaseline(target, 'deps-state.json', { fingerprint: depsFingerprint(target) });
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
  const installed =
    inputs.length > 0 && INSTALL_MARKERS.some((rel) => fs.existsSync(path.join(target, rel)));
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

  const baseline = readBaseline(target, 'deps-state.json');
  if (!baseline) {
    const drift = newestMtime(target, inputs) > newestMtime(target, INSTALL_MARKERS);
    return { installed: true, status: drift ? 'stale' : 'current', hasBaseline: false };
  }
  const fingerprintMatches = baseline.fingerprint === depsFingerprint(target);
  const installedAfterInputs = newestMtime(target, INSTALL_MARKERS) >= newestMtime(target, inputs);
  const status = fingerprintMatches || installedAfterInputs ? 'current' : 'stale';
  return { installed: true, status, hasBaseline: true };
}
