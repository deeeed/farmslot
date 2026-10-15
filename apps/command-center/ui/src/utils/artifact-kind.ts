import type { EvidenceReviewModel } from '@farmslot/adapter-sdk/evidence';
export type ArtifactKind = 'before' | 'after' | 'setup';

/** Missing checked capture bindings remain unassigned. */
export function artifactKind(
  path: string,
  _purpose: string,
  model?: EvidenceReviewModel | null,
): ArtifactKind {
  const role = model?.artifactRole(path);
  return role === 'before' || role === 'after' ? role : 'setup';
}
