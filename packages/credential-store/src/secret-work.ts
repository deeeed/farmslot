import {
  generateCredentialSecret,
  hashSecret,
  hashSecretAsync,
  sameStoredSecret,
  verifySecret,
  verifySecretAsync,
} from './credential-secret.js';
import type { StoredSecret } from './credential-store.js';

/** A newly minted secret: the raw value goes to the client, the hash to the store. */
export interface IssuedSecret {
  raw: string;
  stored: StoredSecret;
}

/** How a store mutation checks a presented secret and mints new ones. */
export interface SecretWork {
  verify(presented: string, stored: StoredSecret): boolean;
  issue(): IssuedSecret;
}

/** Derives inline. For one-shot commands, where blocking the process is harmless. */
export const inlineSecretWork: SecretWork = {
  verify: verifySecret,
  issue: () => {
    const raw = generateCredentialSecret();
    return { raw, stored: hashSecret(raw) };
  },
};

/**
 * Does a mutation's scrypt work before it takes the store lock, off the event loop. The mutation
 * reads the store again under the lock, so a check against a hash that changed meanwhile, or a
 * secret beyond those prepared, is derived inline: correct, and rare.
 */
export async function prepareSecretWork(
  checks: ReadonlyArray<readonly [presented: string, stored: StoredSecret]>,
  issues: number,
): Promise<SecretWork> {
  const verified = await Promise.all(
    checks.map(async ([presented, stored]) => ({
      presented,
      stored,
      ok: await verifySecretAsync(presented, stored),
    })),
  );
  // A failed check refuses the mutation before it issues anything: derive nothing for it.
  const issued = verified.every((entry) => entry.ok)
    ? await Promise.all(
        Array.from({ length: issues }, async () => {
          const raw = generateCredentialSecret();
          return { raw, stored: await hashSecretAsync(raw) };
        }),
      )
    : [];
  return {
    verify(presented, stored) {
      const check = verified.find(
        (entry) => entry.presented === presented && sameStoredSecret(entry.stored, stored),
      );
      return check ? check.ok : verifySecret(presented, stored);
    },
    issue: () => issued.shift() ?? inlineSecretWork.issue(),
  };
}
