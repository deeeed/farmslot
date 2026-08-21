// pressure-admission-control.ts — durable kill switch for pressure-based
// dispatch prevention (MANUAL-000109).
//
// Gateway-owned, default ENABLED. Disabling stops only pressure
// rejection/override prompts — sampling, history persistence, and charts
// continue untouched, and no other safety check (slot ownership, capability,
// runner, branch) is affected. The state persists under the resolved
// FARMSLOT_HOME with an atomic temp+rename write and records who changed it.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import type {
  PressureAdmissionControlState,
  PressureAdmissionGetResult,
  PressureAdmissionSetEnabledParams,
  PressureAdmissionSetEnabledResult,
} from '@farmslot/protocol';
import { farmslotHome } from '@farmslot/protocol/node/farmslot-home';

import { currentSessionOriginator } from '../../security/work-originator.js';

const CONTROL_VERSION = 1;

interface ControlFile extends PressureAdmissionControlState {
  version: typeof CONTROL_VERSION;
}

const DEFAULT_STATE: PressureAdmissionControlState = {
  enabled: true,
  updatedAt: null,
  updatedBy: null,
};

let cached: PressureAdmissionControlState | null = null;

function controlPath(): string {
  return path.join(farmslotHome(), 'state', 'pressure-admission-control.json');
}

function loadControlState(): PressureAdmissionControlState {
  const target = controlPath();
  if (!existsSync(target)) return { ...DEFAULT_STATE };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(target, 'utf-8'));
  } catch (error) {
    // Fail SAFE for a safety control: a corrupt file falls back to the
    // enabled default rather than silently disabling admission.
    console.error(
      `[pressure-admission] control file unreadable, using enabled default: ${(error as Error).message}`,
    );
    return { ...DEFAULT_STATE };
  }
  const file = parsed as Partial<ControlFile> | null;
  if (
    typeof file !== 'object' ||
    file === null ||
    file.version !== CONTROL_VERSION ||
    typeof file.enabled !== 'boolean'
  ) {
    console.error(
      '[pressure-admission] control file has an unsupported shape, using enabled default',
    );
    return { ...DEFAULT_STATE };
  }
  return {
    enabled: file.enabled,
    updatedAt: typeof file.updatedAt === 'string' ? file.updatedAt : null,
    updatedBy: typeof file.updatedBy === 'string' ? file.updatedBy : null,
  };
}

export function getPressureAdmissionControl(): PressureAdmissionGetResult {
  if (!cached) cached = loadControlState();
  return { ...cached };
}

export function isPressureAdmissionEnabled(): boolean {
  return getPressureAdmissionControl().enabled;
}

export function setPressureAdmissionEnabled(
  params: PressureAdmissionSetEnabledParams,
): PressureAdmissionSetEnabledResult {
  if (typeof params.enabled !== 'boolean') {
    throw new Error('dispatch.pressureAdmission.setEnabled requires enabled: boolean');
  }
  const originator = currentSessionOriginator();
  const next: ControlFile = {
    version: CONTROL_VERSION,
    enabled: params.enabled,
    updatedAt: new Date().toISOString(),
    updatedBy: originator.kind === 'principal' ? originator.principalId : 'system',
  };
  const target = controlPath();
  mkdirSync(path.dirname(target), { recursive: true });
  const temp = `${target}.tmp-${process.pid}`;
  writeFileSync(temp, JSON.stringify(next, null, 2));
  renameSync(temp, target);
  cached = { enabled: next.enabled, updatedAt: next.updatedAt, updatedBy: next.updatedBy };
  console.log(
    `[pressure-admission] dispatch pressure prevention ${next.enabled ? 'enabled' : 'DISABLED'} by ${next.updatedBy}`,
  );
  return { ...cached };
}

/** Test hook: drop the in-memory cache so the next read hits disk. */
export function resetPressureAdmissionControlCacheForTest(): void {
  cached = null;
}
