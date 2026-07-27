import { type FlowType, parseGitHubRef, PR_BOUND_FLOW_TYPES } from '@farmslot/protocol';

import { execFileArgv } from '../../core/index.js';

/** Extract a standalone ticket key from Jira/GitHub URLs or clean up input. */
export function normalizeTicketRef(input: string): string {
  const trimmed = input.trim();
  // Jira URL: https://xxx.atlassian.net/browse/PROJ-2368
  const jiraMatch = trimmed.match(
    /^https?:\/\/[^\s/]+\.atlassian\.net\/browse\/([A-Z]+-\d+)(?:[/?#].*)?$/i,
  );
  if (jiraMatch) return jiraMatch[1].toUpperCase();
  // GitHub PR URL: https://github.com/owner/repo/pull/123
  const ghPR = trimmed.match(
    /^https?:\/\/(?:www\.)?github\.com\/([a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+)\/pull\/(\d+)(?:[/?#].*)?$/,
  );
  if (ghPR) return `${ghPR[1]}#${ghPR[2]}`;
  // GitHub issue URL: https://github.com/owner/repo/issues/123
  const ghIssue = trimmed.match(
    /^https?:\/\/(?:www\.)?github\.com\/([a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+)\/issues\/(\d+)(?:[/?#].*)?$/,
  );
  if (ghIssue) return `${ghIssue[1]}#${ghIssue[2]}`;
  return trimmed;
}

export function assertTicketRefMatchesProjectRepo(
  ticketOrPr: string,
  project: string,
  projectRepo: string | null | undefined,
): void {
  const ref = parseGitHubRef(ticketOrPr);
  if (!ref || !projectRepo) return;
  if (ref.repo.toLowerCase() !== projectRepo.toLowerCase()) {
    throw new Error(
      `GitHub reference ${ref.ref} belongs to ${ref.repo}, but project ${project} is configured for ${projectRepo}. ` +
        `Select the matching project or use a ticket/PR from ${projectRepo}.`,
    );
  }
}

/** Matches `PROJ-2368` style Jira keys. */
export const JIRA_KEY_RE = /^[A-Z][A-Z0-9]*-\d+$/;

/**
 * For PR flows, resolve bare PR numbers and branch names to `owner/repo#number`.
 * Needs the project's `ci.repo` (e.g. "example-org/example-browser").
 * Returns the resolved ref, or the original input if resolution fails.
 */
export async function resolvePrRef(input: string, repo: string): Promise<string> {
  const trimmed = input.trim();
  // Already in canonical form
  if (parseGitHubRef(trimmed)) return trimmed;
  // Bare PR number: "41535" → "owner/repo#41535"
  if (/^\d+$/.test(trimmed)) return `${repo}#${trimmed}`;
  // Branch name: look up the PR via gh CLI
  try {
    const result = await execFileArgv([
      'gh',
      'pr',
      'list',
      '--head',
      trimmed,
      '--repo',
      repo,
      '--json',
      'number',
      '--jq',
      '.[0].number',
    ]);
    const prNum = result.stdout.trim();
    if (result.exitCode === 0 && /^\d+$/.test(prNum)) {
      return `${repo}#${prNum}`;
    }
  } catch (err) {
    // gh offline / auth missing / rate-limited: caller still gets the raw branch name
    // and downstream resolution will surface the lookup failure with more context.
    console.warn(
      `[dispatch] pr lookup failed for branch ${trimmed} on ${repo}: ${(err as Error).message}`,
    );
  }
  return trimmed;
}

/**
 * Validates a *normalized* ticketOrPr against the flow type it's paired with.
 * Called at dispatch/runCreate entry so invalid input fails fast, before slot
 * allocation or task-file generation, with a message that lists accepted shapes.
 */
export function validateTicketRef(normalized: string, flowType: string): void {
  if (!normalized) {
    throw new Error('ticketOrPr is required (paste a Jira key, PR number, or URL)');
  }
  if (PR_BOUND_FLOW_TYPES.has(flowType as FlowType)) {
    if (!parseGitHubRef(normalized)) {
      const shown = normalized.length > 80 ? normalized.slice(0, 77) + '...' : normalized;
      throw new Error(
        `Invalid PR reference for flow '${flowType}': "${shown}". ` +
          `Paste the PR number (e.g. 41500), owner/repo#number (e.g. example-org/example-browser#41500), ` +
          `the full GitHub PR URL, or a branch name.`,
      );
    }
    return;
  }
  // Non-PR flows (fix-bug, new-feature, dev, custom): accept Jira key or GitHub issue ref.
  // Backlog-owned manual refs are accepted only by the narrow backlog handoff path
  // that supplies manual ticketData; direct dispatch must still require a real source.
  if (/^MANUAL-\d+$/.test(normalized)) {
    throw new Error(
      `Invalid ticket reference for flow '${flowType}': manual backlog refs must be dispatched from Backlog.`,
    );
  }
  if (!JIRA_KEY_RE.test(normalized) && !parseGitHubRef(normalized)) {
    const shown = normalized.length > 80 ? normalized.slice(0, 77) + '...' : normalized;
    throw new Error(
      `Invalid ticket reference for flow '${flowType}': "${shown}". ` +
        `Paste a Jira key (e.g. PROJ-2585), a Jira URL, a GitHub issue/PR URL, or owner/repo#number.`,
    );
  }
}
