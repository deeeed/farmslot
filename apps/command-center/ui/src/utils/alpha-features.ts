import { safeLsGet, safeLsSet } from './storage.js';

// Stopgap until real feature-flagging exists: alpha-tagged nav items
// (NAV_ITEMS `maturity: 'alpha'` in app-shell.ts, e.g. Intelligence and
// Evals) are gated behind this single flag. Default: shown on a dev launch
// (Vite dev server), hidden otherwise — overridable any time via the
// Config > Settings toggle, which persists the explicit choice here.
export const ALPHA_FEATURES_STORAGE_KEY = 'farmslot:alpha-features';
export const ALPHA_FEATURES_CHANGED = 'farmslot-alpha-features-changed';

export function isDevLaunch(): boolean {
  return Boolean((import.meta as { env?: Record<string, unknown> }).env?.DEV);
}

export function resolveAlphaFeaturesEnabled(
  storedValue: string | null,
  devDefault: boolean,
): boolean {
  if (storedValue === 'true') return true;
  if (storedValue === 'false') return false;
  return devDefault;
}

export function getAlphaFeaturesEnabled(): boolean {
  return resolveAlphaFeaturesEnabled(safeLsGet(ALPHA_FEATURES_STORAGE_KEY), isDevLaunch());
}

export function setAlphaFeaturesEnabled(enabled: boolean): void {
  safeLsSet(ALPHA_FEATURES_STORAGE_KEY, String(enabled));
  window.dispatchEvent(new CustomEvent(ALPHA_FEATURES_CHANGED, { detail: { enabled } }));
}
