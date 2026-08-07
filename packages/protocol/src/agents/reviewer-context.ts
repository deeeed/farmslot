import type { AgentContext, AgentRole } from '../contracts/index.js';

import { AGENT_ROLE_WINDOWS, agentRoleLabel, agentRoleWindow, contextIdFor } from './roles.js';

/** Legacy fixed self-review tmux window (pre multi-reviewer tabs). */
export const LEGACY_SELF_REVIEW_WINDOW = AGENT_ROLE_WINDOWS['self-review'] ?? 'self-review';

/**
 * Short runner token for tmux tab names. Model stays in AgentContext.model metadata —
 * never in the window title.
 */
export function reviewerRunnerToken(runner: string | null | undefined): string {
  const raw = (runner ?? 'reviewer').trim().toLowerCase();
  const cleaned = raw
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24);
  return cleaned || 'reviewer';
}

/**
 * Deterministic reviewer tmux window name for one run.
 * One canonical window is retained per runner (`rev-codex`, `rev-grok`, …)
 * and retargeted between review attempts. Legacy numbered names are recognized
 * below for recovery only; this helper never emits them.
 */
export function reviewerWindowName(runner: string | null | undefined): string {
  const token = reviewerRunnerToken(runner);
  return `rev-${token}`;
}

const REVIEWER_WINDOW_RE = /^rev(?:(\d+))?-([a-z0-9][a-z0-9-]{0,23})$/;
const LEGACY_REVIEW_FIX_WINDOW_RE = /^review-fix(?:-\d+)?$/;

export function isReviewerWindowName(windowName: string | null | undefined): boolean {
  if (!windowName) return false;
  if (windowName === LEGACY_SELF_REVIEW_WINDOW) return true;
  return REVIEWER_WINDOW_RE.test(windowName) || LEGACY_REVIEW_FIX_WINDOW_RE.test(windowName);
}

export function parseReviewerWindowName(
  windowName: string | null | undefined,
): { ordinal: number; runnerToken: string } | null {
  if (!windowName) return null;
  if (windowName === LEGACY_SELF_REVIEW_WINDOW) {
    return { ordinal: 0, runnerToken: 'self-review' };
  }
  const match = REVIEWER_WINDOW_RE.exec(windowName);
  if (!match) return null;
  return {
    ordinal: match[1] ? Number(match[1]) : 0,
    runnerToken: match[2],
  };
}

export function isReviewerAgentRole(role: AgentRole | null | undefined): boolean {
  return role === 'self-review';
}

export function isReviewerAgentContext(
  ctx:
    | {
        role?: AgentRole | null;
        id?: string | null;
        target?: { window?: string | null } | null;
      }
    | null
    | undefined,
): boolean {
  if (!ctx) return false;
  if (isReviewerAgentRole(ctx.role ?? null)) return true;
  if (isReviewerWindowName(ctx.target?.window ?? null)) return true;
  const id = ctx.id ?? '';
  if (id === contextIdFor('self-review') || id.startsWith('rev-') || /^rev\d+-/.test(id))
    return true;
  return false;
}

/**
 * Context id for a reviewer tab. Short and operator-addressable; same-run scope is
 * enforced by AgentContext.runId + selectors, not by embedding runId in the tab id.
 */
export function reviewerContextId(windowName: string): string {
  return windowName;
}

export function reviewerContextLabel(
  runner: string | null | undefined,
  windowName: string,
  model?: string | null,
): string {
  const token = reviewerRunnerToken(runner);
  const base = windowName.startsWith('rev') ? windowName : `rev-${token}`;
  if (model?.trim()) return `${base} (${model.trim()})`;
  return base;
}

export interface AllocateReviewerContextInput {
  runId: string;
  runner: string;
  model?: string | null;
}

export interface AllocatedReviewerContext {
  id: string;
  role: 'self-review';
  label: string;
  windowName: string;
  runId: string;
  runner: string;
  model: string | null;
}

/**
 * Resolve the one reviewer context/window owned by this runner. Review
 * generations retarget this window; reset versus resume changes the runner
 * session, never the tmux topology.
 */
export function allocateReviewerContext(
  input: AllocateReviewerContextInput,
): AllocatedReviewerContext {
  const { runId, runner, model = null } = input;
  const windowName = reviewerWindowName(runner);

  return {
    id: reviewerContextId(windowName),
    role: 'self-review',
    label: reviewerContextLabel(runner, windowName, model),
    windowName,
    runId,
    runner,
    model,
  };
}

/** Prefer the most recently updated reviewer; falls back to legacy self-review id. */
export function selectLatestReviewerContext<
  T extends {
    id: string;
    role?: AgentRole;
    target?: AgentContext['target'];
    updatedAt?: string;
    startedAt?: string;
    lastSignalAt?: string | null;
  },
>(contexts: ReadonlyArray<T>): T | null {
  const reviewers = contexts.filter((ctx) => isReviewerAgentContext(ctx));
  if (reviewers.length === 0) return null;
  return [...reviewers].sort((a, b) => {
    const aTs = Date.parse(a.updatedAt ?? a.lastSignalAt ?? a.startedAt ?? '') || 0;
    const bTs = Date.parse(b.updatedAt ?? b.lastSignalAt ?? b.startedAt ?? '') || 0;
    if (aTs !== bTs) return bTs - aTs;
    return a.id.localeCompare(b.id);
  })[0];
}

export function agentRoleForWindowName(windowName: string | null | undefined): AgentRole | null {
  if (!windowName) return null;
  if (isReviewerWindowName(windowName)) return 'self-review';
  for (const [role, name] of Object.entries(AGENT_ROLE_WINDOWS) as Array<
    [AgentRole, string | null]
  >) {
    if (role === 'primary') continue;
    if (name === windowName) return role;
  }
  return null;
}

export function defaultWindowForAgentRole(role: AgentRole): string | null {
  return agentRoleWindow(role);
}

export function defaultLabelForAgentRole(role: AgentRole): string {
  return agentRoleLabel(role);
}
