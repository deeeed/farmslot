import { getProjectField, type RawProjectJson } from './config.js';
export const PREPARE_PREFLIGHT_TIMEOUT_MS = 15 * 60_000;

/** Resource boot hooks can perform the same cold setup as slot preparation. */
export function runtimeBootTimeoutMs(project: RawProjectJson): number {
  const prepareSeconds = Number(getProjectField(project, 'timeouts.prepare_preflight_s'));
  if (Number.isFinite(prepareSeconds) && prepareSeconds > 0) return prepareSeconds * 1000;
  const compileSeconds = Number(getProjectField(project, 'timeouts.build_compile_s'));
  // Compilation is only part of boot, which also launches and verifies the runtime.
  return Number.isFinite(compileSeconds) && compileSeconds > 0
    ? Math.max(PREPARE_PREFLIGHT_TIMEOUT_MS, compileSeconds * 1000)
    : PREPARE_PREFLIGHT_TIMEOUT_MS;
}
