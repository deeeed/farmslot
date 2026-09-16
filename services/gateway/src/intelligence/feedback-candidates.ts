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
  type PRMonitor,
  type PRMonitorIncident,
  type PRMonitorSignal,
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

/** PR the run is bound to. `ticketOrPr` carries `owner/repo#n`; a bare PR number needs the project repo. */
export function feedbackTargetForRun(
  run: Run,
  familyRuns: Run[],
  projectRepository: string | null,
): FeedbackPRTarget | null {
  for (const candidate of [run, ...familyRuns]) {
    const ref = parseGitHubRef(candidate.ticketOrPr);
    if (ref) return { host: GITHUB_HOST, repository: ref.repo, prNumber: ref.number };
    if (candidate.prNumber && projectRepository)
      return { host: GITHUB_HOST, repository: projectRepository, prNumber: candidate.prNumber };
  }
  return null;
}

/** `git@github.com:Owner/Repo.git` or `https://github.com/Owner/Repo(.git)` → `Owner/Repo`. */
export function repositorySlugFromUrl(url: string | undefined | null): string | null {
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

interface Draft {
  sourceKey: string;
  kind: FeedbackCandidate['kind'];
  providerId: string;
  authorLogin?: string;
  authorKind: FeedbackAuthorKind;
  sourceKind?: string;
  reviewState?: string;
  path?: string;
  body?: string;
  url?: string;
  reviewedCommit?: string;
  observedHead?: string;
  providerRevision?: string;
  resolution: FeedbackCandidate['resolution'];
  runIds: Set<string>;
  sources: Set<FeedbackCandidate['sources'][number]>;
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

function mergeStrings(current: string | undefined, next: string | undefined): string | undefined {
  return current ?? next;
}

/** Pure: builds the deduplicated candidate list from already-loaded evidence. */
export function buildFeedbackCandidates(input: FeedbackCandidateInput): FeedbackCandidate[] {
  const { target } = input;
  const drafts = new Map<string, Draft>();
  const attribution = attributionFor(input.familyRuns);
  const familyId = input.familyRuns[0]?.familyId ?? input.familyRuns[0]?.id;

  const upsert = (
    identity: { kind: FeedbackCandidate['kind']; providerId: string },
    init: Omit<Draft, 'sourceKey' | 'kind' | 'providerId' | 'runIds' | 'sources'> & {
      runIds: Iterable<string>;
      source: FeedbackCandidate['sources'][number];
    },
  ): Draft => {
    const sourceKey = feedbackSourceKey(target, identity.kind, identity.providerId);
    const existing = drafts.get(sourceKey);
    if (!existing) {
      const draft: Draft = {
        sourceKey,
        kind: identity.kind,
        providerId: identity.providerId,
        authorLogin: init.authorLogin,
        authorKind: init.authorKind,
        sourceKind: init.sourceKind,
        reviewState: init.reviewState,
        path: init.path,
        body: init.body,
        url: init.url,
        reviewedCommit: init.reviewedCommit,
        observedHead: init.observedHead,
        providerRevision: init.providerRevision,
        resolution: init.resolution,
        runIds: new Set(init.runIds),
        sources: new Set([init.source]),
      };
      drafts.set(sourceKey, draft);
      return draft;
    }
    existing.authorLogin = mergeStrings(existing.authorLogin, init.authorLogin);
    if (existing.authorKind === 'unknown') existing.authorKind = init.authorKind;
    existing.sourceKind = mergeStrings(existing.sourceKind, init.sourceKind);
    existing.reviewState = mergeStrings(existing.reviewState, init.reviewState);
    existing.path = mergeStrings(existing.path, init.path);
    existing.body = mergeStrings(existing.body, init.body);
    existing.url = mergeStrings(existing.url, init.url);
    existing.reviewedCommit = mergeStrings(existing.reviewedCommit, init.reviewedCommit);
    existing.observedHead = mergeStrings(existing.observedHead, init.observedHead);
    existing.providerRevision = mergeStrings(existing.providerRevision, init.providerRevision);
    // A confirmed fix outranks an open/unknown state; a provider resolution outranks unknown.
    const rank = { fixed: 3, resolved: 2, open: 1, unknown: 0 } as const;
    if (rank[init.resolution.state] > rank[existing.resolution.state]) {
      existing.resolution = { ...existing.resolution, ...init.resolution };
    } else {
      existing.resolution = { ...init.resolution, ...existing.resolution };
    }
    for (const runId of init.runIds) existing.runIds.add(runId);
    existing.sources.add(init.source);
    return existing;
  };

  for (const { runId, entries } of input.triage) {
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
  for (const monitor of input.monitors) {
    if (monitoredPRKey(monitor.config.pr) !== targetKey) continue;
    const observedHead = monitor.observation?.headSha;
    for (const incident of monitor.incidents as PRMonitorIncident[]) {
      const signal = incident.signal;
      if (signal.kind !== 'feedback' && signal.kind !== 'review') continue;
      const identity = feedbackIdentityFromUrl(signal.url) ?? {
        kind: signal.kind === 'review' ? ('review' as const) : ('review-comment' as const),
        providerId: `node-${signal.key}`,
      };
      const login = signal.summary.split(':')[0]?.split(' ')[0]?.trim();
      const body =
        signal.kind === 'feedback'
          ? signal.summary.slice(signal.summary.indexOf(':') + 1)
          : undefined;
      upsert(identity, {
        authorLogin: login || undefined,
        // The observer already drops Bot-typed comment authors and the PR author's own comments.
        authorKind: signal.kind === 'feedback' ? 'human' : reviewAuthorKind(signal),
        reviewState: signal.kind === 'review' ? 'CHANGES_REQUESTED' : undefined,
        body: body?.trim() || undefined,
        url: signal.url,
        reviewedCommit: signal.reviewedCommit,
        observedHead,
        providerRevision: signal.revision,
        resolution: {
          state: incident.handledAt ? 'fixed' : incident.resolvedAt ? 'resolved' : 'open',
        },
        runIds: [...(monitor.originatingRunIds ?? []), ...(incident.runId ? [incident.runId] : [])],
        source: 'pr-monitor',
      });
    }
  }

  const consumptions = consumptionsBySourceKey(input.ledger);
  const candidates: FeedbackCandidate[] = [];
  for (const draft of drafts.values()) {
    const bodyRevision = draft.body !== undefined ? sha256(collapse(draft.body)) : undefined;
    const revision = draft.providerRevision ?? bodyRevision ?? sha256(draft.sourceKey);
    const consumed = consumptions.get(draft.sourceKey) ?? [];
    const consumedBy: FeedbackConsumption[] = consumed.map((entry) => ({
      destination: entry.destination,
      rule: entry.rule,
      revision: entry.revision,
      recordedAt: entry.recordedAt,
      ...(entry.decisionId ? { decisionId: entry.decisionId } : {}),
      ...(entry.commit ? { commit: entry.commit } : {}),
      ...(entry.bodyRevision ? { bodyRevision: entry.bodyRevision } : {}),
    }));
    const revisedSinceConsumed =
      consumedBy.length > 0 &&
      consumedBy.every(
        (entry) =>
          entry.revision !== revision &&
          (bodyRevision === undefined || entry.bodyRevision !== bodyRevision),
      );
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
      ...(draft.body ? { excerpt: collapse(draft.body).slice(0, EXCERPT_MAX) } : {}),
      ...(draft.url ? { url: draft.url } : {}),
      ...(draft.reviewedCommit ? { reviewedCommit: draft.reviewedCommit } : {}),
      ...(draft.observedHead ? { observedHead: draft.observedHead } : {}),
      resolution: draft.resolution,
      runIds: [...draft.runIds].sort(),
      ...(familyId ? { familyId } : {}),
      familyChangeRunIds: attribution.familyChangeRunIds,
      attribution: { kind: attribution.kind, note: attribution.note },
      sources: [...draft.sources].sort() as FeedbackCandidate['sources'],
      ...(consumedBy.length ? { consumedBy } : {}),
      ...(revisedSinceConsumed ? { revisedSinceConsumed: true } : {}),
    });
  }

  const authorRank = { human: 0, unknown: 1, bot: 2 } as const;
  const stateRank = { open: 0, unknown: 1, resolved: 2, fixed: 3 } as const;
  candidates.sort(
    (a, b) =>
      authorRank[a.authorKind] - authorRank[b.authorKind] ||
      stateRank[a.resolution.state] - stateRank[b.resolution.state] ||
      (a.path ?? '').localeCompare(b.path ?? '') ||
      a.sourceKey.localeCompare(b.sourceKey),
  );
  return candidates.slice(0, CANDIDATE_CAP);
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
