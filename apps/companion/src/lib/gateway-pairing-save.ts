import type { PersonSessionAuth } from '@farmslot/protocol';

import { type GatewayProfile, restoreGatewayProfileLogin } from './gateway-profiles';

/**
 * Saves every profile a pairing produced, or none of their logins. If a save fails, each login this
 * pairing wrote goes back to the value it replaced, unless someone has saved a newer login since.
 */
export async function savePairedProfiles<
  T extends { profile: GatewayProfile; secret?: string; personSession?: PersonSessionAuth },
>(
  imported: readonly T[],
  save: (entry: T, onReplace: (previous: string | null) => void) => Promise<void>,
): Promise<void> {
  const replaced = new Map<T, string | null>();
  try {
    for (const entry of imported)
      await save(entry, (previous) => {
        if (!replaced.has(entry)) replaced.set(entry, previous);
      });
  } catch (error) {
    await Promise.all(
      [...replaced].map(([entry, previous]) =>
        restoreGatewayProfileLogin(entry.profile, previous, {
          personSessionId: entry.personSession?.session.id,
          credential: entry.secret,
        }),
      ),
    );
    throw error;
  }
}
