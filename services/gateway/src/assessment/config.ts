import { readFileSync } from 'node:fs';
import path from 'node:path';

import { farmslotHome } from '@farmslot/protocol/node/farmslot-home';

export interface AssessmentConfig {
  enabled: boolean;
  provider?: string;
  model?: string;
  timeoutMs: number;
  maxStateBytes: number;
}

const DEFAULTS: AssessmentConfig = {
  enabled: false,
  timeoutMs: 15_000,
  maxStateBytes: 64 * 1024,
};

/** Validate persisted configuration rather than silently ignoring misspelled opt-outs. */
function validate(value: unknown): Partial<AssessmentConfig> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Assessment configuration must be an object');
  }
  const raw = value as Record<string, unknown>;
  for (const [key, entry] of Object.entries(raw)) {
    if (key === 'enabled' && typeof entry === 'boolean') continue;
    if (
      (key === 'provider' || key === 'model') &&
      typeof entry === 'string' &&
      /^[\w.-]{1,100}$/.test(entry)
    )
      continue;
    if (
      key === 'timeoutMs' &&
      Number.isInteger(entry) &&
      Number(entry) >= 1 &&
      Number(entry) <= 60_000
    )
      continue;
    if (
      key === 'maxStateBytes' &&
      Number.isInteger(entry) &&
      Number(entry) >= 1 &&
      Number(entry) <= 256 * 1024
    )
      continue;
    throw new Error(`Invalid assessment setting: ${key}`);
  }
  return raw as Partial<AssessmentConfig>;
}

export function getAssessmentConfig(): AssessmentConfig {
  let file: Partial<AssessmentConfig> = {};
  try {
    file = validate(
      JSON.parse(readFileSync(path.join(farmslotHome(), 'assessment-config.json'), 'utf8')),
    );
  } catch (error) {
    // An absent optional configuration means disabled; corrupt configuration is an error.
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const overrides: Record<string, unknown> = {};
  for (const [key, env] of Object.entries({
    enabled: 'FARMSLOT_ASSESSMENT_ENABLED',
    provider: 'FARMSLOT_ASSESSMENT_PROVIDER',
    model: 'FARMSLOT_ASSESSMENT_MODEL',
    timeoutMs: 'FARMSLOT_ASSESSMENT_TIMEOUT_MS',
    maxStateBytes: 'FARMSLOT_ASSESSMENT_MAX_STATE_BYTES',
  })) {
    const value = process.env[env];
    if (value === undefined) continue;
    if (key === 'enabled') {
      if (value !== 'true' && value !== 'false')
        throw new Error(`Invalid assessment setting: ${key}`);
      overrides[key] = value === 'true';
    } else overrides[key] = key === 'timeoutMs' || key === 'maxStateBytes' ? Number(value) : value;
  }
  return { ...DEFAULTS, ...file, ...validate(overrides) };
}

/** Compatibility seam for isolated gateway tests; configuration is read per call. */
export function resetAssessmentConfigForTests(): void {}
