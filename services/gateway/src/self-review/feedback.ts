import type { SelfReviewIssue } from '@farmslot/protocol';

import { loadSlotVars } from '../core/config.js';
import { execOnSlot } from '../core/exec.js';
import { shellQuote } from '../core/tmux.js';

import { parseSelfReviewIssueBullets } from './issues.js';
import type { ReviewAgentResult } from './review-agent.js';

// ─── Read review output ───

interface StructuredReviewFeedbackCandidate {
  schemaVersion?: unknown;
  verdict?: unknown;
  issues?: unknown;
}

interface StructuredReviewIssueCandidate {
  file?: unknown;
  line?: unknown;
  description?: unknown;
}

export function parseStructuredReviewFeedback(
  raw: string,
  resultRelPath: string,
): ReviewAgentResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return {
      verdict: 'issues',
      issues: [],
      incomplete: true,
      terminalInvalidReason: `${resultRelPath} is not valid JSON: ${(error as Error).message}`,
    };
  }
  if (!parsed || typeof parsed !== 'object') {
    return {
      verdict: 'issues',
      issues: [],
      incomplete: true,
      terminalInvalidReason: `${resultRelPath} must contain a JSON object`,
    };
  }
  const candidate = parsed as StructuredReviewFeedbackCandidate;
  const verdict =
    typeof candidate.verdict === 'string' ? candidate.verdict.trim().toLowerCase() : undefined;
  const issues = Array.isArray(candidate.issues) ? candidate.issues : null;
  const validIssues =
    issues?.every((value) => {
      const issue = value as StructuredReviewIssueCandidate;
      return (
        !!issue &&
        typeof issue === 'object' &&
        typeof issue.file === 'string' &&
        issue.file.trim().length > 0 &&
        (issue.line === undefined ||
          issue.line === null ||
          (typeof issue.line === 'number' && Number.isInteger(issue.line) && issue.line > 0)) &&
        typeof issue.description === 'string' &&
        issue.description.trim().length > 0
      );
    }) ?? false;
  if (
    candidate.schemaVersion !== 1 ||
    (verdict !== 'pass' && verdict !== 'issues') ||
    !validIssues ||
    (verdict === 'pass' && issues!.length !== 0) ||
    (verdict === 'issues' && issues!.length === 0)
  ) {
    return {
      verdict: 'issues',
      issues: [],
      incomplete: true,
      terminalInvalidReason:
        `${resultRelPath} must match schemaVersion 1 with verdict pass + no issues, ` +
        'or verdict issues + at least one { file, line?, description } issue',
    };
  }
  const normalizedIssues = (issues as StructuredReviewIssueCandidate[]).map((issue) => ({
    file: issue.file as string,
    ...(typeof issue.line === 'number' ? { line: issue.line } : {}),
    description: issue.description as string,
  }));
  return { verdict, issues: normalizedIssues };
}

export async function readReviewFeedback(
  vars: Awaited<ReturnType<typeof loadSlotVars>>,
  taskDir: string,
  feedbackRelPath = 'artifacts/review-feedback.md',
  resultRelPath?: string | null,
): Promise<ReviewAgentResult> {
  if (resultRelPath) {
    const resultPath = `${vars.remoteRepo}/${taskDir}/${resultRelPath}`;
    const result = await execOnSlot(vars, `cat ${shellQuote(resultPath)} 2>/dev/null`);
    const raw = result.stdout.trim();
    if (!raw) {
      return {
        verdict: 'issues',
        issues: [],
        incomplete: true,
        terminalInvalidReason:
          result.exitCode === 0 ? `${resultRelPath} is empty` : `${resultRelPath} is missing`,
      };
    }
    return parseStructuredReviewFeedback(raw, resultRelPath);
  }

  const feedbackPath = `${vars.remoteRepo}/${taskDir}/${feedbackRelPath}`;
  try {
    const content = (
      await execOnSlot(vars, `cat ${shellQuote(feedbackPath)} 2>/dev/null`)
    ).stdout.trim();
    if (!content) {
      console.warn(`[self-review] ${feedbackRelPath} is empty or missing — agent did not complete`);
      return { verdict: 'pass', issues: [], incomplete: true };
    }

    // Parse verdict
    const verdictMatch = content.match(/##\s*Verdict:\s*(PASS|ISSUES)/i);
    if (!verdictMatch) {
      console.warn(
        `[self-review] ${feedbackRelPath} has no PASS or ISSUES verdict — treating as incomplete`,
      );
      return { verdict: 'pass', issues: [], incomplete: true };
    }
    const verdict = verdictMatch[1]?.toUpperCase() === 'ISSUES' ? 'issues' : 'pass';

    // Parse issues
    let issues: SelfReviewIssue[] = [];
    if (verdict === 'issues') {
      issues = parseSelfReviewIssueBullets(content);
    }

    if (verdict === 'issues' && issues.length === 0) {
      // Parser invariant: ISSUES verdict implies at least one bullet. If the agent wrote
      // ISSUES but the bullets didn't match the expected `- **file:line** — desc` shape,
      // demote to pass-equivalent so the retry loop's `result.issues.length > 0` guard
      // (line 271) doesn't silently exit with empty-issues.
      console.warn(
        `[self-review] verdict=ISSUES but no issue bullets parsed — treating as incomplete`,
      );
      return { verdict: 'pass', issues: [], incomplete: true };
    }

    return { verdict, issues };
  } catch (err) {
    // Re-throw parsing/code errors — only the empty-content check above should
    // produce an incomplete result. Swallowing here masks real failures.
    throw new Error(`Failed to parse ${feedbackRelPath}: ${(err as Error).message}`);
  }
}
