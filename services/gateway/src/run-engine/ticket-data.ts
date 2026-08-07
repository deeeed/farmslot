import type {
  FlowType,
  LinkedTicket,
  PrIntegrationStatus,
  Run,
  RunTicketData,
} from '@farmslot/protocol';

import type { RawProjectJson } from '../core/config.js';
import { fetchGitHubIssue, fetchGitHubPR } from '../external/github.js';
import { fetchJiraIssue } from '../external/jira.js';
import { getRun, updateRun } from '../runs/store.js';

import { loadProjectVarsOrNull } from './project-vars.js';
import { refreshRunLinks } from './run-links.js';

export function detectFlowTypeMismatch(flowType: FlowType, issueType: string): string | null {
  const type = issueType.toLowerCase();
  switch (flowType) {
    case 'fix-bug':
      if (type !== 'bug') return `use "dev" for ${issueType} tickets`;
      break;
    case 'dev':
      if (type === 'bug') return `use "fix-bug" for Bug tickets`;
      break;
    // review-pr and pr-complete don't have a ticket type constraint
  }
  return null;
}

function buildPrIntegrationNote(
  mergeable?: string | null,
  mergeStateStatus?: string | null,
): PrIntegrationStatus {
  const parts: string[] = [];
  if (mergeable) parts.push(`mergeable=${mergeable}`);
  if (mergeStateStatus) parts.push(`mergeStateStatus=${mergeStateStatus}`);
  let note = parts.length > 0 ? parts.join(', ') : 'GitHub merge state unknown';
  if (mergeable === 'CONFLICTING') {
    note += ' — author must resolve merge conflicts before merge';
  } else if (mergeStateStatus === 'BEHIND') {
    note += ' — branch is behind base; author may need to update before merge';
  } else if (mergeStateStatus === 'BLOCKED') {
    note += ' — merge blocked (often CI or branch protection); review code independently';
  }
  return {
    ...(mergeable ? { mergeable } : {}),
    ...(mergeStateStatus ? { mergeStateStatus } : {}),
    note,
  };
}

export async function fetchPRData(
  runId: string,
): Promise<Awaited<ReturnType<typeof fetchGitHubPR>> | null> {
  const run = getRun(runId)!;

  // Use prNumber if available (chained runs have issue ref in ticketOrPr but real PR in prNumber)
  let prRef = run.ticketOrPr;
  if (run.prNumber) {
    const repoMatch = prRef?.match(/^([^#]+)#/);
    const repo = repoMatch?.[1] ?? '';
    if (repo) prRef = `${repo}#${run.prNumber}`;
  }
  if (!prRef) return null;

  console.log(`[run-engine] fetching PR data for ${prRef}`);

  // Fetch PR metadata (branch, title, body)
  const prData = await fetchGitHubPR(prRef);

  // Build ticket data from PR
  const ticketData: RunTicketData = {
    source: 'github',
    title: prData.title,
    description: prData.body,
    acceptanceCriteria: [],
    affectedArea: '',
    stepsToReproduce: [],
    screenshots: [],
    labels: [],
    prIntegration: buildPrIntegrationNote(prData.mergeable, prData.mergeStateStatus),
  };

  // Extract ALL Jira keys referenced in the PR body (deduped, first-occurrence order).
  // PRs routinely link multiple tickets ("Fixes PROJ-123, PROJ-456"); we fetch them all
  // in parallel and expose them to templates as a single LINKED_TICKETS block.
  const jiraKeys: string[] = [];
  const seenKeys = new Set<string>();
  for (const m of prData.body.matchAll(/\b([A-Z]+-\d+)\b/g)) {
    const key = m[1];
    if (!seenKeys.has(key)) {
      seenKeys.add(key);
      jiraKeys.push(key);
    }
  }

  if (jiraKeys.length > 0) {
    try {
      const pv = await loadProjectVarsOrNull(run.project, 'run recovery', run.id);
      const pj: RawProjectJson | undefined = pv?.projectJson;
      const baseUrl: string | undefined = pj?.jira?.base_url;
      if (baseUrl) {
        const jiraConfig = {
          baseUrl,
          emailEnv: pj?.jira?.email_env,
          apiTokenEnv: pj?.jira?.api_token_env,
        };

        const fetched = await Promise.all(
          jiraKeys.map(async (key) => {
            try {
              const data = await fetchJiraIssue(key, jiraConfig);
              return { key, data, error: null as Error | null };
            } catch (err) {
              console.warn(
                `[run-engine] Jira fetch for linked key ${key} failed (non-fatal): ${(err as Error).message}`,
              );
              return { key, data: null as Partial<RunTicketData> | null, error: err as Error };
            }
          }),
        );

        const base = baseUrl.replace(/\/$/, '');
        const linkedTickets: LinkedTicket[] = fetched.map(({ key, data }) => ({
          ref: key,
          url: `${base}/browse/${key}`,
          title: data?.title ?? '',
          description: data?.description ?? '',
          source: 'jira' as const,
        }));
        ticketData.linkedTickets = linkedTickets;

        // Backward-compat: the first linked ticket drives the legacy single-ticket
        // fields that the existing templates and UI still read. Multi-ticket-aware
        // templates should use {{LINKED_TICKETS}} / {{LINKED_DESCRIPTIONS}} instead.
        const primary = fetched.find((f) => f.data);
        if (primary?.data) {
          ticketData.jiraKey = primary.key;
          ticketData.source = 'both';
          ticketData.description = [prData.body, primary.data.description]
            .filter(Boolean)
            .join('\n\n---\n\n');
          ticketData.acceptanceCriteria = primary.data.acceptanceCriteria ?? [];
          ticketData.affectedArea = primary.data.affectedArea ?? '';
          ticketData.screenshots = primary.data.screenshots ?? [];
          ticketData.labels = primary.data.labels ?? [];
          ticketData.issueType = primary.data.issueType;
          if (primary.data.comments && primary.data.comments.length > 0) {
            ticketData.comments = primary.data.comments;
          }
        }
      }
    } catch (err) {
      console.warn(
        `[run-engine] linked ticket fetch failed (non-fatal): ${(err as Error).message}`,
      );
    }
  }

  // Extract PR number for githubIssue field
  const numMatch = prRef.match(/^(?:([^#]+)#)?(\d+)$/);
  if (numMatch) {
    ticketData.githubIssue = prRef;
  }

  updateRun(runId, {
    branch: prData.branch,
    ticketData,
  });
  await refreshRunLinks(runId);
  const linkedRefs = ticketData.linkedTickets?.map((t) => t.ref).join(',') || 'none';
  console.log(`[run-engine] PR data set: branch=${prData.branch}, linked=${linkedRefs}`);
  return prData;
}

export async function fetchTicketData(run: Run): Promise<RunTicketData | null> {
  const ticket = run.ticketOrPr;
  if (!ticket) return null;

  // Determine source: Jira key (PROJ-1234) or GitHub ref (owner/repo#123)
  const isJira = /^[A-Z]+-\d+$/i.test(ticket);
  const isGitHub = ticket.includes('#');

  let jiraData: Partial<RunTicketData> = {};
  let githubData: Partial<RunTicketData> = {};

  if (isJira) {
    try {
      const pv = await loadProjectVarsOrNull(run.project, 'run recovery', run.id);
      const pj: RawProjectJson | undefined = pv?.projectJson;
      const baseUrl = pj?.jira?.base_url;
      if (baseUrl) {
        jiraData = await fetchJiraIssue(ticket, {
          baseUrl,
          emailEnv: pj?.jira?.email_env,
          apiTokenEnv: pj?.jira?.api_token_env,
        });
      }
    } catch (err) {
      console.warn(`[run-engine] Jira fetch failed: ${(err as Error).message}`);
    }
  }

  if (isGitHub) {
    try {
      githubData = await fetchGitHubIssue(ticket);
    } catch (err) {
      console.warn(`[run-engine] GitHub fetch failed: ${(err as Error).message}`);
    }
  }

  // Merge: GitHub takes priority for title
  const mergedComments = [...(githubData.comments ?? []), ...(jiraData.comments ?? [])];
  const merged: RunTicketData = {
    source:
      jiraData.source && githubData.source
        ? 'both'
        : (jiraData.source ?? githubData.source ?? 'manual'),
    title: githubData.title ?? jiraData.title ?? ticket,
    description: [githubData.description, jiraData.description].filter(Boolean).join('\n\n---\n\n'),
    acceptanceCriteria: [
      ...(githubData.acceptanceCriteria ?? []),
      ...(jiraData.acceptanceCriteria ?? []),
    ],
    affectedArea: githubData.affectedArea ?? jiraData.affectedArea ?? '',
    stepsToReproduce: [
      ...(githubData.stepsToReproduce ?? []),
      ...(jiraData.stepsToReproduce ?? []),
    ],
    screenshots: [...(githubData.screenshots ?? []), ...(jiraData.screenshots ?? [])],
    labels: [...(githubData.labels ?? []), ...(jiraData.labels ?? [])],
    jiraKey: jiraData.jiraKey,
    githubIssue: githubData.githubIssue,
    issueType: jiraData.issueType,
    ...(mergedComments.length > 0 ? { comments: mergedComments } : {}),
  };

  // If nothing was fetched, return minimal data
  if (merged.source === 'manual') {
    merged.title = ticket;
  }

  return merged;
}
