import { parseGitHubRef } from '@farmslot/protocol';

interface WorkspacePRLinkSource {
  ticketOrPr?: string | null;
  links?: Array<{ label?: string | null; url?: string | null }> | null;
}

interface GithubPullRef {
  repo: string;
  number: number;
}

export function prRepoFromWorkspaceSource(
  source: WorkspacePRLinkSource | null | undefined,
  prNumber?: number | null,
): string | null {
  if (!source) return null;
  const refs: GithubPullRef[] = [];
  const ticketRef = parseGitHubRef(source.ticketOrPr);
  if (ticketRef) refs.push({ repo: ticketRef.repo, number: ticketRef.number });

  const links = source.links ?? [];
  const prioritizedLinks = [...links].sort((left, right) => {
    const leftPr = isPRLinkLabel(left.label) ? 0 : 1;
    const rightPr = isPRLinkLabel(right.label) ? 0 : 1;
    return leftPr - rightPr;
  });
  for (const link of prioritizedLinks) {
    const ref = parseGithubPullUrl(link.url);
    if (ref) refs.push(ref);
  }

  const match = refs.find((ref) => !prNumber || ref.number === prNumber);
  return match?.repo ?? null;
}

function isPRLinkLabel(label: string | null | undefined): boolean {
  const normalized = label?.trim().toLowerCase();
  return normalized === 'pr' || normalized === 'pull request' || normalized === 'github pr';
}

function parseGithubPullUrl(url: string | null | undefined): GithubPullRef | null {
  const normalized = url?.trim();
  if (!normalized) return null;
  const match = normalized.match(
    /^https?:\/\/github\.com\/([^/?#]+\/[^/?#]+)\/pull\/(\d+)(?:[/?#].*)?$/i,
  );
  if (!match) return null;
  const ref = parseGitHubRef(`${match[1]}#${match[2]}`);
  return ref ? { repo: ref.repo, number: ref.number } : null;
}
