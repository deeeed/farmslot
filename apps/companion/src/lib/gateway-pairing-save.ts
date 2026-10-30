import type { PersonSessionAuth } from '@farmslot/protocol';

import { type GatewayProfile, restoreGatewayProfileLogin } from './gateway-profiles';

/**
 * Saves every profile a pairing produced and activates one, or keeps none of their logins. If a
 * save or the activation fails, each login this pairing wrote goes back to the value it replaced,
 * unless someone has saved a newer login since, and `afterRollback` gets the profiles it touched.
 */
export async function savePairedProfiles<
  T extends { profile: GatewayProfile; secret?: string; personSession?: PersonSessionAuth },
  R,
>(
  imported: readonly T[],
  steps: {
    save: (entry: T, onReplace: (previous: string | null) => void) => Promise<void>;
    activate: () => Promise<R>;
    afterRollback?: (profiles: GatewayProfile[]) => Promise<void>;
  },
): Promise<R> {
  const replaced = new Map<T, string | null>();
  try {
    for (const entry of imported)
      await steps.save(entry, (previous) => {
        if (!replaced.has(entry)) replaced.set(entry, previous);
      });
    return await steps.activate();
  } catch (error) {
    await Promise.all(
      [...replaced].map(([entry, previous]) =>
        restoreGatewayProfileLogin(entry.profile, previous, {
          personSessionId: entry.personSession?.session.id,
          credential: entry.secret,
        }),
      ),
    );
    // The pairing's error is the one to report; a failed re-sync shows on the connection itself.
    await steps
      .afterRollback?.([...replaced.keys()].map(({ profile }) => profile))
      .catch(() => undefined);
    throw error;
  }
}
