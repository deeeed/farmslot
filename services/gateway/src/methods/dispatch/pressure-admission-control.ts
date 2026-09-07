// pressure-admission-control.ts — durable opt-in switch for pressure-based
// dispatch prevention (MANUAL-000109).
//
// Gateway-owned, default DISABLED: sustained-pressure dispatch prevention was
// never meant to be always-on, and a loaded operator machine must not have its
// own dispatches refused by default. Enabling turns on pressure
// rejection/override prompts — sampling, history persistence, charts, and the
// advisory evidence on every decision run either way, and no other safety check
// (slot ownership, capability, runner, branch) is affected. The state persists
// under the resolved FARMSLOT_HOME with an atomic temp+rename write and records
// who changed it. FARMSLOT_DISPATCH_PRESSURE_ADMISSION on the gateway process
// wins over the persisted state.

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
  enabled: false,
  updatedAt: null,
  updatedBy: null,
};

export const DISPATCH_PRESSURE_ADMISSION_ENV = 'FARMSLOT_DISPATCH_PRESSURE_ADMISSION';

/**
 * Gateway-process override, or null when unset. An unrecognized value throws:
 * a typo in an operator's shell must not silently resolve to the opposite
 * enforcement posture from the one they meant to set.
 */
export function dispatchPressureAdmissionEnvOverride(
  env: NodeJS.ProcessEnv = process.env,
): 'off' | 'refuse' | null {
  const raw = env[DISPATCH_PRESSURE_ADMISSION_ENV]?.trim();
  if (!raw) return null;
  if (raw !== 'off' && raw !== 'refuse') {
    throw new Error(`${DISPATCH_PRESSURE_ADMISSION_ENV} must be off or refuse, got '${raw}'`);
  }
  return raw;
}

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
    // A corrupt file falls back to the shipped default rather than to a
    // guessed posture; the operator's real setting is unknowable here.
    console.error(
      `[pressure-admission] control file unreadable, using the default (disabled): ${(error as Error).message}`,
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
      '[pressure-admission] control file has an unsupported shape, using the default (disabled)',
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
  const envOverride = dispatchPressureAdmissionEnvOverride();
  // The persisted `enabled` is reported verbatim even when the env wins, so an
  // operator can see both what this stack is doing and what the durable state
  // says. `isPressureAdmissionEnabled` is the one place that resolves them.
  return { ...cached, ...(envOverride ? { envOverride } : {}) };
}

export function isPressureAdmissionEnabled(): boolean {
  const state = getPressureAdmissionControl();
  return state.envOverride ? state.envOverride === 'refuse' : state.enabled;
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
  // Report through the same resolver as a read, so a caller that toggles the
  // durable state while an env override is pinned sees that it does not win.
  return getPressureAdmissionControl();
}

/** Test hook: drop the in-memory cache so the next read hits disk. */
export function resetPressureAdmissionControlCacheForTest(): void {
  cached = null;
}
