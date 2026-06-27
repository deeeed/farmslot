/** Demo-only monitoring banner (farmslot#114). Gated by EXPO_PUBLIC_FARMSLOT_DEMO_BANNER=1. */

export const COMPANION_DEMO_BANNER_TEXT = 'FARMSLOT DEMO: MOBILE OPERATOR MONITORING';

export function isCompanionDemoBannerEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env.EXPO_PUBLIC_FARMSLOT_DEMO_BANNER === '1';
}