// feedback-candidates.ts — deduplicated, evidence-backed PR feedback for the
// learning loop. One candidate per provider comment/review identity, merged
// from the worker's comments-triage.json and the persistent PR monitor
// incidents, annotated with attribution and ledger consumption state.
//
// Human-requested changes are a signal to investigate, never automatic proof
// that a worker introduced a defect: attribution stays visible and review-only
// or follow-up-only families are labelled as such.
import { createHash } from 'node:crypto';
import path from 'node:path';

import {
  type FeedbackAttributionKind,
  type FeedbackAuthorKind,
  type FeedbackCandidate,
  type FeedbackCandidateSummary,
  type FeedbackConsumption,
  monitoredPRKey,
  parseGitHubRef,
  PR_BOUND_FLOW_TYPES,
  type PRMonitor,
  type PRMonitorIncident,
  type PRMonitorSignal,
  type RetrospectivePayload,
  type Run,
} from '@farmslot/protocol';

import {
  type CommentsTriageEntry,
  normalizeCommentSource,
  readCommentsTriageEntries,
} from '../run-completion/retrospective.js';

import {
  consumptionsBySourceKey,
  type FeedbackLedger,
  readFeedbackLedger,
} from './feedback-ledger.js';

const EXCERPT_MAX = 240;
const CANDIDATE_CAP = 80;
const GITHUB_HOST = 'github.com';

export interface FeedbackPRTarget {
  host: string;
  repository: string;
  prNumber: number;
}

export interface FeedbackCandidateInput {
  target: FeedbackPRTarget;
  /** Every run in the family, including the terminal run. */
  familyRuns: Run[];
  triage: Array<{ runId: string; entries: CommentsTriageEntry[] }>;
  monitors: Array<Pick<PRMonitor, 'config' | 'incidents' | 'observation' | 'originatingRunIds'>>;
  ledger: FeedbackLedger;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function collapse(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** Provider-owned identity: comment/review database id parsed from the GitHub URL. */
export function feedbackIdentityFromUrl(
  url: string,
): { kind: FeedbackCandidate['kind']; providerId: string } | null {
  const discussion = url.match(/#discussion_r(\d+)$/);
  if (discussion) return { kind: 'review-comment', providerId: discussion[1]! };
  const review = url.match(/#pullrequestreview-(\d+)$/);
  if (review) return { kind: 'review', providerId: review[1]! };
  const issue = url.match(/#issuecomment-(\d+)$/);
  if (issue) return { kind: 'review-comment', providerId: `issue-${issue[1]!}` };
  return null;
}

export function feedbackSourceKey(
  target: FeedbackPRTarget,
  kind: FeedbackCandidate['kind'],
  providerId: string,
): string {
  return `${target.host.toLowerCase()}/${target.repository.toLowerCase()}#${target.prNumber}:${kind}:${providerId}`;
}

/**
 * PR the family is bound to. A discovered `prNumber` (with the project repo)
 * wins; `ticketOrPr` is only a PR reference for PR-bound flows — for dev and
 * fix-bug runs it names the originating issue, not the resulting PR.
 */
export function feedbackTargetForRun(
  run: Run,
  familyRuns: Run[],
  projectRepository: string | null,
): FeedbackPRTarget | null {
  const members = [run, ...familyRuns.filter((member) => member.id !== run.id)];
  if (projectRepository) {
    for (const member of members) {
      if (member.prNumber) {
        return { host: GITHUB_HOST, repository: projectRepository, prNumber: member.prNumber };
      }
    }
  }
  for (const member of members) {
    if (!PR_BOUND_FLOW_TYPES.has(member.flowType)) continue;
    const ref = parseGitHubRef(member.ticketOrPr);
    if (ref) return { host: GITHUB_HOST, repository: ref.repo, prNumber: ref.number };
  }
  return null;
}

/** `git@github.com:Owner/Repo.git` or `https://github.com/Owner/Repo(.git)` → `Owner/Repo`; other hosts → null. */
export function githubRepositorySlugFromUrl(url: string | undefined | null): string | null {
  if (!url) return null;
  const match = url.trim().match(/github\.com[:/]([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/i);
  return match ? match[1]! : null;
}

function isChangeRootFlow(run: Run): boolean {
  return run.flowType === 'dev' || run.flowType === 'fix-bug';
}
function isFollowUpFlow(run: Run): boolean {
  return run.flowType === 'pr-complete' || run.flowType === 'update-branch';
}

function attributionFor(familyRuns: Run[]): {
  kind: FeedbackAttributionKind;
  note: string;
  familyChangeRunIds: string[];
} {
  const roots = familyRuns.filter(isChangeRootFlow);
  const followUps = familyRuns.filter(isFollowUpFlow);
  if (roots.length > 0) {
    return {
      kind: 'family-change',
      note: 'family-associated; exact introduced commit requires verification',
      familyChangeRunIds: [...roots, ...followUps].map((run) => run.id),
    };
  }
  if (followUps.length > 0) {
    return {
      kind: 'follow-up-only',
      note: "follow-up on another author's PR; original implementation attribution incomplete",
      familyChangeRunIds: followUps.map((run) => run.id),
    };
  }
  if (familyRuns.some((run) => run.flowType === 'review-pr' || run.flowType === 'qa')) {
    return {
      kind: 'review-only',
      note: 'review-only run; not evidence that a worker introduced the defect',
      familyChangeRunIds: [],
    };
  }
  return {
    kind: 'unknown',
    note: 'no linked implementation or review run',
    familyChangeRunIds: [],
  };
}

function reviewAuthorKind(signal: PRMonitorSignal): FeedbackAuthorKind {
  const login = signal.summary.split(' ')[0] ?? '';
  return login.endsWith('[bot]') ? 'bot' : 'human';
}

const RESOLUTION_RANK = { fixed: 3, resolved: 2, open: 1, unknown: 0 } as const;

interface Draft {
  sourceKey: string;
  kind: FeedbackCandidate['kind'];
  authorLogin?: string;
  authorKind: FeedbackAuthorKind;
  sourceKind?: string;
  reviewState?: string;
  path?: string;
  /** Full comment body — only the worker triage carries it. */
  body?: string;
  /** Provider summary (first ~180 chars) — display only, never a fingerprint. */
  summaryExcerpt?: string;
  url?: string;
  reviewedCommit?: string;
  observedHead?: string;
  providerRevision?: string;
  /** Completion time of the run whose triage supplied `body`. */
  bodyObservedAt?: string;
  /** Time of the provider observation that supplied `providerRevision`. */
  providerObservedAt?: string;
  resolution: FeedbackCandidate['resolution'];
  runIds: Set<string>;
  sources: Set<FeedbackCandidate['sources'][number]>;
}

/**
 * A triage body is a usable fingerprint only when it demonstrably matches the
 * comment as the provider last saw it: the triage was captured after that
 * observation, or the whole body fits inside the provider summary and equals it.
 */
function bodyIsCurrent(draft: Draft): boolean {
  if (draft.body === undefined) return false;
  if (!draft.providerObservedAt) return true;
  if (draft.bodyObservedAt && draft.bodyObservedAt >= draft.providerObservedAt) return true;
  const trimmed = draft.body.trim();
  return trimmed.length <= 180 && draft.summaryExcerpt === trimmed;
}

function triageIdentity(entry: CommentsTriageEntry): {
  kind: FeedbackCandidate['kind'];
  providerId: string;
} | null {
  const commentId = entry.comment_id;
  if (commentId !== undefined && commentId !== null && `${commentId}`.trim()) {
    return { kind: 'review-comment', providerId: `${commentId}`.trim() };
  }
  const reviewId = entry.review_id;
  if (reviewId !== undefined && reviewId !== null && `${reviewId}`.trim()) {
    return { kind: 'review', providerId: `${reviewId}`.trim() };
  }
  return null;
}

interface ObservedIncident {
  identity: { kind: FeedbackCandidate['kind']; providerId: string };
  incident: PRMonitorIncident;
  monitor: FeedbackCandidateInput['monitors'][number];
}

/**
 * The monitor keeps every observed revision of a comment as its own incident
 * (identity includes the revision), and several subscriptions may watch one
 * PR. Only the most recently observed incident across all of them describes
 * the comment as it is now; earlier ones are provenance.
 */
function latestIncidentsByIdentity(
  monitors: FeedbackCandidateInput['monitors'],
): ObservedIncident[] {
  const latest = new Map<string, ObservedIncident>();
  for (const monitor of monitors) {
    for (const incident of monitor.incidents as PRMonitorIncident[]) {
      const signal = incident.signal;
      if (signal.kind !== 'feedback' && signal.kind !== 'review') continue;
      const identity = feedbackIdentityFromUrl(signal.url) ?? {
        kind: signal.kind === 'review' ? ('review' as const) : ('review-comment' as const),
        providerId: `node-${signal.key}`,
      };
      const key = `${identity.kind}:${identity.providerId}`;
      const current = latest.get(key);
      if (!current || current.incident.lastObservedAt <= incident.lastObservedAt) {
        latest.set(key, { identity, incident, monitor });
      }
    }
  }
  return [...latest.values()];
}

/** Ledger annotation, pure: consumption links plus the revised-since-consumed flag. */
export function annotateFeedbackConsumption(
  candidates: FeedbackCandidate[],
  ledger: FeedbackLedger,
): FeedbackCandidate[] {
  const consumptions = consumptionsBySourceKey(ledger);
  return candidates.map((candidate) => {
    const consumed = consumptions.get(candidate.sourceKey) ?? [];
    const { consumedBy: _consumedBy, revisedSinceConsumed: _revised, ...base } = candidate;
    if (consumed.length === 0) return base;
    const consumedBy: FeedbackConsumption[] = consumed.map((entry) => ({
      destination: entry.destination,
      rule: entry.rule,
      revision: entry.revision,
      recordedAt: entry.recordedAt,
      ...(entry.decisionId ? { decisionId: entry.decisionId } : {}),
      ...(entry.commit ? { commit: entry.commit } : {}),
      ...(entry.bodyRevision ? { bodyRevision: entry.bodyRevision } : {}),
    }));
    // A consumption matches when it recorded this provider revision, or the
    // same current full body (`bodyRevision` is only set when the body is
    // known to match the comment as the provider last saw it — see
    // bodyIsCurrent). A stale triage copy therefore cannot mask an edit, and a
    // provider fingerprint appearing after a triage-only consumption does not
    // re-open unchanged feedback.
    const revisedSinceConsumed = consumedBy.every(
      (entry) =>
        entry.revision !== candidate.revision &&
        (candidate.bodyRevision === undefined || entry.bodyRevision !== candidate.bodyRevision),
    );
    return { ...base, consumedBy, ...(revisedSinceConsumed ? { revisedSinceConsumed: true } : {}) };
  });
}

/** Pure: builds the deduplicated candidate list from already-loaded evidence. */
export function buildFeedbackCandidates(input: FeedbackCandidateInput): FeedbackCandidate[] {
  const { target } = input;
  const drafts = new Map<string, Draft>();
  const attribution = attributionFor(input.familyRuns);
  const familyId = input.familyRuns[0]?.familyId ?? input.familyRuns[0]?.id;

  const upsert = (
    identity: { kind: FeedbackCandidate['kind']; providerId: string },
    init: Omit<Draft, 'sourceKey' | 'kind' | 'runIds' | 'sources'> & {
      runIds: Iterable<string>;
      source: FeedbackCandidate['sources'][number];
    },
  ): void => {
    const sourceKey = feedbackSourceKey(target, identity.kind, identity.providerId);
    const existing = drafts.get(sourceKey);
    if (!existing) {
      const { runIds, source, ...fields } = init;
      drafts.set(sourceKey, {
        ...fields,
        sourceKey,
        kind: identity.kind,
        runIds: new Set(runIds),
        sources: new Set([source]),
      });
      return;
    }
    const fromProvider = init.source === 'pr-monitor';
    existing.authorLogin ??= init.authorLogin;
    if (existing.authorKind === 'unknown') existing.authorKind = init.authorKind;
    existing.sourceKind ??= init.sourceKind;
    existing.reviewState ??= init.reviewState;
    existing.path ??= init.path;
    // Triage rows arrive oldest run first, so a later follow-up's copy of the
    // comment (possibly edited) replaces the root's; the provider still wins.
    if (fromProvider) {
      existing.body ??= init.body;
      existing.providerObservedAt = init.providerObservedAt ?? existing.providerObservedAt;
    } else if (init.body !== undefined) {
      existing.body = init.body;
      existing.bodyObservedAt = init.bodyObservedAt;
    }
    existing.url ??= init.url;
    existing.observedHead ??= init.observedHead;
    // Revision-dependent facts come from the provider's latest observation.
    if (fromProvider) {
      existing.summaryExcerpt = init.summaryExcerpt ?? existing.summaryExcerpt;
      existing.providerRevision = init.providerRevision ?? existing.providerRevision;
      existing.reviewedCommit = init.reviewedCommit ?? existing.reviewedCommit;
    } else {
      existing.summaryExcerpt ??= init.summaryExcerpt;
      existing.providerRevision ??= init.providerRevision;
      existing.reviewedCommit ??= init.reviewedCommit;
    }
    // Between triage rows the newest run's verdict stands: a later follow-up
    // that reopened an edited comment (fixed_in_commit null) is not still
    // "fixed" because an earlier round once was. Against the provider, a
    // confirmed fix outranks a resolved thread, which outranks open/unknown; on
    // equal rank the triage's richer fields (triage, fixedInCommit) win.
    const existingRank = RESOLUTION_RANK[existing.resolution.state];
    const initRank = RESOLUTION_RANK[init.resolution.state];
    if (!fromProvider && !existing.sources.has('pr-monitor')) {
      existing.resolution = init.resolution;
    } else if (initRank > existingRank) {
      existing.resolution = { ...existing.resolution, ...init.resolution };
    } else if (initRank === existingRank) {
      existing.resolution = fromProvider
        ? { ...init.resolution, ...existing.resolution }
        : { ...existing.resolution, ...init.resolution };
    } else {
      existing.resolution = { ...init.resolution, ...existing.resolution };
    }
    for (const runId of init.runIds) existing.runIds.add(runId);
    existing.sources.add(init.source);
  };

  const runOrder = new Map(
    [...input.familyRuns]
      .sort((a, b) =>
        (a.completedAt ?? a.updatedAt ?? '').localeCompare(b.completedAt ?? b.updatedAt ?? ''),
      )
      .map((run, index) => [run.id, index] as const),
  );
  const runCompletedAt = new Map(
    input.familyRuns.map((run) => [run.id, run.completedAt ?? run.updatedAt] as const),
  );
  const orderedTriage = [...input.triage].sort(
    (a, b) =>
      (runOrder.get(a.runId) ?? Number.MAX_SAFE_INTEGER) -
      (runOrder.get(b.runId) ?? Number.MAX_SAFE_INTEGER),
  );
  for (const { runId, entries } of orderedTriage) {
    for (const entry of entries) {
      const identity = triageIdentity(entry);
      if (!identity) continue;
      const fixed = typeof entry.fixed_in_commit === 'string' && entry.fixed_in_commit.trim();
      upsert(identity, {
        authorLogin: entry.author_login ?? entry.reviewer_login ?? entry.author,
        authorKind: normalizeCommentSource(entry),
        sourceKind: entry.source_kind ?? entry.source,
        reviewState: entry.review_state,
        path: entry.path,
        body: typeof entry.body === 'string' ? entry.body : undefined,
        resolution: {
          state: fixed ? 'fixed' : 'open',
          ...(entry.triage ? { triage: entry.triage } : {}),
          ...(fixed ? { fixedInCommit: entry.fixed_in_commit!.trim() } : {}),
        },
        bodyObservedAt: runCompletedAt.get(runId),
        runIds: [runId],
        source: 'comments-triage',
      });
    }
  }

  const targetKey = monitoredPRKey({
    host: target.host,
    repo: target.repository,
    number: target.prNumber,
  });
  const matchingMonitors = input.monitors.filter(
    (monitor) => monitoredPRKey(monitor.config.pr) === targetKey,
  );
  {
    for (const { identity, incident, monitor } of latestIncidentsByIdentity(matchingMonitors)) {
      const observedHead = monitor.observation?.headSha;
      const signal = incident.signal;
      const login = signal.summary.split(':')[0]?.split(' ')[0]?.trim();
      const summary =
        signal.kind === 'feedback'
          ? signal.summary.slice(signal.summary.indexOf(':') + 1).trim()
          : undefined;
      upsert(identity, {
        authorLogin: login || undefined,
        // The observer already drops Bot-typed comment authors and the PR author's own comments.
        authorKind: signal.kind === 'feedback' ? 'human' : reviewAuthorKind(signal),
        reviewState: signal.kind === 'review' ? 'CHANGES_REQUESTED' : undefined,
        summaryExcerpt: summary || undefined,
        url: signal.url,
        reviewedCommit: signal.reviewedCommit,
        observedHead,
        providerRevision: signal.revision,
        resolution: {
          state: incident.handledAt ? 'fixed' : incident.resolvedAt ? 'resolved' : 'open',
        },
        providerObservedAt: incident.lastObservedAt,
        runIds: [...(monitor.originatingRunIds ?? []), ...(incident.runId ? [incident.runId] : [])],
        source: 'pr-monitor',
      });
    }
  }

  const candidates: FeedbackCandidate[] = [];
  for (const draft of drafts.values()) {
    // Only a full body is a fingerprint; the provider summary is truncated.
    const bodyRevision = bodyIsCurrent(draft) ? sha256(collapse(draft.body!)) : undefined;
    const revision = draft.providerRevision ?? bodyRevision ?? sha256(draft.sourceKey);
    // The provider summary is current (truncated); a triage body may predate an edit.
    const excerpt = draft.providerRevision ? (draft.summaryExcerpt ?? draft.body) : draft.body;
    candidates.push({
      id: sha256(draft.sourceKey),
      sourceKey: draft.sourceKey,
      provider: 'github',
      repository: target.repository,
      prNumber: target.prNumber,
      kind: draft.kind,
      revision,
      ...(bodyRevision ? { bodyRevision } : {}),
      ...(draft.authorLogin ? { authorLogin: draft.authorLogin } : {}),
      authorKind: draft.authorKind,
      ...(draft.sourceKind ? { sourceKind: draft.sourceKind } : {}),
      ...(draft.reviewState ? { reviewState: draft.reviewState } : {}),
      ...(draft.path ? { path: draft.path } : {}),
      ...(excerpt ? { excerpt: collapse(excerpt).slice(0, EXCERPT_MAX) } : {}),
      ...(draft.url ? { url: draft.url } : {}),
      ...(draft.reviewedCommit ? { reviewedCommit: draft.reviewedCommit } : {}),
      ...(draft.observedHead ? { observedHead: draft.observedHead } : {}),
      resolution: draft.resolution,
      runIds: [...draft.runIds].sort(),
      ...(familyId ? { familyId } : {}),
      familyChangeRunIds: attribution.familyChangeRunIds,
      attribution: { kind: attribution.kind, note: attribution.note },
      sources: [...draft.sources].sort() as FeedbackCandidate['sources'],
    });
  }

  // Annotate before bounding so the cap never hides feedback still awaiting
  // curation behind already-consumed entries.
  const annotated = annotateFeedbackConsumption(candidates, input.ledger);
  const authorRank = { human: 0, unknown: 1, bot: 2 } as const;
  const stateRank = { open: 0, unknown: 1, resolved: 2, fixed: 3 } as const;
  const curationRank = (candidate: FeedbackCandidate): number =>
    !candidate.consumedBy?.length || candidate.revisedSinceConsumed ? 0 : 1;
  annotated.sort(
    (a, b) =>
      authorRank[a.authorKind] - authorRank[b.authorKind] ||
      curationRank(a) - curationRank(b) ||
      stateRank[a.resolution.state] - stateRank[b.resolution.state] ||
      (a.path ?? '').localeCompare(b.path ?? '') ||
      a.sourceKey.localeCompare(b.sourceKey),
  );
  return annotated.slice(0, CANDIDATE_CAP);
}

export function summarizeFeedbackCandidates(
  candidates: FeedbackCandidate[],
): FeedbackCandidateSummary {
  return {
    total: candidates.length,
    human: candidates.filter((c) => c.authorKind === 'human').length,
    bot: candidates.filter((c) => c.authorKind === 'bot').length,
    unknown: candidates.filter((c) => c.authorKind === 'unknown').length,
    consumed: candidates.filter((c) => c.consumedBy?.length).length,
    open: candidates.filter((c) => c.resolution.state === 'open').length,
  };
}

/** Human feedback nobody has recorded a destination for yet — the curation queue. */
export function unconsumedHumanFeedback(candidates: FeedbackCandidate[]): FeedbackCandidate[] {
  return candidates.filter(
    (candidate) =>
      candidate.authorKind === 'human' &&
      (!candidate.consumedBy?.length || candidate.revisedSinceConsumed),
  );
}

/**
 * A persisted retrospective payload froze its consumption state at creation.
 * Re-annotate against the current ledger whenever a stored payload is read or
 * routed, so a rule landed afterwards shows as consumed and is not re-proposed.
 */
export async function refreshRetrospectiveFeedback(
  payload: RetrospectivePayload,
): Promise<RetrospectivePayload> {
  if (!payload.feedbackCandidates?.length) return payload;
  const candidates = annotateFeedbackConsumption(
    payload.feedbackCandidates,
    await readFeedbackLedger(),
  );
  return {
    ...payload,
    feedbackCandidates: candidates,
    feedbackSummary: summarizeFeedbackCandidates(candidates),
  };
}

type MonitorSource = () => FeedbackCandidateInput['monitors'];
let monitorSource: MonitorSource = () => [];
/** Wired at gateway startup once PR monitoring is initialised; tests inject fixtures. */
export function setFeedbackMonitorSource(source: MonitorSource | null): void {
  monitorSource = source ?? (() => []);
}

/**
 * IO wrapper: reads family triage artifacts, the PR monitor snapshot and the
 * ledger, then builds candidates. Returns null when the family has no PR.
 */
export async function collectFeedbackCandidates(
  run: Run,
  familyRuns: Run[],
  projectRepository: string | null,
): Promise<{ candidates: FeedbackCandidate[]; summary: FeedbackCandidateSummary } | null> {
  const family = familyRuns.some((candidate) => candidate.id === run.id)
    ? familyRuns
    : [run, ...familyRuns];
  const target = feedbackTargetForRun(run, family, projectRepository);
  if (!target) return null;
  const triage: FeedbackCandidateInput['triage'] = [];
  for (const member of family) {
    if (!member.taskFile) continue;
    const entries = await readCommentsTriageEntries(path.dirname(member.taskFile));
    if (entries?.length) triage.push({ runId: member.id, entries });
  }
  const candidates = buildFeedbackCandidates({
    target,
    familyRuns: family,
    triage,
    monitors: monitorSource(),
    ledger: await readFeedbackLedger(),
  });
  return { candidates, summary: summarizeFeedbackCandidates(candidates) };
}
