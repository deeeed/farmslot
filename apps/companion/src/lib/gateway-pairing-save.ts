import type { InteractiveGatewayCredentials, PersonSessionAuth } from '@farmslot/protocol';

import { type GatewayProfile, restoreGatewayProfileLogin } from './gateway-profiles';

type PairingEntry = { profile: GatewayProfile; secret?: string; personSession?: PersonSessionAuth };

/**
 * Credentials for probing a paired address before anything is saved. They hold the new grant in
 * memory, so a probe that refreshes it, sees it end, or has a service credential refused writes
 * nothing to the device.
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
 * Keeps a pairing once one of its addresses answers. Until then nothing is saved, so the logins a
 * running client or a probe reads stay as they were. The logins are then saved all or nothing and
 * the answering address is activated; a failed activation keeps the logins the probe just verified.
 */
export async function keepPairing<T extends PairingEntry, R extends { profile: GatewayProfile }>(
  imported: readonly T[],
  steps: {
    probe: () => Promise<R | null>;
    save: (entry: T, onReplace: (previous: string | null) => void) => Promise<void>;
    activate: (preferred: R) => Promise<void>;
  },
): Promise<R> {
  const preferred = await steps.probe();
  if (!preferred)
    throw new Error(
      'None of the paired addresses answered, so nothing was saved. Check the connection and pair again with a new code.',
    );
  await savePairedProfiles(imported, steps.save);
  await steps.activate(preferred);
  return preferred;
}

/**
 * Saves every profile a pairing produced, or keeps none of their logins: if a save fails, each
 * login this pairing wrote goes back to the value it replaced, unless someone has saved a newer
 * login since.
 */
export async function savePairedProfiles<T extends PairingEntry>(
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
