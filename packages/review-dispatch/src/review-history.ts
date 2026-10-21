import {
  type AgentContext,
  deriveChecklistStepDurations,
  extractRunArtifactManifest,
  type FsReadParams,
  isTerminalRunStatus,
  observedReviewSessionContinuity,
  type ReviewAttempt,
  type ReviewChainEntry,
  reviewChainForRun,
  type ReviewMode,
  type ReviewStatus,
  type Run,
} from '@farmslot/protocol';

import { runActivityView, runReviewActivityContext } from './run-activity.js';

export interface ReviewHistoryFinding {
  title: string;
  details: string;
  severity: string;
  file: string;
  line: number | null;
}
export interface ReviewHistoryArtifact {
  content?: string;
  error?: string;
}
export type ReviewHistoryArtifacts = Readonly<Record<string, ReviewHistoryArtifact>>;

export interface ReviewHistoryRound {
  key: string;
  reviewId: string;
  loopNumber: number;
  runner: string;
  model: string;
  mode: ReviewMode | null;
  modeLabel: string;
  verdict: string;
  startedAt: string | null;
  completedAt: string | null;
  durationMs: number | null;
  unresolvedCount: number | null;
  unresolvedLabel: string;
  findingsLabel: string;
  findings: ReviewHistoryFinding[];
  earlierAttempts: Array<{ status: string; startedAt: string | null; durationMs: number | null }>;
  reviewRange: string;
  fixRange: string | null;
  fixStat: string | null;
  fixDurationMs: number | null;
  fixRunning: boolean;
  activeFixStartedAt: string | null;
  resolution: 'Not recorded';
  hasFix: boolean;
  diffPath: string | null;
  reviewDiffRetained: boolean;
  fixDiffPath: string | null;
  fixDiffText: string | null;
  fixDiffError: string | null;
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
        title,
        details: body.startsWith(title) ? body.slice(title.length).trim() : body,
        severity: text(issue.severity) ?? priority?.[1] ?? 'Severity not recorded',
        file: text(issue.file) ?? text(issue.path) ?? 'General finding',
        line: number(issue.line),
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
  const contexts = (run.agentContexts ?? []).filter(
    (context) => context.role === 'review' && context.reviewId && context.reviewLoopNumber,
  );
  const reviews = readyReviews(run);
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
    const rounds = loops.map((loop): ReviewHistoryRound => {
      const roundActors = actors
        .filter((context) => context.reviewLoopNumber === loop)
        .sort((left, right) =>
          (left.attemptStartedAt ?? left.startedAt ?? '').localeCompare(
            right.attemptStartedAt ?? right.startedAt ?? '',
          ),
        );
      const actor = roundActors.at(-1);
      const recordedAttempt = attempts.filter((entry) => entry.loopNumber === loop).at(-1);
      const recordedRaw = stepAttempts
        .filter((entry, index) => (number(entry.loopNumber) ?? index + 1) === loop)
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
      const snapshot =
        attempt?.reviewSnapshot ??
        record(raw?.reviewSnapshot) ??
        artifact(artifacts, `${dir}/review-diff-stat.json`);
      const fix =
        attempt?.fixDelta ??
        record(raw?.fixDelta) ??
        artifact(artifacts, `${dir}/fix-delta-stat.json`);
      const issueValue = attempt?.issues ?? raw?.issues ?? saved?.issues;
      const issueRows = findings(issueValue);
      const startedAt =
        attempt?.startedAt ??
        text(raw?.startedAt) ??
        actor?.attemptStartedAt ??
        actor?.startedAt ??
        null;
      const completedAt =
        attempt?.completedAt ?? text(raw?.completedAt) ?? actor?.completedAt ?? null;
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
      const latest = loop === loops.at(-1);
      const initialMode =
        loop === 1 && id === `pipeline-review-${run.id}`
          ? record(run.steps.find((step) => step.name === 'review')?.inputs?.reviewSelection)?.mode
          : null;
      const mode =
        attempt?.mode ?? text(raw?.mode) ?? (actor?.reviewFallback ? 'cold' : initialMode);
      const recorded = Array.isArray(issueValue);
      const verdict =
        attempt?.verdict ??
        text(raw?.verdict) ??
        (actor?.status === 'failed' ? 'failed' : text(saved?.verdict)) ??
        (actor?.status === 'complete' ? 'Result not recorded' : 'pending');
      const unresolved =
        attempt?.unresolvedCount ??
        number(raw?.unresolvedCount) ??
        (recorded ? issueRows.length : null);
      return {
        key: `${id}:${loop}`,
        reviewId: id,
        loopNumber: loop,
        runner: actor?.runner ?? review?.runner ?? text(step?.outputs?.runner) ?? 'Unknown runner',
        model: actor?.model ?? review?.model ?? text(step?.outputs?.model) ?? 'default',
        mode: mode === 'warm' || mode === 'cold' ? mode : null,
        modeLabel: mode === 'warm' || mode === 'cold' ? mode.toUpperCase() : 'Mode not recorded',
        verdict,
        startedAt,
        completedAt,
        durationMs: duration(startedAt, completedAt),
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
            : 'Findings not recorded',
        findings: issueRows,
        earlierAttempts: roundActors.slice(0, -1).map((context) => ({
          status: context.status,
          startedAt: context.attemptStartedAt ?? context.startedAt ?? null,
          durationMs: duration(
            context.attemptStartedAt ?? context.startedAt ?? null,
            context.completedAt ?? null,
          ),
        })),
        reviewRange: range(snapshot?.baseSha, snapshot?.headSha) ?? 'SHA unavailable',
        fixRange: range(fix?.fixBaseSha ?? fix?.baseSha, fix?.fixHeadSha ?? fix?.headSha),
        fixStat: fixStat(fix),
        fixDurationMs:
          segment?.durationMs ??
          number(rawSegment?.durationMs) ??
          duration(
            segment?.startedAt ?? text(rawSegment?.startedAt),
            segment?.completedAt ?? text(rawSegment?.completedAt),
          ),
        fixRunning: Boolean(latest && fixing),
        activeFixStartedAt: latest ? (fixing?.attemptStartedAt ?? fixing?.startedAt ?? null) : null,
        resolution: 'Not recorded',
        hasFix: Boolean(fix || segment || rawSegment),
        diffPath: text(snapshot?.diffPath),
        reviewDiffRetained: retainedPaths.has(String(snapshot?.diffPath)),
        fixDiffPath: text(fix?.diffPath),
        fixDiffText: text(fix?.diffPath)
          ? (artifacts[String(fix?.diffPath)]?.content ?? null)
          : null,
        fixDiffError: text(fix?.diffPath)
          ? (artifacts[String(fix?.diffPath)]?.error ?? null)
          : null,
        validationDepth:
          attempt?.validationDepth ??
          text(raw?.validationDepth) ??
          review?.validationDepth ??
          'static-code',
        timing: deriveChecklistStepDurations(attempt?.checklistTiming, startedAt ?? undefined),
        unavailable: [
          ...reviewHistoryArtifactPathsForActor(actor),
          ...(text(fix?.diffPath) ? [String(fix?.diffPath)] : []),
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
    summary,
    chain: chain.map((entry) => ({
      ...entry,
      continuity: observedReviewSessionContinuity(entry),
      range: range(entry.baseSha, entry.headSha) ?? 'SHA unavailable',
      diffPath:
        entry.artifactRefs.find((artifact) => artifact.path.endsWith('.diff'))?.path ?? null,
    })),
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

/** Refresh on retained round changes, without rereading files for unrelated run heartbeats. */
export function reviewHistoryIdentity(run: Run): string {
  return JSON.stringify([
    run.id,
    readyReviews(run),
    run.steps
      .filter((step) => step.name.includes('review'))
      .map((step) => [
        step.outputs?.attempts,
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
      ]),
  ]);
}

/** One loader for both clients; the transport owns authentication and checks farm identity. */
export async function loadReviewHistoryArtifacts(
  run: Run,
  read: (path: string) => Promise<string | null>,
  readLive?: (params: FsReadParams) => Promise<string>,
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
  // Reuse each platform's existing diff viewer for changed files, instead of another diff parser.
  const diffs = [
    ...new Set(
      reviewHistoryView(run, metadata).checks.flatMap((check) =>
        check.rounds.flatMap((round) => (round.fixDiffPath ? [round.fixDiffPath] : [])),
      ),
    ),
  ];
  return { ...metadata, ...(await readPaths(diffs)) };
}
