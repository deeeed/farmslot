// Fingerprint of the environment a Metro bundle was built with: env files in
// the project plus selected process env values. The project supplies both lists.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {
  checkFingerprintBaseline,
  type FingerprintCheck,
  recordFingerprintBaseline,
} from './fingerprint-baseline.js';

export interface MetroEnvInputs {
  /** Env files relative to the project root, hashed in order (absent files hash as absent). */
  files: readonly string[];
  /** Process env names, hashed in order. */
  env: readonly string[];
}

export function metroEnvFingerprint(projectRoot: string, inputs: MetroEnvInputs): string {
  const hash = createHash('sha256');
  for (const relative of inputs.files) {
    const absolute = path.join(projectRoot, relative);
    hash.update(`${relative}\0`);
    if (fs.existsSync(absolute)) hash.update(fs.readFileSync(absolute));
    else hash.update('<absent>');
    hash.update('\0');
  }
  for (const name of inputs.env) {
    hash.update(`${name}\0${process.env[name] ?? '<absent>'}\0`);
  }
  return hash.digest('hex');
}

export function metroEnvCheck(
  projectRoot: string,
  inputs: MetroEnvInputs,
  markerPath: string,
): FingerprintCheck {
  return checkFingerprintBaseline(markerPath, metroEnvFingerprint(projectRoot, inputs));
}

export function recordMetroEnvBaseline(
  projectRoot: string,
  inputs: MetroEnvInputs,
  markerPath: string,
  expectedFingerprint: string,
): boolean {
  return recordFingerprintBaseline(markerPath, expectedFingerprint, () =>
    metroEnvFingerprint(projectRoot, inputs),
  );
}
