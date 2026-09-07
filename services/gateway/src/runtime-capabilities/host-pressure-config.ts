// host-pressure-config.ts — resolution of the OPT-IN host-pressure admission
// policy for capability acquires.
//
// Precedence, highest first:
//   1. FARMSLOT_HOST_PRESSURE_ADMISSION on the gateway process (operator escape
//      hatch for one stack, e.g. a dev checkout on a loaded laptop);
//   2. the project's runtime_capabilities.host_pressure_admission block;
//   3. 'off' — the default. Pressure is evaluated and reported, never enforced.
//
// The critical thresholds are the same values resource.ts has always used; a
// project may raise or lower them, and the warn band is not tunable.

import {
  HOST_PRESSURE_ADMISSION_MODES,
  type HostPressureAdmissionMode,
  type ProjectHostPressureAdmissionConfig,
} from '@farmslot/protocol';

/** Gateway defaults, identical to the thresholds resource.ts applies. */
export const DEFAULT_HOST_PRESSURE_THRESHOLDS = {
  load1CriticalMultiplier: 1.5,
  cpuCriticalPercent: 90,
  memoryCriticalPercent: 90,
  diskCriticalPercent: 95,
} as const;

export type HostPressureThresholds = {
  -readonly [K in keyof typeof DEFAULT_HOST_PRESSURE_THRESHOLDS]: number;
};

export const HOST_PRESSURE_ADMISSION_ENV = 'FARMSLOT_HOST_PRESSURE_ADMISSION';

export interface ResolvedHostPressureAdmission {
  mode: HostPressureAdmissionMode;
  /** Where the mode came from, for operator-facing evidence. */
  source: 'env' | 'project' | 'default';
  thresholds: HostPressureThresholds;
}

/**
 * The gateway-wide override, or null when unset. An unrecognized value throws:
 * a typo in an operator's shell must not silently fall back to a different
 * enforcement posture than the one they meant to set.
 */
export function hostPressureAdmissionEnvOverride(
  env: NodeJS.ProcessEnv = process.env,
): HostPressureAdmissionMode | null {
  const raw = env[HOST_PRESSURE_ADMISSION_ENV]?.trim();
  if (!raw) return null;
  if (!HOST_PRESSURE_ADMISSION_MODES.includes(raw as HostPressureAdmissionMode)) {
    throw new Error(
      `${HOST_PRESSURE_ADMISSION_ENV} must be ${HOST_PRESSURE_ADMISSION_MODES.join(', ')}, got '${raw}'`,
    );
  }
  return raw as HostPressureAdmissionMode;
}

export function resolveHostPressureAdmission(
  projectConfig: ProjectHostPressureAdmissionConfig | undefined,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedHostPressureAdmission {
  // Thresholds stay project-owned even when the env pins the mode: an operator
  // switching enforcement on for one stack still wants the project's own idea
  // of what "critical" means on its machines.
  const thresholds: HostPressureThresholds = {
    load1CriticalMultiplier:
      projectConfig?.load1CriticalMultiplier ??
      DEFAULT_HOST_PRESSURE_THRESHOLDS.load1CriticalMultiplier,
    cpuCriticalPercent:
      projectConfig?.cpuCriticalPercent ?? DEFAULT_HOST_PRESSURE_THRESHOLDS.cpuCriticalPercent,
    memoryCriticalPercent:
      projectConfig?.memoryCriticalPercent ??
      DEFAULT_HOST_PRESSURE_THRESHOLDS.memoryCriticalPercent,
    diskCriticalPercent:
      projectConfig?.diskCriticalPercent ?? DEFAULT_HOST_PRESSURE_THRESHOLDS.diskCriticalPercent,
  };
  const override = hostPressureAdmissionEnvOverride(env);
  if (override) return { mode: override, source: 'env', thresholds };
  if (projectConfig) return { mode: projectConfig.mode, source: 'project', thresholds };
  return { mode: 'off', source: 'default', thresholds };
}
