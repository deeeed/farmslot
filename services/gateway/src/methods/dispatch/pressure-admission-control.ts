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

import {
  DISPATCH_PRESSURE_ADMISSION_MODES,
  type DispatchPressureAdmissionMode,
  type PressureAdmissionControlState,
  type PressureAdmissionGetResult,
  type PressureAdmissionSetEnabledParams,
  type PressureAdmissionSetEnabledResult,
} from '@farmslot/protocol';
import { farmslotHome } from '@farmslot/protocol/node/farmslot-home';

import { currentSessionOriginator } from '../../security/work-originator.js';

// 2: the meaning of `enabled` inverted — dispatch pressure prevention became
// opt-in and off by default. A v1 file recorded "enabled" under the old
// semantics, where enabling meant returning to the shipped default; carrying it
// forward would leave an install that ran disable-then-enable silently
// enforcing after the upgrade. v1 files fall through to the unsupported-shape
// branch and land on the new default instead.
const CONTROL_VERSION = 2;

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
): DispatchPressureAdmissionMode | null {
  const raw = env[DISPATCH_PRESSURE_ADMISSION_ENV]?.trim();
  if (!raw) return null;
  if (!DISPATCH_PRESSURE_ADMISSION_MODES.includes(raw as DispatchPressureAdmissionMode)) {
    // Reads happen on the queue tick and behind dispatch.pressureAdmission.get.
    // Throwing here would leave an operator unable to even READ the control
    // state to find their typo, so the value is ignored (falling back to the
    // durable state) and the gateway refuses to start instead — see
    // assertPressureAdmissionEnvValid.
    warnOnceAboutInvalidEnv(raw);
    return null;
  }
  return raw as DispatchPressureAdmissionMode;
}

const warnedEnvValues = new Set<string>();

function warnOnceAboutInvalidEnv(raw: string): void {
  if (warnedEnvValues.has(raw)) return;
  warnedEnvValues.add(raw);
  console.error(
    `[pressure-admission] ignoring ${DISPATCH_PRESSURE_ADMISSION_ENV}='${raw}': must be ${DISPATCH_PRESSURE_ADMISSION_MODES.join(' or ')}`,
  );
}

/**
 * Fail-loud gate, called once at gateway startup. A typo in an operator's shell
 * must stop the process rather than silently resolve to a different enforcement
 * posture than the one they meant to set — but it must do so at boot, not from
 * inside every admission read.
 */
export function assertDispatchPressureAdmissionEnvValid(
  env: NodeJS.ProcessEnv = process.env,
): void {
  const raw = env[DISPATCH_PRESSURE_ADMISSION_ENV]?.trim();
  if (!raw) return;
  if (!DISPATCH_PRESSURE_ADMISSION_MODES.includes(raw as DispatchPressureAdmissionMode)) {
    throw new Error(
      `${DISPATCH_PRESSURE_ADMISSION_ENV} must be ${DISPATCH_PRESSURE_ADMISSION_MODES.join(' or ')}, got '${raw}'`,
    );
  }
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
  if (typeof file !== 'object' || file === null || typeof file.enabled !== 'boolean') {
    console.error(
      '[pressure-admission] control file has an unsupported shape, using the default (disabled)',
    );
    return { ...DEFAULT_STATE };
  }
  if (file.version !== CONTROL_VERSION) {
    // A pre-v2 file recorded `enabled` when enabling meant "back to the shipped
    // default", which was ON. Carrying that value forward would leave this
    // install enforcing after an upgrade that made the gate opt-in, so the
    // stored value is dropped and the operator re-opts in deliberately.
    console.error(
      `[pressure-admission] control file is version ${String(file.version)}, not ${CONTROL_VERSION}; ` +
        'dispatch pressure prevention is now opt-in, so the stored setting is reset to disabled — ' +
        're-enable it with `farmslot dispatch pressure-admission enable` if you want it enforcing',
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
