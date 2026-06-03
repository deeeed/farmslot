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
