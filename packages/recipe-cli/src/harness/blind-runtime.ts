import type { RecipeRunOptions } from '@farmslot/adapter-sdk';

/** The launch boundary owns this port. Slot/context hydration may replace the
 * generic CDP variables, so they cannot be the source of the blind allocation. */
export function blindRecipeCdpPort(): string | undefined {
  if (process.env.FARMSLOT_BLIND_SEATBELT !== '1') return undefined;
  const value = process.env.FARMSLOT_BLIND_CDP_PORT;
  if (!value || !/^[0-9]+$/.test(value) || Number(value) < 1 || Number(value) > 65535)
    throw new Error('Blind recipes require the trial-allocated FARMSLOT_BLIND_CDP_PORT');
  return value;
}

export function blindRuntimeOptions<T extends RecipeRunOptions>(options: T): T {
  const cdpPort = blindRecipeCdpPort();
  return cdpPort ? { ...options, cdpPort } : options;
}
