import {
  type DispatchMatchProjectParams,
  type DispatchMatchProjectResult,
  parseGitHubRef,
} from '@farmslot/protocol';

import { execFileArgv } from '../../core/index.js';
import { loadProjectConfigs } from '../../fleet/state.js';

import { normalizeTicketRef } from './ticket-ref.js';

// ─── Project Matching ───

export async function dispatchMatchProject(
  params: DispatchMatchProjectParams,
  deps: {
    loadConfigs?: typeof loadProjectConfigs;
    runArgv?: typeof execFileArgv;
  } = {},
): Promise<DispatchMatchProjectResult> {
  const configs = await (deps.loadConfigs ?? loadProjectConfigs)();
  const runArgv = deps.runArgv ?? execFileArgv;
  const { flowType } = params;
  // Normalize: extract ticket key from URLs
  const ticketOrPr = normalizeTicketRef(params.ticketOrPr);

  const normalized = ticketOrPr !== params.ticketOrPr.trim() ? ticketOrPr : undefined;

  // Jira ticket: match "XXX-123" prefix against project jira.project
  const jiraMatch = ticketOrPr.match(/^([A-Z]+)-\d/);
  if (jiraMatch) {
    const prefix = jiraMatch[1];
    const matched = configs.find((p) => p.jira?.project === prefix);
    if (matched) {
      // Fetch issue type from Jira (lightweight call)
      let issueType: string | undefined;
      try {
        const jiraConf = matched.jira;
        if (jiraConf?.base_url) {
          const { fetchJiraIssue } = await import('../../external/jira.js');
          const data = await fetchJiraIssue(ticketOrPr, {
            baseUrl: jiraConf.base_url,
            emailEnv: jiraConf.email_env,
            apiTokenEnv: jiraConf.api_token_env,
          });
          issueType = data.issueType;
        }
      } catch (err) {
        // Jira lookup is best-effort enrichment for the dispatch wizard — match still succeeds
        // by ticket prefix even when the API is unreachable. Log so silent prod failures are
        // visible without the operator having to compare wizard output to raw Jira state.
        console.warn(
          `[dispatch] jira issue lookup failed for ${ticketOrPr}: ${(err as Error).message}`,
        );
      }
      return {
        project: matched.name,
        repo: matched.ci.repo || null,
        normalizedTicket: normalized,
        issueType,
      };
    }
  }

  // GitHub PR/issue with repo already embedded: owner/repo#number — direct ci.repo match, no API call
  const ghWithRepo = parseGitHubRef(ticketOrPr);
  if (ghWithRepo) {
    const repoFullName = ghWithRepo.repo;
    const matched = configs.find((p) => p.ci?.repo?.toLowerCase() === repoFullName.toLowerCase());
    if (matched) {
      return { project: matched.name, repo: matched.ci.repo, normalizedTicket: normalized };
    }
  }

  // PR number: check each project's ci.repo via GitHub API
  if (/^\d+$/.test(ticketOrPr.trim())) {
    const prNum = ticketOrPr.trim();
    const withRepo = configs.filter((p) => p.ci?.repo);

    for (const proj of withRepo) {
      try {
        const result = await runArgv([
          'gh',
          'pr',
          'view',
          prNum,
          '--repo',
          proj.ci.repo,
          '--json',
          'number',
          '--jq',
          '.number',
        ]);
        if (result.exitCode === 0 && result.stdout.trim() === prNum) {
          return {
            project: proj.name,
            repo: proj.ci.repo,
            normalizedTicket: `${proj.ci.repo}#${prNum}`,
          };
        }
      } catch (err) {
        // Probe the next project on lookup failure — wrong-repo guesses are expected here.
        // Log so an outright auth/network outage doesn't silently degrade every dispatch to
        // `project: null`.
        console.warn(
          `[dispatch] gh pr view ${prNum} failed for ${proj.ci.repo}: ${(err as Error).message}`,
        );
      }
    }
  }

  // Branch name (for PR flows): look up PR by head branch across all projects
  if (flowType && ['review-pr', 'pr-complete', 'update-branch'].includes(flowType)) {
    const withRepo = configs.filter((p) => p.ci?.repo);
    for (const proj of withRepo) {
      try {
        const result = await runArgv([
          'gh',
          'pr',
          'list',
          '--head',
          ticketOrPr,
          '--repo',
          proj.ci.repo,
          '--json',
          'number',
          '--jq',
          '.[0].number',
        ]);
        const prNum = result.stdout.trim();
        if (result.exitCode === 0 && /^\d+$/.test(prNum)) {
          return {
            project: proj.name,
            repo: proj.ci.repo,
            normalizedTicket: `${proj.ci.repo}#${prNum}`,
          };
        }
      } catch (err) {
        // Same recovery contract as the PR-number probe above — branch/repo mismatch is the
        // expected miss path; a real failure (auth/offline) deserves a log.
        console.warn(
          `[dispatch] gh pr list head=${ticketOrPr} failed for ${proj.ci.repo}: ${(err as Error).message}`,
        );
      }
    }
  }

  return { project: null, repo: null, normalizedTicket: normalized };
}
