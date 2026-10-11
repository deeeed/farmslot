/**
 * Gate review for an open `engine_human_gate` decision: the package summary, the
 * latest verdict of each independent reviewer, and the client-side guard that
 * keeps every publish approval disabled while the evidence is not complete. The
 * guard only withholds buttons; the gateway's own publish checks are unchanged.
 */
import {
  type DecisionAction,
  defaultReviewDepthPolicy,
  effectiveRequiredReviewCount,
  type IndependentReviewStatus,
  isPublishApprovalAction,
  isQualifyingIndependentReview,
  type ReadyGatePayload,
  type Run,
  type RunDecision,
} from '@farmslot/protocol';
// The shared palette, not `./theme`: that module builds StyleSheets, which pulls
// react-native into this pure module and out of reach of the node test runner.
import { colors } from '@farmslot/theme';

import type { AcceptanceLedgerView } from './task-progress-view';

export const HUMAN_GATE_DECISION_TYPE = 'engine_human_gate';

/** What the gate model reads from a decision, whether it came with its run or from `decision.list`. */
export type GateDecision = Pick<RunDecision, 'title' | 'payload'>;

export interface GateReviewSummary {
  title: string;
  target: string | null;
  branch: string | null;
  files: number | null;
  additions: number | null;
  deletions: number | null;
}

export interface GateReviewVerdict {
  runner: string;
  model: string | null;
  verdict: IndependentReviewStatus['verdict'];
  unresolvedCount: number;
  stale: boolean;
  /** A pass with nothing unresolved, judged on the current package. */
  approved: boolean;
  label: string;
  color: string;
}

export interface ApprovePublishGuard {
  blocked: boolean;
  reasons: string[];
}

export interface ApprovePublishGuardInput {
  /** Null while the criteria are loading or could not be read. */
  acceptance: Pick<AcceptanceLedgerView, 'rows'> | null;
  acceptanceError?: string | null;
  reviews: ReadonlyArray<GateReviewVerdict>;
  /** Independent reviews the gate's policy requires; see {@link gateRequiredReviewCount}. */
  requiredReviews: number;
}

export interface GateReviewAction extends DecisionAction {
  /** Why the action is withheld; null when it can be sent. */
  disabledReason: string | null;
}

/** The run's latest unresolved human gate, if any. */
export function openHumanGateDecision(
  run: Pick<Run, 'decisions'> | null | undefined,
): RunDecision | null {
  const decisions = run?.decisions ?? [];
  for (let index = decisions.length - 1; index >= 0; index -= 1) {
    const decision = decisions[index];
    if (decision.type === HUMAN_GATE_DECISION_TYPE && !decision.resolvedAt) return decision;
  }
  return null;
}

export function gateReviewHref(runId: string, decisionId: string) {
  return { pathname: '/gate-review/[decisionId]' as const, params: { decisionId, runId } };
}

function readyPayload(decision: GateDecision): ReadyGatePayload | null {
  return decision.payload?.kind === 'ready' ? (decision.payload as ReadyGatePayload) : null;
}

/** The package the gate asks to publish, from the decision's ready-gate payload. */
export function gateReviewSummary(decision: GateDecision): GateReviewSummary {
  const payload = readyPayload(decision);
  const prPackage = payload?.prPackage;
  const diffStat = prPackage?.diffStat ?? payload?.diffStat ?? null;
  return {
    title: payload?.currentDescription?.title || prPackage?.draftTitle || decision.title,
    target: prPackage?.publicationTarget ?? payload?.publicationTarget ?? null,
    branch: prPackage?.branch || payload?.branch || null,
    files: diffStat?.files ?? null,
    additions: diffStat?.additions ?? null,
    deletions: diffStat?.deletions ?? null,
  };
}

/**
 * Reviews the gate is judged on: the run's live publish-gate list, else the
 * snapshot the decision carried when it opened.
 */
export function gateIndependentReviews(
  run: Pick<Run, 'engineState'> | null | undefined,
  decision: GateDecision,
): IndependentReviewStatus[] {
  const live = run?.engineState?.publishGate?.independentReviews;
  if (live?.length) return live;
  return readyPayload(decision)?.independentReviews ?? [];
}

/**
 * Independent reviews a publication gate's frozen policy requires, counted the
 * way the gateway counts them. A gate with no prepared package publishes nothing,
 * and the gateway requires no review for it.
 */
export function gateRequiredReviewCount(decision: GateDecision): number {
  const payload = readyPayload(decision);
  if (!payload?.prPackage) return 0;
  return effectiveRequiredReviewCount(
    defaultReviewDepthPolicy(payload.prPackage.reviewDepth ?? payload.reviewDepth),
  );
}

/** Later loops win; within a loop, the later start. */
function isLaterReview(review: IndependentReviewStatus, current: IndependentReviewStatus): boolean {
  if (review.loopNumber !== current.loopNumber) return review.loopNumber > current.loopNumber;
  const started = Date.parse(review.startedAt ?? '');
  const currentStarted = Date.parse(current.startedAt ?? '');
  if (Number.isNaN(started) || Number.isNaN(currentStarted)) return true;
  return started >= currentStarted;
}

function verdictColor(review: IndependentReviewStatus, approved: boolean): string {
  if (approved) return colors.statusOk;
  if (review.verdict === 'pending' || review.stale) return colors.statusWarn;
  if (review.verdict === 'cancelled' || review.verdict === 'skipped') return colors.textMuted;
  return colors.statusFail;
}

/**
 * The latest independent review of each reviewer runner, ordered by runner.
 * Self-reviews are the worker's own pass and never count as a reviewer verdict.
 * Reviews with no recorded start keep their list order.
 */
export function latestReviewVerdicts(
  reviews: ReadonlyArray<IndependentReviewStatus>,
): GateReviewVerdict[] {
  const latest = new Map<string, IndependentReviewStatus>();
  for (const review of reviews) {
    if (!isQualifyingIndependentReview(review)) continue;
    const runner = review.runner?.trim() || 'unknown runner';
    const current = latest.get(runner);
    if (!current || isLaterReview(review, current)) latest.set(runner, review);
  }
  return [...latest.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([runner, review]) => {
      const stale = review.stale === true;
      const approved = review.verdict === 'pass' && review.unresolvedCount === 0 && !stale;
      const unresolved =
        review.unresolvedCount > 0 ? ` · ${review.unresolvedCount} unresolved` : '';
      return {
        runner,
        model: review.model ?? null,
        verdict: review.verdict,
        unresolvedCount: review.unresolvedCount,
        stale,
        approved,
        label: `${review.verdict}${stale ? ' (stale)' : ''}${unresolved}`,
        color: verdictColor(review, approved),
      };
    });
}

/**
 * Publishing needs every registered criterion judged and every reviewer's latest
 * verdict to approve. Criteria still loading or unreadable cannot show that, so
 * they withhold approval too.
 */
export function approvePublishGuard(input: ApprovePublishGuardInput): ApprovePublishGuard {
  const reasons: string[] = [];
  if (input.acceptanceError) {
    reasons.push(`Acceptance criteria unavailable: ${input.acceptanceError}`);
  } else if (!input.acceptance) {
    reasons.push('Acceptance criteria are still loading');
  } else {
    const unassessed = input.acceptance.rows
      .filter((row) => row.verdict === null)
      .map((row) => row.criterion.id);
    if (unassessed.length > 0) {
      reasons.push(
        `${unassessed.join(', ')} ${unassessed.length === 1 ? 'has' : 'have'} no verdict`,
      );
    }
  }
  if (input.reviews.length === 0 && input.requiredReviews > 0) {
    reasons.push('No independent review verdict yet');
  }
  for (const review of input.reviews) {
    if (!review.approved) reasons.push(`Latest ${review.runner} review is ${review.label}`);
  }
  return { blocked: reasons.length > 0, reasons };
}

/**
 * The decision's own actions. Every publish approval is withheld while the guard
 * blocks, overrides included: the phone approves only a complete gate, and the
 * overrides stay available where the full review context is (Command Center).
 * Hold and review requests are never withheld.
 */
export function gateReviewActions(
  actions: ReadonlyArray<DecisionAction>,
  guard: ApprovePublishGuard,
): GateReviewAction[] {
  return actions.map((action) => ({
    ...action,
    disabledReason:
      isPublishApprovalAction(action.id) && guard.blocked ? guard.reasons.join(' · ') : null,
  }));
}
