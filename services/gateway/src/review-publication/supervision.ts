import type { Run } from '@farmslot/protocol';

import type { PrincipalOwner } from '../security/work-originator.js';

/**
 * The recorded owner an admin publishes a review as. An admin supervises the
 * native owner's reviews, delegated ones included, and publication then runs
 * under that owner's own authority and identity checks.
 */
export function supervisedPublicationOwner(
  run: Pick<Run, 'reviewPublication' | 'prWork'> | undefined,
  callerId: string,
  supervising: boolean,
): PrincipalOwner | undefined {
  const recorded =
    run?.reviewPublication?.gate?.publication ??
    run?.reviewPublication?.direct ??
    run?.prWork?.review;
  return recorded &&
    supervising &&
    recorded.ownerId !== callerId &&
    recorded.ownerId === process.env.FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID
    ? { ownerId: recorded.ownerId, ownerGeneration: recorded.ownerGeneration }
    : undefined;
}
