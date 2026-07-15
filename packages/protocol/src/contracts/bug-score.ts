// bug-score.ts — Pure decision cores for the LLM grading / validity / batch
// stages of the bug pipeline (ported from grade-bug.sh, validate-bug.sh, and
// the GitHub post-filter in batch-triage.sh). No IO — callers own the `claude`
// CLI edge, network fetches, and score-file reads/writes.
//
// Companion to bug-input.ts (parseBugInput / validateBugScore / deriveScoreKey);
// together they hold every decision the retired bug scripts encoded.

import { BUG_SCORE_DIFFICULTIES, type BugScore, type BugScoreDifficulty } from './bug-input.js';

// ── LLM grade (grade-bug.sh) ─────────────────────────────────────────────────

export const LLM_COMPLEXITIES = [
  'single-file change',
  'multi-file change',
  'architectural change',
  'unknown',
] as const;
export type LlmComplexity = (typeof LLM_COMPLEXITIES)[number];

export interface LlmGrade {
  difficulty: BugScoreDifficulty;
  confidence: number;
  one_shot_probability: number;
  reasoning: string;
  similar_past_bugs: string[];
  risk_factors: string[];
  estimated_complexity: LlmComplexity;
}

export const FINAL_SCORE_SOURCES = [
  'agreement',
  'conservative',
  'heuristic-only',
  'llm-only',
  'none',
] as const;
export type FinalScoreSource = (typeof FINAL_SCORE_SOURCES)[number];

export interface FinalScore {
  difficulty: BugScoreDifficulty;
  one_shot_probability: number;
  recommended_model: string;
  source: FinalScoreSource;
}

// ── Bug validity (validate-bug.sh) ───────────────────────────────────────────

export interface BugValidation {
  still_valid: boolean;
  confidence: number;
  reason: string;
}

/**
 * Strip a leading Markdown code fence (```…```), if present, and parse the
 * remainder as JSON. Mirrors the fence-stripping the grade-bug.sh /
 * validate-bug.sh Python did before `json.loads`. Throws with a teaching error
 * on invalid JSON; callers that tolerate unparseable LLM output (validity check)
 * catch it and fall back to a default.
 */
export function parseLlmJson(text: string): unknown {
  let body = text.trim();
  if (body.startsWith('```')) {
    // Drop the opening fence line, then everything from the closing fence on.
    const afterFirstLine = body.slice(body.indexOf('\n') + 1);
    const closeIdx = afterFirstLine.lastIndexOf('```');
    body = (closeIdx === -1 ? afterFirstLine : afterFirstLine.slice(0, closeIdx)).trim();
  }
  try {
    return JSON.parse(body);
  } catch {
    throw Object.assign(new Error('could not parse LLM response as JSON'), {
      code: 'LLM_PARSE_ERROR',
      userAction: 'The model must return a single JSON object (optionally in a ``` fence).',
    });
  }
}

/**
 * Validate a raw LLM grade object against the grade-bug.sh schema rules and
 * return the cleaned, schema-only shape. Throws with a teaching error listing
 * every violation. Optional fields (`risk_factors`, `similar_past_bugs`) default
 * to empty arrays, matching the Python `setdefault` behaviour.
 */
export function normalizeLlmGrade(value: unknown): LlmGrade {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw Object.assign(new Error('LLM grade must be a JSON object'), {
      code: 'INVALID_LLM_GRADE',
      userAction: 'Ensure the grading model emits a JSON object.',
    });
  }
  const d = value as Record<string, unknown>;
  const errors: string[] = [];

  if (!BUG_SCORE_DIFFICULTIES.includes(d['difficulty'] as BugScoreDifficulty)) {
    errors.push(
      `difficulty must be one of ${JSON.stringify([...BUG_SCORE_DIFFICULTIES])}, got: ${JSON.stringify(d['difficulty'])}`,
    );
  }
  const conf = d['confidence'];
  if (typeof conf !== 'number' || isNaN(conf) || conf < 0 || conf > 1) {
    errors.push(`confidence must be 0-1, got: ${JSON.stringify(conf)}`);
  }
  const prob = d['one_shot_probability'];
  if (typeof prob !== 'number' || isNaN(prob) || prob < 0 || prob > 1) {
    errors.push(`one_shot_probability must be 0-1, got: ${JSON.stringify(prob)}`);
  }
  const reasoning = d['reasoning'];
  if (typeof reasoning !== 'string' || reasoning.length === 0) {
    errors.push('reasoning is required and must be a non-empty string');
  }
  if (!LLM_COMPLEXITIES.includes(d['estimated_complexity'] as LlmComplexity)) {
    errors.push(
      `estimated_complexity must be one of ${JSON.stringify([...LLM_COMPLEXITIES])}, got: ${JSON.stringify(d['estimated_complexity'])}`,
    );
  }

  if (errors.length > 0) {
    throw Object.assign(new Error(`LLM response validation failed: ${errors.join('; ')}`), {
      code: 'INVALID_LLM_GRADE',
      userAction: 'Fix the grading prompt/model so its JSON satisfies the grade schema.',
    });
  }

  return {
    difficulty: d['difficulty'] as BugScoreDifficulty,
    confidence: conf as number,
    one_shot_probability: prob as number,
    reasoning: reasoning as string,
    similar_past_bugs: toStringArray(d['similar_past_bugs']),
    risk_factors: toStringArray(d['risk_factors']),
    estimated_complexity: d['estimated_complexity'] as LlmComplexity,
  };
}

const DIFFICULTY_RANK: Record<BugScoreDifficulty, number> = {
  low: 0,
  medium: 1,
  high: 2,
  extreme: 3,
};

const MODEL_BY_DIFFICULTY: Record<BugScoreDifficulty, string> = {
  low: 'sonnet',
  medium: 'sonnet',
  high: 'sonnet',
  extreme: 'opus',
};

/**
 * Deterministically merge an LLM grade with the optional heuristic score into a
 * final assessment (grade-bug.sh's final-score block). When both exist and
 * agree, the shared difficulty wins (`agreement`); when they differ, the harder
 * estimate wins (`conservative`) and the one-shot probability is their mean
 * rounded to two decimals. With no heuristic, the LLM grade passes through
 * (`llm-only`).
 */
export function computeFinalScore(llm: LlmGrade, heuristic: BugScore | null): FinalScore {
  const lRank = DIFFICULTY_RANK[llm.difficulty];
  let difficulty: BugScoreDifficulty;
  let oneShot: number;
  let source: FinalScoreSource;

  if (heuristic) {
    const hRank = DIFFICULTY_RANK[heuristic.difficulty];
    if (hRank === lRank) {
      difficulty = heuristic.difficulty;
      source = 'agreement';
    } else {
      // Conservative: keep the harder estimate.
      difficulty = hRank > lRank ? heuristic.difficulty : llm.difficulty;
      source = 'conservative';
    }
    oneShot = round2((heuristic.one_shot_probability + llm.one_shot_probability) / 2);
  } else {
    difficulty = llm.difficulty;
    oneShot = llm.one_shot_probability;
    source = 'llm-only';
  }

  return {
    difficulty,
    one_shot_probability: oneShot,
    recommended_model: MODEL_BY_DIFFICULTY[difficulty],
    source,
  };
}

/**
 * Apply the validate-bug.sh defaults to a parsed validity object: fill missing
 * `still_valid` (default true), `confidence` (0), and `reason` (empty), coercing
 * each to its declared type. Unparseable LLM output is handled by the caller —
 * pass `{ reason: 'LLM response unparseable' }` to reproduce that fallback.
 */
export function normalizeBugValidation(value: unknown): BugValidation {
  const v =
    value !== null && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  return {
    still_valid: typeof v['still_valid'] === 'boolean' ? v['still_valid'] : true,
    confidence:
      typeof v['confidence'] === 'number' && !isNaN(v['confidence']) ? v['confidence'] : 0,
    reason: typeof v['reason'] === 'string' ? v['reason'] : '',
  };
}

// ── Batch filtering (batch-triage.sh GitHub post-filter) ─────────────────────

export interface BatchIssueFilter {
  /** ISO date (YYYY-MM-DD); issues last updated before it are dropped. */
  since?: string;
  /** Drop issues that already have an assignee. */
  excludeAssigned?: boolean;
}

/**
 * The batch-triage.sh GitHub post-filter: keep issues updated on/after `since`
 * and (when `excludeAssigned`) drop already-assigned issues. ISO timestamps
 * compare lexically, so the `updatedAt[:10] < since` string comparison the Python
 * did is preserved.
 */
export function filterBatchIssues<T extends { updatedAt?: string; assigned?: boolean }>(
  issues: T[],
  filter: BatchIssueFilter,
): T[] {
  return issues.filter((issue) => {
    if (filter.since) {
      const updated = (issue.updatedAt ?? '').slice(0, 10);
      if (updated < filter.since) return false;
    }
    if (filter.excludeAssigned && issue.assigned) return false;
    return true;
  });
}

// ── Private helpers ──────────────────────────────────────────────────────────

function toStringArray(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((v): v is string => typeof v === 'string');
}

// Round half to even (banker's rounding) at 2 decimals, approximating the
// retired Python grader's round(x, 2). Math.round rounds half up and diverged on
// clean decimal ties (mean 0.125 → 0.13 vs Python's 0.12), desyncing new score
// files from the ones already on disk; the exact-*.5 branch below fixes those.
//
// NOTE: this does NOT bit-match Python round(x, 2) on *binary* near-ties. Python
// rounds the true IEEE-754 double, while we round n*100 — a value like
// (0.01 + 0.02) / 2 is 0.015000000000000001 in JS, so n*100 lands just above
// 1.5 and we round to 0.02, whereas Python's round(0.015, 2) yields 0.01. We do
// not chase bit-parity (it would need arbitrary-precision decimal handling for a
// cosmetic 0.01 on a probability); scores may therefore differ by 0.01 from the
// retired Python grader on such near-ties. See the CHANGELOG entry for this port.
function round2(n: number): number {
  const scaled = n * 100;
  const remainder = scaled - Math.floor(scaled);
  if (remainder === 0.5) {
    const floor = Math.floor(scaled);
    return (floor % 2 === 0 ? floor : floor + 1) / 100;
  }
  return Math.round(scaled) / 100;
}
