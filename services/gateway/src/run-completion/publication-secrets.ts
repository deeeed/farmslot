import { type FloorHit, scanForFloorSecrets } from '@farmslot/handoff/scrub';

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
    const hits = scanForFloorSecrets(text);
    if (hits.length) throw new PublicationSecretError(hits);
  }
}
