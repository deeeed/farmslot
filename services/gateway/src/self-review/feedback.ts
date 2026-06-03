import type { SelfReviewIssue } from '@farmslot/protocol';

import { loadSlotVars } from '../core/config.js';
import { execOnSlot } from '../core/exec.js';
import { shellQuote } from '../core/tmux.js';

import type { ReviewAgentResult } from './review-agent.js';

// ─── Read review output ───

export async function readReviewFeedback(
  vars: Awaited<ReturnType<typeof loadSlotVars>>,
  taskDir: string,
): Promise<ReviewAgentResult> {
  const feedbackPath = `${vars.remoteRepo}/${taskDir}/artifacts/review-feedback.md`;
  try {
    const content = (
      await execOnSlot(vars, `cat ${shellQuote(feedbackPath)} 2>/dev/null`)
    ).stdout.trim();
    if (!content) {
      console.warn(`[self-review] review-feedback.md is empty or missing — agent did not complete`);
      return { verdict: 'pass', issues: [], incomplete: true };
    }

    // Parse verdict
    const verdictMatch = content.match(/##\s*Verdict:\s*(PASS|ISSUES)/i);
    const verdict = verdictMatch?.[1]?.toUpperCase() === 'ISSUES' ? 'issues' : 'pass';

    // Parse issues
    const issues: SelfReviewIssue[] = [];
    if (verdict === 'issues') {
      const issueRegex = /[-*]\s+\*\*([^*]+)\*\*\s*[—–-]\s*(.*)/g;
      let match;
      while ((match = issueRegex.exec(content)) !== null) {
        const loc = match[1].trim();
        const desc = match[2].trim();
        const [file, lineStr] = loc.split(':');
        issues.push({
          file: file || loc,
          line: lineStr ? parseInt(lineStr, 10) || undefined : undefined,
          description: desc,
        });
      }
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
    throw new Error(`Failed to parse review-feedback.md: ${(err as Error).message}`);
  }
}
