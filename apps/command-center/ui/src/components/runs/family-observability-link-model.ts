import type { FamilyObservabilityRunSummary, RunLink } from '@farmslot/protocol';
import { githubPullUrl, parseGitHubRef } from '@farmslot/protocol';

type RunWithLinks = Pick<FamilyObservabilityRunSummary, 'links' | 'runId' | 'ticketOrPr'>;
type RunWithPr = Pick<FamilyObservabilityRunSummary, 'links' | 'prNumber' | 'runId' | 'ticketOrPr'>;

/** Extract the PR number from a GitHub-style URL, anchored on a delimiter so `/pull/5` doesn't match `/pull/50`. */
export function pullNumberFromUrl(url: string): string | null {
  return url.match(/\/pull\/(\d+)(?:[/?#]|$)/)?.[1] ?? null;
}

/** Resolve a Jira/PR URL for a ticketOrPr string. Returns null rather than a wrong-destination link. */
export function familyTicketUrl(
  ticketOrPr: string | null | undefined,
  runs: readonly RunWithLinks[],
  run?: RunWithLinks | null,
): string | null {
  if (!ticketOrPr) return null;
  const ownerRepoRef = parseGitHubRef(ticketOrPr);
  const matches = (link: RunLink) => {
    if (ownerRepoRef) {
      return pullNumberFromUrl(link.url) === String(ownerRepoRef.number);
    }
    // Jira-shaped key: anchor on a delimiter so `PROJ-30` ≠ `PROJ-309`.
    const escaped = ticketOrPr.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(^|[/=:])${escaped}(?:$|[/?#])`, 'i').test(link.url);
  };
  const fromRun = run?.links?.find(matches);
  if (fromRun) return fromRun.url;
  for (const candidate of runs) {
    if (candidate.ticketOrPr !== ticketOrPr) continue;
    const link = candidate.links?.find(matches);
    if (link) return link.url;
  }
  if (ownerRepoRef) return githubPullUrl(ownerRepoRef);
  return null;
}

export function familyPrUrl(run: RunWithPr, runs: readonly RunWithLinks[]): string | null {
  if (run.prNumber == null) return null;
  // Engine-time PR link is authoritative. Anchor on the captured number so `/pull/5`
  // doesn't match a sibling `/pull/50`.
  const target = String(run.prNumber);
  const linked = run.links?.find(
    (link) => link.label === 'PR' && pullNumberFromUrl(link.url) === target,
  );
  if (linked) return linked.url;
  const match = parseGitHubRef(run.ticketOrPr);
  if (match) return githubPullUrl({ repo: match.repo, number: run.prNumber });
  // Fallback: this run may use a non-PR family key, while a sibling captured owner/repo#N.
  const sibling = runs.find(
    (other) =>
      other.runId !== run.runId &&
      typeof other.ticketOrPr === 'string' &&
      parseGitHubRef(other.ticketOrPr),
  );
  const siblingMatch = parseGitHubRef(sibling?.ticketOrPr);
  if (siblingMatch) return githubPullUrl({ repo: siblingMatch.repo, number: run.prNumber });
  return null;
}
