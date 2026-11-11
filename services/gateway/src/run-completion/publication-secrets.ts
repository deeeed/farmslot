import type { FloorHit } from '@farmslot/handoff/scrub';

import secretScan from '../host-services/secret-scan.js';

/** A refusal must survive optional rendering fallbacks without exposing secret bytes. */
export class PublicationSecretError extends Error {
  constructor(hits: FloorHit[]) {
    super(
      `Publication blocked by secret values: ${hits.map(({ kind, fingerprint }) => `${kind} ${fingerprint}`).join(', ')}. Remove secrets from the producer, rerun the recipe, then refresh the gate package.`,
    );
    this.name = 'PublicationSecretError';
  }
}

/**
 * Resolves only after every text was scanned. Refuses on secret values, and on
 * any failure to complete the scan, so nothing publishes unscanned.
 */
export async function assertPublicationTextSafe(...texts: string[]): Promise<void> {
  const found = await secretScan.publication(...texts);
  if (found.length) throw new PublicationSecretError(found);
}
