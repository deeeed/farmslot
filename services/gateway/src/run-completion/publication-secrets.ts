import { createHash } from 'node:crypto';

import { type FloorHit, scanForFloorSecrets } from '@farmslot/handoff/scrub';

// Repeated publication checks still validate frozen bytes. Cache only clean
// text hashes to avoid rescanning the same immutable logs at each boundary.
const cleanTextHashes = new Set<string>();
const MAX_CLEAN_TEXT_HASHES = 256;

/** A refusal must survive optional rendering fallbacks without exposing secret bytes. */
export class PublicationSecretError extends Error {
  constructor(hits: FloorHit[]) {
    super(
      `Publication blocked by secret values: ${hits.map(({ kind, fingerprint }) => `${kind} ${fingerprint}`).join(', ')}. Remove secrets from the producer, rerun the recipe, then refresh the gate package.`,
    );
    this.name = 'PublicationSecretError';
  }
}

export function assertPublicationTextSafe(...texts: string[]): void {
  for (const text of texts) {
    const digest = createHash('sha256').update(text).digest('hex');
    if (cleanTextHashes.has(digest)) continue;
    const hits = scanForFloorSecrets(text);
    if (hits.length) throw new PublicationSecretError(hits);
    cleanTextHashes.add(digest);
    if (cleanTextHashes.size > MAX_CLEAN_TEXT_HASHES) {
      const oldest = cleanTextHashes.values().next();
      if (!oldest.done) cleanTextHashes.delete(oldest.value);
    }
  }
}
