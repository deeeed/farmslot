// external/github.ts — GitHub API via `gh` CLI

import type { RunTicketData } from '@farmslot/protocol';

import { ghRequest, type GhRequestOpts } from '../integrations/github-client.js';

interface GitHubIssue {
  title: string;
  body: string;
  state: string;
  labels: Array<{ name: string }>;
}

interface GitHubPR {
  title: string;
  body: string;
  state: string;
  html_url: string;
  merged: boolean;
  merged_at: string | null;
  merge_commit_sha: string | null;
  head: { ref: string; sha: string };
  base: { ref: string; sha: string };
  number: number;
}

export async function fetchGitHubIssue(issueRef: string): Promise<Partial<RunTicketData>> {
  // issueRef format: "owner/repo#123" or just "#123" (needs repo context)
  const match = issueRef.match(/^(?:([^#]+)#)?(\d+)$/);
  if (!match) throw new Error(`Invalid GitHub issue ref: ${issueRef}`);

  const repo = match[1] || '';
  const number = match[2];
  if (!repo) throw new Error(`GitHub issue ref needs repo: owner/repo#number`);

  const result = await ghRequest(['api', `repos/${repo}/issues/${number}`]);
  const issue = JSON.parse(result.stdout) as GitHubIssue;
  const body = issue.body || '';
  const ac = extractSection(body, ['acceptance criteria', 'expected behavior']);
  const area = extractSection(body, ['affected area', 'component']);
  const steps = extractSection(body, ['steps to reproduce', 'repro steps']);

  // Extract image URLs from markdown
  const imagePattern = /!\[.*?\]\((https?:\/\/[^\s)]+)\)/g;
  const screenshots: string[] = [];
  let m;
  while ((m = imagePattern.exec(body)) !== null) {
    screenshots.push(m[1]);
  }

  return {
    source: 'github',
    title: issue.title,
    description: body,
    acceptanceCriteria: ac ? ac.split('\n').filter(Boolean) : [],
    affectedArea: area || '',
    stepsToReproduce: steps ? steps.split('\n').filter(Boolean) : [],
    screenshots,
    labels: issue.labels.map((l) => l.name),
    githubIssue: `${repo}#${number}`,
  };
}

export async function fetchGitHubPR(
  prRef: string,
  opts?: GhRequestOpts,
): Promise<{
  branch: string;
  title: string;
  body: string;
  url?: string;
  merged?: boolean;
  mergedAt?: string | null;
  mergeCommitSha?: string | null;
  baseRef: string;
  baseSha: string;
  headSha: string;
  number: number;
  mergeable?: string | null;
  mergeStateStatus?: string | null;
}> {
  const match = prRef.match(/^(?:([^#]+)#)?(\d+)$/);
  if (!match) {
    const shown = prRef.length > 80 ? prRef.slice(0, 77) + '...' : prRef;
    throw new Error(
      `Cannot parse "${shown}" as a GitHub PR reference. ` +
        `Expected formats: owner/repo#number, just a PR number, or a GitHub PR URL.`,
    );
  }

  const repo = match[1] || '';
  const number = match[2];

  const result = await ghRequest(['api', `repos/${repo}/pulls/${number}`], opts);
  const pr = JSON.parse(result.stdout) as GitHubPR;
  let mergeable: string | null = null;
  let mergeStateStatus: string | null = null;
  try {
    const viewResult = await ghRequest(
      ['pr', 'view', number, '--repo', repo, '--json', 'mergeable,mergeStateStatus'],
      opts,
    );
    const view = JSON.parse(viewResult.stdout) as {
      mergeable?: string | null;
      mergeStateStatus?: string | null;
    };
    mergeable = view.mergeable ?? null;
    mergeStateStatus = view.mergeStateStatus ?? null;
  } catch (err) {
    console.warn(
      `[github] merge state fetch for ${repo}#${number} failed (non-fatal): ${(err as Error).message}`,
    );
  }
  return {
    branch: pr.head.ref,
    title: pr.title,
    body: pr.body || '',
    url: pr.html_url,
    merged: pr.merged,
    mergedAt: pr.merged_at,
    mergeCommitSha: pr.merge_commit_sha,
    baseRef: pr.base.ref,
    baseSha: pr.base.sha,
    headSha: pr.head.sha,
    number: pr.number,
    mergeable,
    mergeStateStatus,
  };
}

// ─── PR Diff Files ───

export interface PRDiffFile {
  filename: string;
  status: string; // 'added' | 'removed' | 'modified' | 'renamed'
  additions: number;
  deletions: number;
  patch?: string;
}

/** Mark the exact files covered by a published review as viewed on GitHub. */
export async function markPRFilesViewed(
  repo: string,
  prNumber: number,
  paths: string[],
  opts?: GhRequestOpts,
): Promise<number> {
  const uniquePaths = [...new Set(paths.filter(Boolean))];
  if (uniquePaths.length === 0) return 0;

  const pull = await ghRequest(
    ['api', `repos/${repo}/pulls/${prNumber}`, '--jq', '.node_id'],
    opts,
  );
  const pullRequestId = pull.stdout.trim();
  if (!pullRequestId) throw new Error(`GitHub PR ${repo}#${prNumber} has no node id`);

  const batchSize = 25;
  for (let offset = 0; offset < uniquePaths.length; offset += batchSize) {
    const batch = uniquePaths.slice(offset, offset + batchSize);
    const declarations = batch.map((_, index) => `$path${index}: String!`).join(', ');
    const mutations = batch
      .map(
        (_, index) =>
          `file${index}: markFileAsViewed(input: {pullRequestId: $pullRequestId, path: $path${index}}) { clientMutationId }`,
      )
      .join('\n');
    const args = [
      'api',
      'graphql',
      '-f',
      `query=mutation($pullRequestId: ID!, ${declarations}) { ${mutations} }`,
      '-f',
      `pullRequestId=${pullRequestId}`,
    ];
    for (let index = 0; index < batch.length; index += 1) {
      args.push('-f', `path${index}=${batch[index]}`);
    }
    await ghRequest(args, { ...opts, force: true });
  }
  return uniquePaths.length;
}

export async function fetchPRDiffFiles(
  repo: string,
  prNumber: number,
  opts?: GhRequestOpts,
): Promise<PRDiffFile[]> {
  // Sanitize repo to prevent command injection (only allow owner/repo format)
  if (!/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(repo)) {
    throw new Error(`Invalid repo format: ${repo}. Expected owner/repo.`);
  }
  const result = await ghRequest(
    ['api', `repos/${repo}/pulls/${prNumber}/files`, '--paginate'],
    opts,
  );
  const files = JSON.parse(result.stdout) as Array<{
    filename: string;
    status: string;
    additions: number;
    deletions: number;
    patch?: string;
  }>;

  return files.map((f) => ({
    filename: f.filename,
    status: f.status,
    additions: f.additions,
    deletions: f.deletions,
    patch: f.patch,
  }));
}

function extractSection(text: string, headings: string[]): string {
  for (const h of headings) {
    const pattern = new RegExp(`(?:^|\\n)#+\\s*${h}[:\\s]*\\n([\\s\\S]*?)(?=\\n#|$)`, 'i');
    const match = text.match(pattern);
    if (match) return match[1].trim();
  }
  return '';
}
