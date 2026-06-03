import { githubPullUrl, parseGitHubRef, type Run, type RunLink } from '@farmslot/protocol';

import { loadProjectVars } from '../core/config.js';
import { getRun, updateRun } from '../runs/store.js';

// ─── External links ───
type ProjectLinkConfig = {
  ci?: { repo?: string };
  jira?: { base_url?: string; project?: string };
};

async function computeRunLinks(run: Run): Promise<RunLink[]> {
  const links: RunLink[] = [];
  let projectJson: ProjectLinkConfig | undefined;
  try {
    const pv = await loadProjectVars(run.project);
    projectJson = pv?.projectJson as ProjectLinkConfig | undefined;
  } catch (err) {
    // External links are optional for legacy/manual projects; missing project
    // config should not hide the run itself.
    console.warn(
      `[run-engine] run link project config unavailable for ${run.id}: ${(err as Error).message.slice(0, 200)}`,
    );
  }
  const ciRepo = projectJson?.ci?.repo; // e.g. "example-org/example-mobile"
  const jiraBaseUrl = projectJson?.jira?.base_url;
  const jiraProject = projectJson?.jira?.project; // e.g. "PROJ"
  // Jira ticket link — validate key matches project prefix to avoid false matches from PR body
  const jiraKey =
    run.ticketData?.jiraKey ?? (/^[A-Z]+-\d+$/i.test(run.ticketOrPr) ? run.ticketOrPr : null);
  if (jiraKey && jiraBaseUrl && (!jiraProject || jiraKey.startsWith(`${jiraProject}-`))) {
    links.push({ label: 'Jira', url: `${jiraBaseUrl.replace(/\/$/, '')}/browse/${jiraKey}` });
  }
  // Collect distinct GitHub numbers from all sources
  const ticketRef = parseGitHubRef(run.ticketOrPr);
  const ticketNum = ticketRef?.number ?? null;
  const ticketRepo = ticketRef?.repo ?? ciRepo;
  const ghIssueRef = parseGitHubRef(run.ticketData?.githubIssue);
  const ghIssueNum = ghIssueRef?.number ?? null;
  const prNum = run.prNumber ?? null;
  // Determine which number is the PR and which is the original issue.
  // When ticketOrPr # differs from prNumber, ticketOrPr is the original issue
  // and prNumber is the PR (set during completion). When they match, ghIssueNum
  // might be a different PR (from chained flows with stale prNumber).
  const allNums = new Set([ticketNum, ghIssueNum, prNum].filter((n): n is number => n != null));
  if (run.flowType === 'review-pr' && ticketNum) {
    const repo = ticketRepo ?? ciRepo;
    if (repo) {
      links.push({ label: 'PR', url: githubPullUrl({ repo, number: ticketNum }) });
    }
  } else if (allNums.size === 1 && prNum && ciRepo) {
    // Single number — it's the PR
    links.push({ label: 'PR', url: githubPullUrl({ repo: ciRepo, number: prNum }) });
  } else if (allNums.size >= 2) {
    // Multiple distinct numbers — figure out which is PR vs issue
    // The highest number is almost always the PR (PRs are created after issues)
    const maxNum = Math.max(...allNums);
    const repo = ciRepo ?? ticketRepo;
    if (repo) {
      links.push({ label: 'PR', url: githubPullUrl({ repo, number: maxNum }) });
      for (const num of allNums) {
        if (num !== maxNum) {
          links.push({ label: 'Issue', url: `https://github.com/${repo}/issues/${num}` });
        }
      }
    }
  }
  return links;
}
/** Recompute and persist links on a run (call after ticketData/prNumber changes). */
export async function refreshRunLinks(runId: string): Promise<void> {
  const run = getRun(runId);
  if (!run) return;
  const links = await computeRunLinks(run);
  if (links.length > 0) {
    updateRun(runId, { links });
  }
}
