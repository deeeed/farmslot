import { getProjectField, type RawProjectJson } from './config.js';
export const PREPARE_PREFLIGHT_TIMEOUT_MS = 15 * 60_000;

/** Resource boot hooks can perform the same cold setup as slot preparation. */
export function runtimeBootTimeoutMs(project: RawProjectJson): number {
  const seconds = Number(
    getProjectField(project, 'timeouts.prepare_preflight_s') ||
      getProjectField(project, 'timeouts.build_compile_s'),
  );
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : PREPARE_PREFLIGHT_TIMEOUT_MS;
}
