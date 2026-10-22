import {
  type AgentContext,
  deriveChecklistStepDurations,
  digestRecipeDocument,
  extractRunArtifactManifest,
  type FsReadParams,
  type GitDiffParams,
  isTerminalRunStatus,
  observedReviewSessionContinuity,
  type ReviewAttempt,
  type ReviewChainEntry,
  reviewChainForRun,
  type ReviewMode,
  reviewResultForRun,
  type ReviewStatus,
  type Run,
  type RunnerSessionUsage,
} from '@farmslot/protocol';

import { reviewHistoryTimeline } from './review-history-timeline.js';
import { runActivityView, runReviewActivityContext } from './run-activity.js';
import { reviewAttemptFailureReason } from './run-review-failures.js';

export interface ReviewHistoryFinding {
  id: string;
  title: string;
  details: string;
  severity: string;
  file: string;
  line: number | null;
  status: 'new' | 'still-open' | 'resolved';
  statusLabel: string;
  resolvedBy: string | null;
}
export interface ReviewHistoryArtifact {
  content?: string;
  error?: string;
}
export type ReviewHistoryArtifacts = Readonly<Record<string, ReviewHistoryArtifact>>;

export interface ReviewHistoryCacheAuthority {
  gatewayUrl: string;
  profileId?: string | null;
  principalId: string | null;
}

/** Transport generations invalidate requests, not facts already read from the same owner. */
export function reviewHistoryCacheScope(runId: string, authority: ReviewHistoryCacheAuthority) {
  return JSON.stringify([
    authority.gatewayUrl,
    authority.profileId ?? null,
    authority.principalId,
    runId,
  ]);
}

function reviewUsageLabel(usage: RunnerSessionUsage | undefined): string | null {
  if (!usage) return null;
  if (usage.source === 'unavailable') return 'Usage unavailable';
  const parts = [
    usage.turns != null ? `${usage.turns} turns` : null,
    usage.totalTokens != null ? `${usage.totalTokens.toLocaleString()} tokens` : null,
    usage.costUsd != null ? `$${usage.costUsd.toFixed(4)}` : null,
  ].filter(Boolean);
  return parts.length ? parts.join(' · ') : 'Usage measured';
}

/** Keep recorded history readable during a refresh outage, while exposing the failed read. */
export function mergeReviewHistoryArtifacts(
  previous: ReviewHistoryArtifacts,
  next: ReviewHistoryArtifacts,
): ReviewHistoryArtifacts {
  return {
    ...previous,
    ...Object.fromEntries(
      Object.entries(next).map(([path, value]) => [
        path,
        value.error && previous[path]?.content !== undefined
          ? { ...previous[path], error: value.error }
          : value,
      ]),
    ),
  };
}

export interface ReviewHistoryRound {
  key: string;
  reviewId: string;
  loopNumber: number;
  roundNumber: number;
  runner: string;
  model: string;
  mode: ReviewMode | null;
  modeLabel: string;
  verdict: string;
  verdictTone: 'ok' | 'warn' | 'fail' | 'running';
  failureReason?: string | null;
  startedAt: string | null;
  completedAt: string | null;
  durationMs: number | null;
  usageLabel: string | null;
  headSha: string | null;
  reviewBaseSha: string | null;
  resultRecorded: boolean;
  unresolvedCount: number | null;
  unresolvedLabel: string;
  findingsLabel: string;
  findings: ReviewHistoryFinding[];
  earlierAttempts: Array<{ status: string; startedAt: string | null; durationMs: number | null }>;
  reviewRange: string;
  fixRange: string | null;
  fixStat: string | null;
  fixDurationMs: number | null;
  fixStartedAt: string | null;
  fixCompletedAt: string | null;
  fixFiles: string[];
  fixRunning: boolean;
  activeFixStartedAt: string | null;
  hasFix: boolean;
  diffPath: string | null;
  diffText: string | null;
  diffReconstructed: boolean;
  reviewDiffRetained: boolean;
  fixDiffPath: string | null;
  fixDiffText: string | null;
  fixDiffError: string | null;
  fixBaseSha: string | null;
  fixHeadSha: string | null;
  fixReconstructed: boolean;
  validationDepth: string;
  timing: ReturnType<typeof deriveChecklistStepDurations>;
  unavailable: string[];
}

export interface ReviewHistoryCheck {
  id: string;
  runner: string;
  model: string;
  source: string;
  checkNumber: number;
  findingCount: number;
  verdict: string;
  unresolvedCount: number | null;
  stale: boolean;
  continuation: string | null;
  rounds: ReviewHistoryRound[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function record(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}
function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}
function number(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
function artifact(artifacts: ReviewHistoryArtifacts, path: string): Record<string, unknown> | null {
  const content = artifacts[path]?.content;
  if (!content) return null;
  try {
    return record(JSON.parse(content));
  } catch {
    // A partial/legacy artifact cannot supply facts; its round remains visible as not recorded.
    return null;
  }
}
function duration(start: string | null, end: string | null): number | null {
  if (!start || !end) return null;
  const ms = Date.parse(end) - Date.parse(start);
  return Number.isFinite(ms) && ms >= 0 ? ms : null;
}
function range(base: unknown, head: unknown): string | null {
  const left = text(base),
    right = text(head);
  return left || right ? `${left?.slice(0, 7) ?? '?'} → ${right?.slice(0, 7) ?? '?'}` : null;
}
function fixStat(value: unknown): string | null {
  const delta = record(value),
    diff = record(delta?.diffStat);
  if (!diff) return null;
  const files = number(diff.files);
  const untracked = Array.isArray(delta?.untrackedFiles) ? delta.untrackedFiles.length : 0;
  const paths =
    untracked && files !== null
      ? `${Math.max(0, files - untracked)} tracked + ${untracked} untracked`
      : `${files ?? '?'} file${files === 1 ? '' : 's'}`;
  return `${paths} · +${number(diff.additions) ?? '?'} −${number(diff.deletions) ?? '?'}`;
}

function findings(value: unknown): ReviewHistoryFinding[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const issue = record(entry);
    const description = text(issue?.description) ?? text(issue?.body);
    if (!issue || !description) return [];
    const priority = /^\[(P[0-3])\]\s*/.exec(description);
    const body = priority ? description.slice(priority[0].length) : description;
    const firstLine = body.split('\n')[0];
    const title = text(issue.title) ?? firstLine.match(/^.*?[.!?](?=\s|$)/)?.[0] ?? firstLine;
    return [
      {
        id: text(issue.id) ?? digestRecipeDocument({ file: issue.file ?? issue.path, title }),
        title,
        details: body.startsWith(title) ? body.slice(title.length).trim() : body,
        severity: text(issue.severity) ?? priority?.[1] ?? 'Severity not recorded',
        file: text(issue.file) ?? text(issue.path) ?? 'General finding',
        line: number(issue.line),
        status: 'new' as const,
        statusLabel: 'New',
        resolvedBy: null,
      },
    ];
  });
}

/** Shared with snapshot capture: clients must request the artifact the engine actually wrote. */
export function reviewArtifactDir(loopNumber: number, artifactScope?: string | null): string {
  const scope = artifactScope?.trim().replace(/^\/+|\/+$/g, '');
  if (!scope) return `artifacts/pipeline-review-loop-${loopNumber}`;
  if (scope.includes('..')) throw new Error(`Invalid review artifact scope: ${artifactScope}`);
  return `artifacts/${scope}/review-loop-${loopNumber}`;
}

export function reviewHistoryArtifactPaths(run: Run): string[] {
  return [
    ...new Set(
      (run.agentContexts ?? [])
        .filter((context) => context.role === 'review')
        .flatMap(reviewHistoryArtifactPathsForActor),
    ),
  ];
}

function recoveredSnapshotKey(actor: AgentContext): string {
  return `history:${actor.id}:${actor.reviewLoopNumber ?? 0}:${actor.deliveryBaselineRef ?? actor.pipelineVisualReviewInput?.headSha ?? ''}:snapshot`;
}

function readyReviews(run: Run): ReviewStatus[] {
  const live = run.engineState?.publishGate?.reviews;
  if (live?.length) return live;
  for (const decision of [...run.decisions].reverse())
    if (decision.payload?.kind === 'ready') return decision.payload.reviews ?? [];
  return [];
}

export function reviewHistoryView(
  run: Run,
  artifacts: ReviewHistoryArtifacts = {},
  chain: ReviewChainEntry[] = reviewChainForRun(run),
) {
  const result = reviewResultForRun(run);
  const staticActors = new Set(
    (run.agentContexts ?? [])
      .filter(
        (context) =>
          context.role === 'review' && !context.reviewLoopNumber && run.flowType === 'review-pr',
      )
      .map((context) => context.id),
  );
  const contexts = (run.agentContexts ?? [])
    .filter((context) => context.role === 'review')
    .flatMap((context) =>
      staticActors.has(context.id)
        ? [
            {
              ...context,
              reviewId: context.reviewId ?? `workspace-review-${run.id}`,
              reviewLoopNumber: 1,
            },
          ]
        : context.reviewId && context.reviewLoopNumber
          ? [context]
          : [],
    );
  const reviews = readyReviews(run);
  const useGit = artifacts['history:git']?.content === 'enabled';
  const retainedPaths = new Set(extractRunArtifactManifest(run).map((entry) => entry.path));
  const currentActor =
    runActivityView(run)?.kind === 'worker-fix' ? runReviewActivityContext(run) : null;
  const fixingActor = currentActor?.role === 'review-fix' ? currentActor : null;
  const latestReviewActor = [...contexts]
    .sort((left, right) =>
      (left.attemptStartedAt ?? left.startedAt ?? '').localeCompare(
        right.attemptStartedAt ?? right.startedAt ?? '',
      ),
    )
    .at(-1);
  const steps = run.steps.filter(
    (step) => step.name.includes('review') && Array.isArray(step.outputs?.attempts),
  );
  const stepId = (step: Run['steps'][number]) =>
    text(step.outputs?.reviewId) ?? `pipeline-review-${run.id}`;
  const segments = run.steps
    .filter((step) => step.name.includes('review'))
    .flatMap((step) =>
      Array.isArray(step.outputs?.timeline)
        ? step.outputs.timeline.map(record).filter(isRecord)
        : [],
    );
  const checks: ReviewHistoryCheck[] = [];
  const ids = [
    ...new Set([
      ...reviews.map((review) => review.id),
      ...contexts.map((context) => context.reviewId!),
      ...steps.map(stepId),
    ]),
  ];
  for (const id of ids) {
    const review = reviews.find((entry) => entry.id === id);
    const actors = contexts.filter((context) => context.reviewId === id);
    const step = steps.find((entry) => stepId(entry) === id);
    const stepAttempts = Array.isArray(step?.outputs?.attempts)
      ? step.outputs.attempts.map(record).filter(isRecord)
      : [];
    const attempts: ReviewAttempt[] = review
      ? review.attempts?.length
        ? review.attempts
        : [review]
      : [];
    const loops = [
      ...new Set([
        ...attempts.map((attempt) => attempt.loopNumber),
        ...actors.map((context) => context.reviewLoopNumber!),
        ...stepAttempts.map((entry, index) => number(entry.loopNumber) ?? index + 1),
      ]),
    ].sort((a, b) => a - b);
    // Replays can restart the loop counter. A context is an attempt, not another copy of loop 1.
    const sources = loops
      .flatMap<{ loop: number; actor: AgentContext | undefined }>((loop) => {
        const matching = actors.filter((context) => context.reviewLoopNumber === loop);
        return matching.length
          ? matching.map((actor) => ({ loop, actor }))
          : [{ loop, actor: undefined }];
      })
      .sort(
        (left, right) =>
          (left.actor?.startedAt ?? '').localeCompare(right.actor?.startedAt ?? '') ||
          left.loop - right.loop,
      );
    let roundNumber = 0;
    const rounds = sources.map(({ loop, actor }): ReviewHistoryRound => {
      roundNumber = Math.max(roundNumber + 1, loop);
      const sameLoop = actors.filter((context) => context.reviewLoopNumber === loop);
      const ownsAttempt = (
        entry: { startedAt?: string; completedAt?: string; verdict?: string; headSha?: string },
        entryLoop: number,
      ) => {
        if (!actor) return entryLoop === loop;
        if (actor.status === 'failed' && entry.verdict !== 'failed') return false;
        if (entry.startedAt && actor.completedAt && entry.startedAt > actor.completedAt)
          return false;
        if (entry.completedAt && actor.startedAt && entry.completedAt < actor.startedAt)
          return false;
        if (
          entry.headSha &&
          actor.deliveryBaselineRef &&
          entry.headSha !== actor.deliveryBaselineRef
        )
          return false;
        const sameHead = entry.headSha && entry.headSha === actor.deliveryBaselineRef;
        if (entryLoop !== loop && !sameHead) return false;
        return (
          sameLoop.length === 1 ||
          (entry.startedAt
            ? entry.startedAt >= (actor.startedAt ?? '') &&
              (!actor.completedAt || entry.startedAt <= actor.completedAt)
            : sameLoop.at(-1)?.id === actor.id)
        );
      };
      const recordedAttempt = attempts
        .filter((entry) =>
          ownsAttempt(
            { ...entry, headSha: entry.reviewSnapshot?.headSha ?? undefined },
            entry.loopNumber,
          ),
        )
        .at(-1);
      const recordedRaw = stepAttempts
        .filter((entry, index) =>
          ownsAttempt(
            {
              startedAt: text(entry.startedAt) ?? undefined,
              completedAt: text(entry.completedAt) ?? undefined,
              verdict: text(entry.verdict) ?? undefined,
              headSha: text(record(entry.reviewSnapshot)?.headSha) ?? undefined,
            },
            number(entry.loopNumber) ?? index + 1,
          ),
        )
        .at(-1);
      const newerActive =
        actor &&
        ['working', 'launching', 'waiting'].includes(actor.status) &&
        (!(recordedAttempt?.completedAt ?? text(recordedRaw?.completedAt)) ||
          Date.parse(actor.attemptStartedAt ?? actor.startedAt ?? '') >=
            Date.parse(recordedAttempt?.completedAt ?? text(recordedRaw?.completedAt) ?? ''));
      const attempt = newerActive ? undefined : recordedAttempt;
      const raw = newerActive ? undefined : recordedRaw;
      const dir = reviewArtifactDir(loop, actor?.artifactScope);
      const saved =
        actor?.reviewResultFile && (!newerActive || actor.reviewResultValidatedAt)
          ? artifact(artifacts, actor.reviewResultFile)
          : null;
      const staticResult = actor && staticActors.has(actor.id) ? result : null;
      const storedSnapshot =
        attempt?.reviewSnapshot ?? record(raw?.reviewSnapshot) ?? staticResult?.reviewSnapshot;
      const recordedSnapshot =
        storedSnapshot ?? artifact(artifacts, `${dir}/review-diff-stat.json`);
      const expectedHead = actor?.deliveryBaselineRef ?? actor?.pipelineVisualReviewInput?.headSha;
      const overwritten =
        !storedSnapshot &&
        actor?.completedAt &&
        text(recordedSnapshot?.capturedAt) &&
        String(recordedSnapshot?.capturedAt) > actor.completedAt;
      const snapshot =
        (overwritten || (expectedHead && recordedSnapshot?.headSha !== expectedHead)
          ? null
          : recordedSnapshot) ?? (actor ? artifact(artifacts, recoveredSnapshotKey(actor)) : null);
      const storedFix = attempt?.fixDelta ?? record(raw?.fixDelta);
      const candidateFix = storedFix ?? artifact(artifacts, `${dir}/fix-delta-stat.json`);
      const fix =
        (!storedFix &&
          actor?.completedAt &&
          text(candidateFix?.capturedAt) &&
          String(candidateFix?.capturedAt) > actor.completedAt) ||
        (expectedHead &&
          candidateFix &&
          (candidateFix.fixHeadSha ?? candidateFix.headSha) !== expectedHead)
          ? null
          : candidateFix;
      const issueValue =
        attempt?.issues ?? raw?.issues ?? saved?.issues ?? staticResult?.lineComments;
      const issueRows = findings(issueValue);
      const startedAt =
        attempt?.startedAt ??
        text(raw?.startedAt) ??
        actor?.startedAt ??
        actor?.attemptStartedAt ??
        null;
      const completedAt =
        attempt?.completedAt ??
        text(raw?.completedAt) ??
        actor?.completedAt ??
        (staticResult ? run.steps.find((entry) => entry.name === 'monitor')?.completedAt : null) ??
        null;
      const previousCompletedAt = actors
        .filter(
          (candidate) =>
            candidate.id !== actor?.id &&
            candidate.completedAt &&
            startedAt &&
            candidate.completedAt <= startedAt,
        )
        .map((candidate) => candidate.completedAt)
        .filter((value): value is string => Boolean(value))
        .sort()
        .at(-1);
      const previousActor = actors
        .filter(
          (candidate) =>
            candidate.id !== actor?.id &&
            candidate.completedAt &&
            startedAt &&
            candidate.completedAt <= startedAt,
        )
        .sort((left, right) => (left.completedAt ?? '').localeCompare(right.completedAt ?? ''))
        .at(-1);
      const previousHead =
        previousActor?.deliveryBaselineRef ?? previousActor?.pipelineVisualReviewInput?.headSha;
      const headSha = text(snapshot?.headSha) ?? expectedHead ?? null;
      const reconstructedFix = !fix && previousHead && headSha && previousHead !== headSha;
      const fixBaseSha =
        text(fix?.fixBaseSha ?? fix?.baseSha) ?? (reconstructedFix ? previousHead : null);
      const fixHeadSha =
        text(fix?.fixHeadSha ?? fix?.headSha) ?? (reconstructedFix ? headSha : null);
      const fixDiffPath =
        useGit && fixBaseSha && fixHeadSha
          ? `history:git:${fixBaseSha}:${fixHeadSha}.diff`
          : (text(fix?.diffPath) ??
            (reconstructedFix && actor ? `history:${actor.id}:fix.diff` : null));
      const reviewBaseSha = text(snapshot?.baseSha);
      const diffPath =
        useGit && reviewBaseSha && headSha
          ? `history:git:${reviewBaseSha}:${headSha}.diff`
          : text(snapshot?.diffPath);
      const completedFix =
        previousCompletedAt && startedAt
          ? (run.agentContexts ?? [])
              .filter(
                (candidate) =>
                  candidate.role === 'review-fix' &&
                  (candidate.completedAt ?? text(fix?.capturedAt)) &&
                  (candidate.promptDeliveryStartedAt ?? candidate.startedAt ?? '') >
                    previousCompletedAt &&
                  (candidate.completedAt ?? text(fix?.capturedAt) ?? '') <= startedAt,
              )
              .sort((left, right) =>
                (left.completedAt ?? '').localeCompare(right.completedAt ?? ''),
              )
              .at(-1)
          : undefined;
      const firstFix =
        previousCompletedAt && startedAt
          ? run.agentContexts?.find(
              (candidate) =>
                candidate.role === 'review-fix' &&
                candidate.startedAt &&
                candidate.startedAt > previousCompletedAt &&
                candidate.startedAt <= startedAt,
            )
          : undefined;
      const segment = attempt?.timeline?.find((entry) => entry.kind === 'worker-fix');
      const rawSegment = (
        Array.isArray(raw?.timeline) ? raw.timeline.map(record).filter(isRecord) : segments
      ).find((entry) => entry.kind === 'worker-fix' && (number(entry.loopNumber) ?? loop) === loop);
      const fixing =
        fixingActor &&
        (fixingActor.artifactScope
          ? fixingActor.artifactScope === actor?.artifactScope || fixingActor.artifactScope === id
          : latestReviewActor?.reviewId === id)
          ? fixingActor
          : null;
      const initialMode =
        loop === 1 && id === `pipeline-review-${run.id}`
          ? record(run.steps.find((step) => step.name === 'review')?.inputs?.reviewSelection)?.mode
          : null;
      const mode =
        attempt?.mode ??
        text(raw?.mode) ??
        text(saved?.mode) ??
        staticResult?.session?.mode ??
        (actor?.reviewFallback
          ? 'cold'
          : actor?.nativeSession?.handoffFrom
            ? 'warm'
            : actor?.nativeSession
              ? 'cold'
              : null) ??
        (actor && staticActors.has(actor.id)
          ? (run.reviewMode ?? run.repeatReviewContext?.mode)
          : null) ??
        initialMode;
      const recorded = Array.isArray(issueValue);
      const verdict =
        attempt?.verdict ??
        text(raw?.verdict) ??
        staticResult?.recommendation ??
        (actor?.status === 'failed' ? 'failed' : text(saved?.verdict)) ??
        (actor?.status === 'complete' ? 'Result not recorded' : 'pending');
      const failureReason =
        verdict === 'failed'
          ? (attempt?.reason ??
            text(raw?.reason) ??
            (actor ? reviewAttemptFailureReason(run, actor) : null))
          : null;
      const unresolved =
        attempt?.unresolvedCount ??
        number(raw?.unresolvedCount) ??
        (recorded ? issueRows.length : null);
      return {
        key: actor?.id ?? `${id}:${loop}`,
        reviewId: id,
        loopNumber: loop,
        roundNumber,
        runner: actor?.runner ?? review?.runner ?? text(step?.outputs?.runner) ?? 'Unknown runner',
        model: actor?.model ?? review?.model ?? text(step?.outputs?.model) ?? 'default',
        mode: mode === 'warm' || mode === 'cold' ? mode : null,
        modeLabel: mode === 'warm' || mode === 'cold' ? mode.toUpperCase() : 'Mode unavailable',
        verdict,
        verdictTone: ['pass', 'APPROVE'].includes(verdict)
          ? 'ok'
          : verdict === 'failed'
            ? 'fail'
            : verdict === 'pending'
              ? 'running'
              : 'warn',
        failureReason,
        startedAt,
        completedAt,
        durationMs: duration(startedAt, completedAt),
        usageLabel: reviewUsageLabel(
          attempt?.usage ??
            (review &&
            ownsAttempt(
              { ...review, headSha: review.reviewSnapshot?.headSha ?? undefined },
              review.loopNumber,
            )
              ? review.usage
              : undefined),
        ),
        headSha,
        reviewBaseSha,
        resultRecorded: recorded,
        unresolvedCount: unresolved,
        unresolvedLabel:
          unresolved !== null
            ? `${unresolved} unresolved`
            : verdict === 'pending'
              ? 'Findings pending'
              : 'Finding count not recorded',
        findingsLabel: recorded
          ? issueRows.length
            ? `${issueRows.length} finding${issueRows.length === 1 ? '' : 's'} recorded.`
            : 'No findings recorded in this round.'
          : verdict === 'pending'
            ? 'Review is running. Findings appear when it finishes.'
            : verdict === 'failed'
              ? 'Review failed before producing findings.'
              : 'Findings unavailable',
        findings: issueRows,
        earlierAttempts: [],
        reviewRange:
          range(snapshot?.baseSha, snapshot?.headSha) ??
          actor?.deliveryBaselineRef?.slice(0, 7) ??
          'Head pending',
        fixRange: range(fixBaseSha, fixHeadSha),
        fixStat: fixStat(fix),
        fixDurationMs:
          segment?.durationMs ??
          number(rawSegment?.durationMs) ??
          duration(
            segment?.startedAt ?? text(rawSegment?.startedAt),
            segment?.completedAt ?? text(rawSegment?.completedAt),
          ) ??
          duration(
            completedFix?.promptDeliveryStartedAt ??
              completedFix?.startedAt ??
              completedFix?.attemptStartedAt ??
              null,
            completedFix?.completedAt ?? text(fix?.capturedAt),
          ),
        fixStartedAt:
          segment?.startedAt ??
          text(rawSegment?.startedAt) ??
          completedFix?.promptDeliveryStartedAt ??
          completedFix?.startedAt ??
          firstFix?.startedAt ??
          null,
        fixCompletedAt:
          segment?.completedAt ??
          text(rawSegment?.completedAt) ??
          completedFix?.completedAt ??
          text(fix?.capturedAt),
        fixFiles: [
          ...(artifacts[String(fixDiffPath)]?.content ?? '').matchAll(
            /^diff --git a\/.+ b\/(.+)$/gm,
          ),
        ].map((match) => match[1]),
        fixRunning: Boolean(actor?.id === latestReviewActor?.id && fixing),
        activeFixStartedAt:
          actor?.id === latestReviewActor?.id
            ? (fixing?.promptDeliveryStartedAt ??
              fixing?.attemptStartedAt ??
              fixing?.startedAt ??
              null)
            : null,
        hasFix: Boolean(fix || reconstructedFix || segment || rawSegment || completedFix),
        diffPath,
        diffReconstructed: useGit || record(snapshot)?.reconstructed === true,
        diffText: diffPath ? (artifacts[String(diffPath)]?.content ?? null) : null,
        reviewDiffRetained: retainedPaths.has(String(snapshot?.diffPath)),
        fixDiffPath,
        fixDiffText: fixDiffPath ? (artifacts[String(fixDiffPath)]?.content ?? null) : null,
        fixDiffError: fixDiffPath ? (artifacts[String(fixDiffPath)]?.error ?? null) : null,
        fixBaseSha,
        fixHeadSha,
        fixReconstructed: Boolean(reconstructedFix || (useGit && fixBaseSha && fixHeadSha)),
        validationDepth:
          attempt?.validationDepth ??
          text(raw?.validationDepth) ??
          review?.validationDepth ??
          'static-code',
        timing: deriveChecklistStepDurations(attempt?.checklistTiming, startedAt ?? undefined),
        unavailable: [
          ...reviewHistoryArtifactPathsForActor(actor),
          ...(actor ? [recoveredSnapshotKey(actor)] : []),
          ...(fixDiffPath ? [fixDiffPath] : []),
          ...(diffPath ? [diffPath] : []),
        ].flatMap((path) => (artifacts[path]?.error ? [artifacts[path].error!] : [])),
      };
    });
    if (!rounds.length) continue;
    const latest = rounds.at(-1)!;
    const reviewerActive = actors.some((context) =>
      ['launching', 'working', 'waiting'].includes(context.status),
    );
    const pendingContinuation =
      review?.recoveryContinuationPending === true && (latest.unresolvedCount ?? 0) > 0;
    const continuation = pendingContinuation
      ? reviewerActive
        ? 'The worker fix is complete; the next review round is running.'
        : latest.fixRunning
          ? `Worker is fixing the latest ${latest.unresolvedCount} findings.`
          : `Stopped after the retry limit: the latest ${latest.unresolvedCount} findings still need delivery to the worker.`
      : latest.fixRunning
        ? 'Worker is fixing the latest findings.'
        : null;
    checks.push({
      id,
      checkNumber: checks.length + 1,
      findingCount: rounds.reduce((sum, round) => sum + round.findings.length, 0),
      runner: review?.runner ?? latest.runner,
      model: review?.model ?? latest.model,
      source: review?.source === 'human-gate' ? 'Requested review' : 'Review',
      verdict: latest.verdict,
      unresolvedCount: latest.unresolvedCount,
      stale: review?.stale === true,
      continuation,
      rounds,
    });
  }
  const roundCount = checks.reduce((sum, check) => sum + check.rounds.length, 0);
  const replayStep = run.steps.find((step) => step.name === 'review' && step.status === 'running');
  const activeReplay =
    run.status === 'reviewing' &&
    (run.engineState?.generation ?? 0) > 0 &&
    replayStep?.startedAt &&
    latestReviewActor?.completedAt &&
    replayStep.startedAt > latestReviewActor.completedAt &&
    !contexts.some((context) => ['launching', 'working', 'waiting'].includes(context.status))
      ? {
          roundNumber:
            Math.max(...checks.flatMap((check) => check.rounds.map((round) => round.roundNumber))) +
            1,
          startedAt: replayStep.startedAt,
        }
      : null;
  const summary = [
    chain.length ? `${chain.length} diff generation${chain.length === 1 ? '' : 's'}` : '',
    `${checks.length} review check${checks.length === 1 ? '' : 's'}`,
    `${roundCount} round${roundCount === 1 ? '' : 's'}`,
  ]
    .filter(Boolean)
    .join(' · ');
  return {
    checks,
    segments,
    roundCount,
    activeReplay,
    summary,
    chain: chain.map((entry) => ({
      ...entry,
      continuity: observedReviewSessionContinuity(entry),
      range: range(entry.baseSha, entry.headSha) ?? 'SHA unavailable',
      diffPath:
        entry.artifactRefs.find((artifact) => artifact.path.endsWith('.diff'))?.path ?? null,
    })),
    events: reviewHistoryTimeline(
      run,
      checks.flatMap((check) => check.rounds),
    ),
  };
}

function reviewHistoryArtifactPathsForActor(actor: AgentContext | undefined): string[] {
  if (!actor?.reviewLoopNumber) return actor?.reviewResultFile ? [actor.reviewResultFile] : [];
  const dir = reviewArtifactDir(actor.reviewLoopNumber, actor.artifactScope);
  return [
    actor.reviewResultValidatedAt || !['working', 'launching', 'waiting'].includes(actor.status)
      ? actor.reviewResultFile
      : null,
    `${dir}/review-diff-stat.json`,
    ...(actor.reviewLoopNumber > 1 ? [`${dir}/fix-delta-stat.json`] : []),
  ].filter((path): path is string => Boolean(path));
}

function historyAttemptIdentity(value: unknown) {
  const attempt = record(value);
  return [
    attempt?.loopNumber,
    attempt?.mode,
    attempt?.verdict,
    attempt?.unresolvedCount,
    attempt?.startedAt,
    attempt?.completedAt,
    attempt?.reviewSnapshot,
    attempt?.fixDelta,
    attempt?.artifactPaths,
  ];
}

/** Refresh on retained round changes, without rereading files for unrelated run heartbeats. */
export function reviewHistoryIdentity(run: Run): string {
  return JSON.stringify([
    run.id,
    run.reviewResult,
    run.reviewMode,
    run.reviewRoundSettlements,
    readyReviews(run).map((review) => [
      review.id,
      review.runner,
      review.model,
      review.source,
      review.stale,
      historyAttemptIdentity(review),
      review.attempts?.map(historyAttemptIdentity),
    ]),
    run.steps
      .filter((step) => step.name.includes('review'))
      .map((step) => [
        step.status,
        step.startedAt,
        step.completedAt,
        Array.isArray(step.outputs?.attempts)
          ? step.outputs.attempts.map(historyAttemptIdentity)
          : undefined,
        step.outputs?.timeline,
        step.outputs?.reviewId,
        step.outputs?.runner,
        step.outputs?.model,
      ]),
    (run.agentContexts ?? [])
      .filter((context) => ['review', 'review-fix'].includes(context.role))
      .map((context) => [
        context.id,
        context.status,
        context.reviewLoopNumber,
        context.reviewResultValidatedAt,
        context.reviewResultFile,
        context.artifactScope,
        context.attemptStartedAt,
        context.startedAt,
        context.completedAt,
        context.deliveryBaselineRef,
        context.nativeSession?.handoffFrom,
      ]),
  ]);
}

/** One loader for both clients; the transport owns authentication and checks farm identity. */
export async function loadReviewHistoryArtifacts(
  run: Run,
  read: (path: string) => Promise<string | null>,
  readLive?: (params: FsReadParams) => Promise<string>,
  readDiff?: (params: GitDiffParams) => Promise<string>,
): Promise<Record<string, ReviewHistoryArtifact>> {
  const readPaths = async (paths: string[]) => {
    const settled = await Promise.allSettled(
      paths.map(async (path) => {
        const retained = await read(path);
        if (retained !== null) return retained;
        // A completed live round can precede its bundle capture. Its recorded task owns the read.
        const actor = !isTerminalRunStatus(run.status)
          ? run.agentContexts?.find(
              (context) =>
                context.role === 'review' &&
                context.runId === run.id &&
                context.slotId === run.slotId &&
                context.taskFile &&
                (reviewHistoryArtifactPathsForActor(context).includes(path) ||
                  (context.reviewLoopNumber &&
                    path.startsWith(
                      `${reviewArtifactDir(context.reviewLoopNumber, context.artifactScope)}/`,
                    ))),
            )
          : undefined;
        if (!readLive || !actor?.slotId || !actor.taskFile)
          throw new Error('Not recorded in the retained run');
        const taskDir = actor.taskFile.slice(0, actor.taskFile.lastIndexOf('/'));
        if (!taskDir || taskDir.split('/').includes('..') || path.split('/').includes('..'))
          throw new Error('Recorded review task is unavailable');
        return readLive({ slotId: actor.slotId, path: `${taskDir}/${path}` });
      }),
    );
    return Object.fromEntries(
      paths.map((path, index) => {
        const value = settled[index];
        return [
          path,
          value.status === 'fulfilled'
            ? { content: value.value }
            : {
                error: `${path}: ${value.reason instanceof Error ? value.reason.message : String(value.reason)}`,
              },
        ];
      }),
    );
  };
  const metadata = await readPaths(reviewHistoryArtifactPaths(run));
  if (readDiff && !isTerminalRunStatus(run.status))
    metadata['history:git'] = { content: 'enabled' };
  if (readLive && readDiff && !isTerminalRunStatus(run.status)) {
    const rounds = reviewHistoryView(run, metadata).checks.flatMap((check) => check.rounds);
    const recoveryRounds = rounds.filter((round) => !round.diffPath);
    const recoveries = await Promise.allSettled(
      recoveryRounds.map(async (round) => {
        const actor = run.agentContexts?.find(
          (context) =>
            context.id === round.key &&
            context.runId === run.id &&
            context.slotId === run.slotId &&
            context.taskFile &&
            !['working', 'launching'].includes(context.status),
        );
        if (!actor?.slotId || !actor.taskFile) return;
        const task = await readLive({ slotId: actor.slotId, path: actor.taskFile });
        // These are engine-written frozen input headers, not reviewer transcript/output.
        const match =
          /## COLD review range\s+Review the complete PR diff ([a-f0-9]{40})\.\.([a-f0-9]{40}) in /.exec(
            task,
          ) ?? /- Exact review range: `([a-f0-9]{40})\.\.([a-f0-9]{40})`/.exec(task);
        if (!match || (round.headSha && match[2] !== round.headSha)) return;
        metadata[recoveredSnapshotKey(actor)] = {
          content: JSON.stringify({
            source: 'local-git',
            baseSha: match[1],
            headSha: match[2],
            reconstructed: true,
          }),
        };
      }),
    );
    recoveries.forEach((result, index) => {
      if (result.status === 'rejected') {
        const actor = run.agentContexts?.find(
          (context) => context.id === recoveryRounds[index].key,
        );
        if (actor)
          metadata[recoveredSnapshotKey(actor)] = {
            error: result.reason instanceof Error ? result.reason.message : String(result.reason),
          };
      }
    });
  }
  if (readDiff && metadata['history:git']) {
    const requests = new Map<string, GitDiffParams>();
    for (const round of reviewHistoryView(run, metadata).checks.flatMap((check) => check.rounds)) {
      for (const [path, base, head] of [
        [round.diffPath, round.reviewBaseSha, round.headSha],
        [round.fixDiffPath, round.fixBaseSha, round.fixHeadSha],
      ]) {
        if (path?.startsWith('history:git:') && base && head)
          requests.set(path, {
            slotId: run.slotId ?? '',
            ...(run.slotId ? {} : { runId: run.id }),
            base,
            head,
          });
      }
    }
    const entries = [...requests];
    const results = await Promise.allSettled(entries.map(([, params]) => readDiff(params)));
    entries.forEach(([path], index) => {
      const value = results[index];
      metadata[path] =
        value.status === 'fulfilled'
          ? { content: value.value }
          : { error: value.reason instanceof Error ? value.reason.message : String(value.reason) };
    });
  }
  // Reuse each platform's existing diff viewer for changed files, instead of another diff parser.
  const diffs = [
    ...new Set(
      reviewHistoryView(run, metadata).checks.flatMap((check) =>
        check.rounds.flatMap((round) =>
          [round.fixDiffPath, round.diffPath]
            .filter((path) => !path?.startsWith('history:'))
            .filter((path): path is string => Boolean(path)),
        ),
      ),
    ),
  ];
  return { ...metadata, ...(await readPaths(diffs)) };
}
