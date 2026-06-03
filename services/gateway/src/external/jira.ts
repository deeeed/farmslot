// external/jira.ts — Jira REST API client
// Auth via per-project env vars defined in project.json:
//   jira.email_env (default: JIRA_EMAIL)
//   jira.api_token_env (default: JIRA_API_TOKEN)

import type { RunTicketData } from '@farmslot/protocol';

export interface JiraConfig {
  baseUrl: string;
  emailEnv?: string; // env var name for email (default: JIRA_EMAIL)
  apiTokenEnv?: string; // env var name for token (default: JIRA_API_TOKEN)
}

interface JiraIssue {
  key: string;
  fields: {
    summary: string;
    description: any; // ADF document
    status: { name: string };
    issuetype: { name: string };
    labels: string[];
    components: Array<{ name: string }>;
    attachment?: Array<{ filename: string; mimeType: string; content: string }>;
  };
}

export async function fetchJiraComments(issueKey: string, config: JiraConfig): Promise<string[]> {
  const { email, token } = resolveJiraAuth(config);
  if (!email || !token) return [];

  const auth = Buffer.from(`${email}:${token}`).toString('base64');
  const url = `${config.baseUrl}/rest/api/3/issue/${issueKey}/comment?maxResults=10&orderBy=-created`;

  const res = await fetch(url, {
    headers: { Authorization: `Basic ${auth}`, Accept: 'application/json' },
  });

  if (!res.ok) {
    console.warn(`[jira] failed to fetch comments for ${issueKey}: ${res.status}`);
    return [];
  }

  const data = (await res.json()) as {
    comments: Array<{
      author: { displayName: string };
      created: string;
      body: any; // ADF document
    }>;
  };

  const formatted = data.comments.map((c) => {
    const date = c.created.slice(0, 10); // YYYY-MM-DD
    const text = extractAdfText(c.body);
    return `${c.author.displayName} (${date}): ${text}`;
  });

  // API returns newest-first, reverse to chronological
  return formatted.reverse();
}

export async function fetchJiraIssue(
  issueKey: string,
  config: JiraConfig,
  opts?: { includeComments?: boolean },
): Promise<Partial<RunTicketData>> {
  // Resolve credentials: project env vars → MCP config fallback
  const { email, token } = resolveJiraAuth(config);
  if (!email || !token) {
    console.warn(`[jira] no credentials found — skipping Jira fetch`);
    return {};
  }

  const auth = Buffer.from(`${email}:${token}`).toString('base64');
  const url = `${config.baseUrl}/rest/api/3/issue/${issueKey}?fields=summary,description,status,issuetype,labels,components,attachment`;

  const res = await fetch(url, {
    headers: { Authorization: `Basic ${auth}`, Accept: 'application/json' },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Jira API error: ${res.status} ${res.statusText} — ${body.slice(0, 200)}`);
  }

  const issue = (await res.json()) as JiraIssue;

  // Extract text from ADF description
  const description = extractAdfText(issue.fields.description);
  const ac = extractSection(description, [
    'acceptance criteria',
    'expected behavior',
    'expected result',
  ]);
  const area = extractSection(description, ['affected area', 'component', 'affected component']);
  const steps = extractSection(description, [
    'steps to reproduce',
    'repro steps',
    'reproduction steps',
  ]);

  const screenshots = (issue.fields.attachment ?? [])
    .filter((a) => a.mimeType.startsWith('image/'))
    .map((a) => a.filename);

  const result: Partial<RunTicketData> = {
    source: 'jira',
    issueType: issue.fields.issuetype?.name,
    title: issue.fields.summary,
    description,
    acceptanceCriteria: ac ? ac.split('\n').filter(Boolean) : [],
    affectedArea: area || issue.fields.components.map((c) => c.name).join(', '),
    stepsToReproduce: steps ? steps.split('\n').filter(Boolean) : [],
    screenshots,
    labels: issue.fields.labels,
    jiraKey: issueKey,
  };

  if (opts?.includeComments !== false) {
    const comments = await fetchJiraComments(issueKey, config);
    if (comments.length > 0) {
      result.comments = comments;
    }
  }

  return result;
}

export async function downloadJiraAttachments(
  issueKey: string,
  outputDir: string,
  config: JiraConfig,
): Promise<string[]> {
  const { email, token } = resolveJiraAuth(config);
  if (!email || !token) return [];

  const baseUrl = config.baseUrl.replace(/\/$/, '');
  const authHeader = 'Basic ' + Buffer.from(`${email}:${token}`).toString('base64');

  const res = await fetch(`${baseUrl}/rest/api/3/issue/${issueKey}?fields=attachment`, {
    headers: { Authorization: authHeader, Accept: 'application/json' },
  });
  if (!res.ok) return [];

  const issue = (await res.json()) as {
    fields: { attachment?: Array<{ filename: string; mimeType: string; content: string }> };
  };
  const images = (issue.fields.attachment ?? []).filter((a) => a.mimeType.startsWith('image/'));
  if (images.length === 0) return [];

  const { mkdir, writeFile } = await import('node:fs/promises');
  await mkdir(outputDir, { recursive: true });

  const downloaded: string[] = [];
  for (const img of images) {
    try {
      const dlRes = await fetch(img.content, {
        headers: { Authorization: authHeader },
      });
      if (!dlRes.ok) continue;
      const buffer = Buffer.from(await dlRes.arrayBuffer());
      const outPath = `${outputDir}/${img.filename}`;
      await writeFile(outPath, buffer);
      downloaded.push(img.filename);
      console.log(`[jira] downloaded ${img.filename} (${buffer.length} bytes)`);
    } catch (err) {
      console.warn(`[jira] failed to download ${img.filename}: ${(err as Error).message}`);
    }
  }
  return downloaded;
}

function resolveJiraAuth(config: JiraConfig): {
  email: string | undefined;
  token: string | undefined;
} {
  const emailVar = config.emailEnv || 'JIRA_EMAIL';
  const tokenVar = config.apiTokenEnv || 'JIRA_API_TOKEN';
  return {
    email: process.env[emailVar],
    token: process.env[tokenVar],
  };
}

function extractAdfText(node: any): string {
  if (!node) return '';
  if (typeof node === 'string') return node;
  if (node.type === 'text') return node.text || '';
  if (node.type === 'hardBreak') return '\n';
  // Leaf nodes that carry URLs/labels — must be rendered, not dropped.
  // Without these, Jira descriptions that embed GitHub/Figma/PR previews lose
  // all actionable context when serialized to plain text for TASK.md.
  if (node.type === 'inlineCard' || node.type === 'blockCard') {
    return node.attrs?.url || '';
  }
  if (node.type === 'mention') {
    const text = node.attrs?.text || node.attrs?.displayName || node.attrs?.id;
    return text ? `@${String(text).replace(/^@/, '')}` : '';
  }
  if (node.type === 'emoji') {
    return node.attrs?.shortName || node.attrs?.text || '';
  }
  if (node.type === 'status') {
    return node.attrs?.text ? `[${node.attrs.text}]` : '';
  }
  if (node.type === 'date') {
    const ts = Number(node.attrs?.timestamp);
    return Number.isFinite(ts) ? new Date(ts).toISOString().slice(0, 10) : '';
  }
  if (Array.isArray(node.content)) {
    return node.content.map(extractAdfText).join('');
  }
  return '';
}

function extractSection(text: string, headings: string[]): string {
  for (const h of headings) {
    const pattern = new RegExp(`(?:^|\\n)#+\\s*${h}[:\\s]*\\n([\\s\\S]*?)(?=\\n#|$)`, 'i');
    const match = text.match(pattern);
    if (match) return match[1].trim();
  }
  return '';
}
