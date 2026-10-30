import type { InteractiveGatewayCredentials, PersonSessionAuth } from '@farmslot/protocol';

import { type GatewayProfile, restoreGatewayProfileLogin } from './gateway-profiles';

/**
 * Credentials for probing a paired address while the pairing can still be undone. They hold the
 * new grant in memory: a probe that sees the new session end, or a service credential refused,
 * writes nothing over the saved login a rollback has to find.
 */
export function pairingProbeCredentials(entry: {
  secret?: string;
  personSession?: PersonSessionAuth;
}): InteractiveGatewayCredentials {
  if (!entry.personSession) return entry.secret ? { token: entry.secret } : {};
  let held: PersonSessionAuth | null = entry.personSession;
  return {
    sessionStorage: {
      load: async () => held,
      save: async (value) => {
        held = value;
      },
    },
    personSessionRequired: true,
  };
}

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
