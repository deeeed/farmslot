// webhook.ts — HTTP webhook handlers for GitHub and Jira
// Parses incoming webhooks, matches to projects, queues dispatches via dispatch-queue

import { createHmac, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

import type { FlowType, ProjectConfig } from '@farmslot/protocol';

import { addItem } from './backlog/dispatch-queue.js';
import { loadProjectConfigs } from './fleet/state.js';
import type { WorkOriginator } from './security/work-originator.js';

export const WEBHOOK_WORK_ORIGINATORS = {
  github: { kind: 'principal', principalId: 'github-webhook' },
  jira: { kind: 'principal', principalId: 'jira-webhook' },
} as const satisfies Record<'github' | 'jira', WorkOriginator>;

// ─── Helpers ───

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function verifyGitHubSignature(body: Buffer, secret: string, signature: string): boolean {
  const expected = 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');
  if (expected.length !== signature.length) return false;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}

// ─── Project matching ───

function matchProjectByRepo(projects: ProjectConfig[], repoFullName: string): ProjectConfig | null {
  return projects.find((p) => p.ci.repo === repoFullName) ?? null;
}

function matchProjectByJiraKey(projects: ProjectConfig[], issueKey: string): ProjectConfig | null {
  const prefix = issueKey.split('-')[0];
  return projects.find((p) => p.jira.project === prefix) ?? null;
}

// ─── GitHub webhook ───

export async function handleGitHubWebhook(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const body = await readBody(req);
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(body.toString());
  } catch {
    json(res, 400, { error: 'Invalid JSON' });
    return;
  }

  // Match project by repo
  const repoObj = payload.repository as { full_name?: string } | undefined;
  const repoFullName = repoObj?.full_name;
  if (!repoFullName) {
    json(res, 400, { error: 'Missing repository.full_name' });
    return;
  }

  const projects = await loadProjectConfigs();
  const project = matchProjectByRepo(projects, repoFullName);
  if (!project) {
    console.log(`[webhook/github] no project matches repo ${repoFullName}`);
    json(res, 200, { ignored: true, reason: `no project for repo ${repoFullName}` });
    return;
  }

  // Validate signature if secret is configured
  const secret = project.webhooks?.github_secret;
  const sigHeader = req.headers['x-hub-signature-256'] as string | undefined;
  if (secret) {
    if (!sigHeader || !verifyGitHubSignature(body, secret, sigHeader)) {
      console.warn(`[webhook/github] signature verification failed for ${repoFullName}`);
      json(res, 401, { error: 'Invalid signature' });
      return;
    }
  } else if (sigHeader) {
    console.warn(
      `[webhook/github] received signature but no secret configured for ${project.name}`,
    );
  }

  // Only handle pull_request events with relevant actions
  const action = payload.action as string;
  const pr = payload.pull_request as
    | { number?: number; title?: string; head?: { ref?: string } }
    | undefined;

  if (!pr || !['opened', 'reopened', 'ready_for_review'].includes(action)) {
    json(res, 200, { ignored: true, reason: `unhandled action: ${action}` });
    return;
  }

  const prNumber = pr.number;
  const prTitle = pr.title || '';
  const headBranch = pr.head?.ref || '';

  console.log(
    `[webhook/github] PR #${prNumber} ${action} on ${repoFullName} (branch: ${headBranch}, title: ${prTitle})`,
  );

  // Check auto_dispatch (default true)
  if (project.webhooks?.auto_dispatch === false) {
    console.log(`[webhook/github] auto_dispatch disabled for ${project.name}, skipping queue`);
    json(res, 200, { ignored: true, reason: 'auto_dispatch disabled' });
    return;
  }

  const flowType: FlowType = 'review-pr';
  const ticketOrPr = `${repoFullName}#${prNumber}`;

  const item = addItem(
    {
      flowType,
      project: project.name,
      ticketOrPr,
      priority: 10,
    },
    WEBHOOK_WORK_ORIGINATORS.github,
  );

  console.log(
    `[webhook/github] queued ${flowType} for ${ticketOrPr} (queue item ${item.id.slice(0, 8)})`,
  );
  json(res, 200, { queued: true, itemId: item.id, flowType, project: project.name, ticketOrPr });
}

// ─── Jira webhook ───

export async function handleJiraWebhook(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readBody(req);
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(body.toString());
  } catch {
    json(res, 400, { error: 'Invalid JSON' });
    return;
  }

  // Extract issue data
  const issue = payload.issue as
    | { key?: string; fields?: { issuetype?: { name?: string }; summary?: string } }
    | undefined;
  if (!issue?.key) {
    json(res, 400, { error: 'Missing issue.key' });
    return;
  }

  const issueKey = issue.key;
  const issueType = issue.fields?.issuetype?.name || '';
  const summary = issue.fields?.summary || '';

  // Match project by Jira key prefix
  const projects = await loadProjectConfigs();
  const project = matchProjectByJiraKey(projects, issueKey);
  if (!project) {
    console.log(`[webhook/jira] no project matches issue ${issueKey}`);
    json(res, 200, { ignored: true, reason: `no project for issue ${issueKey}` });
    return;
  }

  // Validate Jira secret if configured
  const secret = project.webhooks?.jira_secret;
  if (secret) {
    const authHeader = req.headers['authorization'] as string | undefined;
    if (!authHeader || authHeader !== `Bearer ${secret}`) {
      console.warn(`[webhook/jira] auth failed for ${issueKey}`);
      json(res, 401, { error: 'Invalid authorization' });
      return;
    }
  }

  // Check for status transition to "Ready for Dev" (or similar)
  const changelog = payload.changelog as
    | { items?: Array<{ field?: string; toString?: string }> }
    | undefined;
  const statusChange = changelog?.items?.find((item) => item.field === 'status');
  if (!statusChange) {
    json(res, 200, { ignored: true, reason: 'no status change' });
    return;
  }

  const newStatus = statusChange.toString || '';
  console.log(
    `[webhook/jira] ${issueKey} (${issueType}) status -> "${newStatus}" (summary: ${summary})`,
  );

  // Only dispatch for Bug issue types
  if (issueType !== 'Bug') {
    json(res, 200, { ignored: true, reason: `issue type "${issueType}" is not Bug` });
    return;
  }

  // Check auto_dispatch (default true)
  if (project.webhooks?.auto_dispatch === false) {
    console.log(`[webhook/jira] auto_dispatch disabled for ${project.name}, skipping queue`);
    json(res, 200, { ignored: true, reason: 'auto_dispatch disabled' });
    return;
  }

  const flowType: FlowType = 'fix-bug';
  const item = addItem(
    {
      flowType,
      project: project.name,
      ticketOrPr: issueKey,
      priority: 10,
    },
    WEBHOOK_WORK_ORIGINATORS.jira,
  );

  console.log(
    `[webhook/jira] queued ${flowType} for ${issueKey} (queue item ${item.id.slice(0, 8)})`,
  );
  json(res, 200, {
    queued: true,
    itemId: item.id,
    flowType,
    project: project.name,
    ticketOrPr: issueKey,
  });
}
