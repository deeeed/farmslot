import { APPROVE_PUBLISH_UNRESOLVED_ACTION } from './review-retries.js';

/** Approve publication of a package whose reviews satisfy the gate's policy. */
export const APPROVE_PUBLISH_ACTION = 'approve-publish';

/**
 * Human override action surfaced on the publish gate when staleness is caused
 * purely by evidence/subject drift while the reviewed HEAD still matches the
 * prepared package. Carries the prior pass verdict forward instead of forcing a
 * needless re-review. Never offered when the reviewed code actually changed.
 */
export const APPROVE_PUBLISH_EVIDENCE_REFRESH_ACTION = 'approve-publish-evidence-refresh';

/** Explicit human escape when the slot disappeared before its diff snapshot could be recaptured. */
export const APPROVE_PUBLISH_SNAPSHOT_UNAVAILABLE_ACTION = 'approve-publish-snapshot-unavailable';

/**
 * Action ids that approve a local-first publication at the human ready/publish
 * gate. Shared so the engine loop exit, finalize guard, decision replay, the
 * resolve freshness check and every client guard recognize the same set rather
 * than scattering string literals that drift apart.
 */
export const PUBLISH_APPROVAL_ACTIONS: ReadonlySet<string> = new Set([
  APPROVE_PUBLISH_ACTION,
  APPROVE_PUBLISH_EVIDENCE_REFRESH_ACTION,
  APPROVE_PUBLISH_SNAPSHOT_UNAVAILABLE_ACTION,
  APPROVE_PUBLISH_UNRESOLVED_ACTION,
  'ready',
]);

export function isPublishApprovalAction(actionId: string | null | undefined): boolean {
  return PUBLISH_APPROVAL_ACTIONS.has(actionId ?? '');
}
