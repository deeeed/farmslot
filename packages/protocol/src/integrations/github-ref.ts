import type { FlowType } from '../contracts/index.js';

export interface GitHubRef {
  repo: string;
  number: number;
  ref: string;
}

const GITHUB_REF_PATTERN = /^([a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+)#(\d+)$/;

export function parseGitHubRef(ref: string | null | undefined): GitHubRef | null {
  const match = ref?.trim().match(GITHUB_REF_PATTERN);
  if (!match) return null;
  const [owner, repo] = match[1].split('/');
  if (!owner || !repo || owner === '.' || owner === '..' || repo === '.' || repo === '..')
    return null;
  return {
    repo: match[1],
    number: Number(match[2]),
    ref: `${match[1]}#${match[2]}`,
  };
}

export function githubPullUrl(ref: Pick<GitHubRef, 'repo' | 'number'>): string {
  return `https://github.com/${ref.repo}/pull/${ref.number}`;
}

const GITHUB_PULL_URL_PATTERN =
  /^https?:\/\/(?:www\.)?github\.com\/([a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+)\/pull\/(\d+)(?:[/?#].*)?$/;

/**
 * Inverse of {@link githubPullUrl}. The only PR-URL parser in the codebase:
 * gateway projections normalize persisted `Run.links` URLs into refs here so
 * clients render `repo#number` without re-parsing URLs themselves.
 */
export function parseGitHubPullUrl(url: string | null | undefined): GitHubRef | null {
  const match = url?.trim().match(GITHUB_PULL_URL_PATTERN);
  if (!match) return null;
  return parseGitHubRef(`${match[1]}#${match[2]}`);
}

export const PR_BOUND_FLOW_TYPES: ReadonlySet<FlowType> = new Set([
  'review-pr',
  'pr-complete',
  'update-branch',
]);

export function prNumberFromRunInput(
  input: Pick<
    { flowType: FlowType; ticketOrPr: string; prNumber?: number | null },
    'flowType' | 'ticketOrPr' | 'prNumber'
  >,
): number | null {
  if (input.prNumber != null) return input.prNumber;
  if (!PR_BOUND_FLOW_TYPES.has(input.flowType)) return null;
  return parseGitHubRef(input.ticketOrPr)?.number ?? null;
}
