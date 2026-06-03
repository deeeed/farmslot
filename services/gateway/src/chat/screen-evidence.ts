import { randomUUID } from 'node:crypto';

import {
  type ChatClientContext,
  COMMAND_CENTER_SURFACES,
  matchCommandCenterSurface,
  type ScreenEvidenceSnapshot,
} from '@farmslot/protocol';

const SCREEN_EVIDENCE_TTL_MS = 5 * 60 * 1000;
export const SCREEN_EVIDENCE_MAX_SESSIONS = 100;
const snapshots = new Map<string, ScreenEvidenceSnapshot>();
let warnedInvalidFreshnessInput = false;

function isoAfter(ms: number): string {
  return new Date(Date.now() + ms).toISOString();
}

function freshness(capturedAt: string, ttlMs: number): ScreenEvidenceSnapshot['freshness'] {
  const age = Date.now() - Date.parse(capturedAt);
  if (!Number.isFinite(age)) {
    if (!warnedInvalidFreshnessInput) {
      warnedInvalidFreshnessInput = true;
      console.warn('[gateway-chat] Invalid screen evidence timestamp; expiring snapshot');
    }
    return 'expired';
  }
  if (age > ttlMs) return 'expired';
  return age > ttlMs / 2 ? 'stale' : 'fresh';
}

function withFreshness(snapshot: ScreenEvidenceSnapshot): ScreenEvidenceSnapshot {
  const nextFreshness = freshness(snapshot.capturedAt, snapshot.ttlMs);
  const uncertainty = new Set<ScreenEvidenceSnapshot['uncertainty'][number]>(
    snapshot.uncertainty.filter((item) => item !== 'stale' && item !== 'expired'),
  );
  if (nextFreshness === 'stale') uncertainty.add('stale');
  if (nextFreshness === 'expired') uncertainty.add('expired');
  return { ...snapshot, freshness: nextFreshness, uncertainty: [...uncertainty] };
}

function evictSnapshots(): void {
  for (const [sessionId, snapshot] of snapshots) {
    if (freshness(snapshot.capturedAt, snapshot.ttlMs) === 'expired') snapshots.delete(sessionId);
  }
  while (snapshots.size > SCREEN_EVIDENCE_MAX_SESSIONS) {
    const oldest = snapshots.keys().next();
    if (oldest.done) return;
    snapshots.delete(oldest.value);
  }
}

function setOptional<K extends keyof ScreenEvidenceSnapshot>(
  snapshot: ScreenEvidenceSnapshot,
  key: K,
  value: ScreenEvidenceSnapshot[K] | undefined,
): void {
  if (Array.isArray(value) && value.length === 0) return;
  if (value === undefined || value === '') return;
  snapshot[key] = value;
}

export function recordScreenEvidenceSnapshot(
  sessionId: string,
  context: ChatClientContext | undefined,
  requestId?: string,
): ScreenEvidenceSnapshot | null {
  if (!context) return null;

  const matched = context.hash ? matchCommandCenterSurface(context.hash) : null;
  const surface =
    matched?.surface ??
    COMMAND_CENTER_SURFACES.find((item) => item.surfaceId === context.surfaceId);
  const capturedAt = new Date().toISOString();
  const uncertainty = new Set<ScreenEvidenceSnapshot['uncertainty'][number]>();
  if (!surface) uncertainty.add('unknown-route');
  if (!context.visibleTextSnippets?.length && !context.visibleControls?.length)
    uncertainty.add('partial-visible-context');
  if (uncertainty.size === 0) uncertainty.add('none');

  const snapshot: ScreenEvidenceSnapshot = {
    snapshotId: randomUUID(),
    sessionId,
    surfaceId: surface?.surfaceId ?? context.surfaceId ?? 'unknown',
    capturedAt,
    ttlMs: SCREEN_EVIDENCE_TTL_MS,
    expiresAt: isoAfter(SCREEN_EVIDENCE_TTL_MS),
    freshness: 'fresh',
    provenance: ['ui-client-context', 'surface-registry', 'gateway-cache'],
    uncertainty: [...uncertainty],
  };
  setOptional(snapshot, 'requestId', requestId);
  setOptional(snapshot, 'routePattern', surface?.routePattern ?? context.routePattern);
  setOptional(snapshot, 'route', context.route);
  setOptional(snapshot, 'hash', context.hash);
  setOptional(
    snapshot,
    'query',
    Object.keys(context.query ?? {}).length ? context.query : undefined,
  );
  setOptional(snapshot, 'selectedRunId', context.selectedRunId);
  setOptional(snapshot, 'selectedFamilyId', context.selectedFamilyId);
  setOptional(snapshot, 'selectedStepName', context.selectedStepName);
  setOptional(snapshot, 'selectedSlotId', context.selectedSlotId);
  setOptional(snapshot, 'selectedDecisionId', context.selectedDecisionId);
  setOptional(snapshot, 'selectedConfigName', context.selectedConfigName);
  setOptional(snapshot, 'selectedPullRequestNumber', context.selectedPullRequestNumber);
  setOptional(snapshot, 'selectedPullRequestRepo', context.selectedPullRequestRepo);
  setOptional(snapshot, 'selectedPullRequestRef', context.selectedPullRequestRef);
  setOptional(snapshot, 'compareRunIds', context.compareRunIds);
  setOptional(
    snapshot,
    'affordances',
    context.affordances?.length ? context.affordances : surface?.affordances,
  );
  setOptional(snapshot, 'preferredTools', surface?.preferredTools);
  setOptional(snapshot, 'visibleElementTags', context.visibleElementTags);
  setOptional(snapshot, 'visibleTextSnippets', context.visibleTextSnippets);
  setOptional(snapshot, 'visibleControls', context.visibleControls);
  snapshots.delete(sessionId);
  snapshots.set(sessionId, snapshot);
  evictSnapshots();
  return snapshot;
}

export function clearScreenEvidenceSnapshot(sessionId: string): void {
  snapshots.delete(sessionId);
}

export function readLastScreenEvidence(sessionId: string): ScreenEvidenceSnapshot | null {
  const snapshot = snapshots.get(sessionId);
  if (!snapshot) return null;
  const freshSnapshot = withFreshness(snapshot);
  if (freshSnapshot.freshness === 'expired') {
    snapshots.delete(sessionId);
    return null;
  }
  snapshots.delete(sessionId);
  snapshots.set(sessionId, freshSnapshot);
  return freshSnapshot;
}
