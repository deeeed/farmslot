// triage.ts — heuristic triage core shared by `farmslot bug triage` and
// `farmslot bug batch`. Fetches a bug (gh / Jira curl), parses it with the
// protocol cores, runs the project scorer, and writes scores/<key>.json —
// preserving any existing llm/final/validation sections on re-triage.

import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  type BugInput,
  type BugScore,
  deriveScoreKey,
  parseBugInput,
  validateBugScore,
} from '@farmslot/protocol';
import { getProjectField, loadProjectVars, type ProjectVars } from '@farmslot/slot-config';

import { curlDownload, curlGet, fetchGitHubIssue, fetchJiraIssue, runScorer } from './edges.js';
import { isoTimestamp, readScoreFile, type ScoreFile, writeScoreFile } from './score-file.js';

export interface TriageInput {
  github?: string;
  jira?: string;
  input?: string;
  stdinJson?: string;
  project: string;
  scoresDir?: string;
  skipExisting?: boolean;
  downloadImages?: string;
  now: Date;
}

export interface TriageResult {
  skipped: boolean;
  scoreKey: string;
  scoreFile: string;
  issueRef: string;
  heuristic: BugScore | null;
  bugInput?: BugInput;
  downloadedImages?: string[];
}

export interface ProjectContext {
  vars: ProjectVars;
  projectDir: string;
}

export async function loadProjectContext(project: string): Promise<ProjectContext> {
  const vars = await loadProjectVars(project);
  return { vars, projectDir: path.dirname(vars.projectConfig) };
}

/** Parse `owner/repo#N` or a full issues URL into repo + number. */
export function parseGithubRef(ref: string): { repo: string; number: string } {
  const url = ref.match(/^https?:\/\/github\.com\/([^/]+\/[^/]+)\/issues\/(\d+)/);
  if (url) return { repo: url[1], number: url[2] };
  const short = ref.match(/^([^#]+)#(\d+)$/);
  if (short) return { repo: short[1], number: short[2] };
  throw Object.assign(new Error(`cannot parse GitHub ref: ${ref}`), {
    code: 'BAD_GITHUB_REF',
    userAction:
      'Pass --github owner/repo#123 or a full https://github.com/owner/repo/issues/123 URL.',
  });
}

/** Derive the score-file key from a raw ref without fetching (skip-existing fast path). */
function keyFromRef(input: TriageInput): string | null {
  if (input.github) return `gh-${parseGithubRef(input.github).number}`;
  if (input.jira) return input.jira.toLowerCase();
  return null;
}

function requireJiraEnv(): { email: string; token: string } {
  const email = process.env.JIRA_EMAIL;
  const token = process.env.JIRA_TOKEN;
  if (!email || !token) {
    throw Object.assign(new Error('JIRA_EMAIL and JIRA_TOKEN environment variables are required'), {
      code: 'JIRA_ENV_MISSING',
      userAction: 'Export JIRA_EMAIL and JIRA_TOKEN, then re-run.',
    });
  }
  return { email, token };
}

/** Resolve the input mode to a BugInput (fetching from gh/Jira when needed). */
async function resolveBugInput(input: TriageInput, ctx: ProjectContext): Promise<BugInput> {
  if (input.github) {
    const { repo, number } = parseGithubRef(input.github);
    return parseBugInput('github', JSON.parse(await fetchGitHubIssue(repo, number)));
  }
  if (input.jira) {
    const baseUrl = getProjectField(ctx.vars.projectJson, 'jira.base_url');
    if (!baseUrl) {
      throw Object.assign(new Error('jira.base_url is not set in project.json'), {
        code: 'JIRA_BASE_URL_MISSING',
        userAction: 'Add jira.base_url to the project.json before triaging Jira issues.',
      });
    }
    const { email, token } = requireJiraEnv();
    const raw = await fetchJiraIssue(
      baseUrl,
      input.jira,
      'summary,description,labels,status,components',
      email,
      token,
    );
    return parseBugInput('jira', JSON.parse(raw));
  }
  const raw = input.stdinJson ?? (await readFile(input.input as string, 'utf8'));
  return JSON.parse(raw) as BugInput;
}

/**
 * Run the project scorer over a bug-input file and return the validated
 * heuristic, or null when the project defines no `scoring.script`.
 */
export async function runScore(
  inputAbsPath: string,
  ctx: ProjectContext,
): Promise<BugScore | null> {
  const scriptTemplate = getProjectField(ctx.vars.projectJson, 'scoring.script');
  if (!scriptTemplate) return null;
  const script = scriptTemplate.replaceAll('{{INPUT_FILE}}', inputAbsPath);
  const output = (await runScorer(script, ctx.projectDir)).trim();
  if (!output) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    throw Object.assign(new Error('scoring script did not emit valid JSON'), {
      code: 'INVALID_SCORE',
      userAction: 'Ensure the project scoring script prints a JSON object to stdout.',
    });
  }
  validateBugScore(parsed);
  return parsed;
}

// GitHub attachment filename derivation ported from download-github-images.sh.
export function githubImageFilename(url: string, issueNumber: string, counter: number): string {
  let name: string;
  try {
    name = path.basename(decodeURIComponent(new URL(url).pathname));
  } catch {
    // A malformed URL / percent-encoding has no usable basename; fall through to
    // the numbered gh-<issue>-<counter> name below rather than fail the download.
    name = '';
  }
  name = name.replace(/[^a-zA-Z0-9._-]/g, '-');
  const bare = name.replace(/\.[^.]*$/, '');
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(bare);
  if (isUuid || !name.includes('.') || name.length < 3) {
    return `gh-${issueNumber}-${counter}.png`;
  }
  return name;
}

async function downloadGithubImages(bug: BugInput, dir: string): Promise<string[]> {
  const number = bug.github_issue.includes('#')
    ? bug.github_issue.split('#').pop()!
    : bug.github_issue;
  const downloaded: string[] = [];
  let counter = 0;
  for (const url of bug.image_urls) {
    counter += 1;
    const filename = githubImageFilename(url, number, counter);
    const saved = await curlDownload(url, dir, filename);
    if (saved) downloaded.push(saved);
  }
  return downloaded;
}

interface JiraAttachment {
  id: string;
  filename: string;
  mimeType?: string;
}

async function downloadJiraImages(
  key: string,
  ctx: ProjectContext,
  dir: string,
): Promise<string[]> {
  const baseUrl = getProjectField(ctx.vars.projectJson, 'jira.base_url');
  if (!baseUrl) {
    throw Object.assign(new Error('jira.base_url is not set in project.json'), {
      code: 'JIRA_BASE_URL_MISSING',
      userAction: 'Add jira.base_url to the project.json before downloading Jira images.',
    });
  }
  const { email, token } = requireJiraEnv();
  const basicAuth = `${email}:${token}`;
  const raw = await curlGet(`${baseUrl}/rest/api/3/issue/${key}?fields=attachment`, {
    basicAuth,
    headers: { Accept: 'application/json' },
  });
  const parsed = JSON.parse(raw) as { fields?: { attachment?: JiraAttachment[] } };
  const attachments = (parsed.fields?.attachment ?? []).filter((a) =>
    (a.mimeType ?? '').startsWith('image/'),
  );
  const downloaded: string[] = [];
  for (const att of attachments) {
    const filename = att.filename.replaceAll(' ', '-').replaceAll("'", '');
    const saved = await curlDownload(
      `${baseUrl}/rest/api/3/attachment/content/${att.id}`,
      dir,
      filename,
      { basicAuth, headers: { 'X-Atlassian-Token': 'no-check', Accept: '*/*' } },
    );
    if (saved) downloaded.push(saved);
  }
  return downloaded;
}

/** Heuristic triage: fetch → parse → score → write scores/<key>.json. */
export async function runTriage(input: TriageInput, ctx: ProjectContext): Promise<TriageResult> {
  const scoresDir = input.scoresDir ?? path.join(ctx.projectDir, 'scores');

  // Skip-existing fast path (github/jira refs only — no fetch needed to key).
  if (input.skipExisting) {
    const key = keyFromRef(input);
    if (key) {
      const scoreFile = path.join(scoresDir, `${key}.json`);
      const existing = await readScoreFile(scoreFile);
      if (existing?.heuristic) {
        return {
          skipped: true,
          scoreKey: key,
          scoreFile,
          issueRef: existing.issue_ref ?? key,
          heuristic: existing.heuristic,
        };
      }
    }
  }

  const bugInput = await resolveBugInput(input, ctx);
  const scoreKey = deriveScoreKey(bugInput);
  const scoreFile = path.join(scoresDir, `${scoreKey}.json`);

  // The scorer reads {{INPUT_FILE}}; stage the bug-input to a temp file.
  const stageDir = await mkdtemp(path.join(tmpdir(), 'farmslot-bug-'));
  const stagedInput = path.join(stageDir, 'bug-input.json');
  await writeFile(stagedInput, JSON.stringify(bugInput, null, 2));
  const heuristic = await runScore(stagedInput, ctx);

  const existing = (await readScoreFile(scoreFile)) ?? {};
  const score: ScoreFile = {
    ...existing,
    issue_ref: bugInput.github_issue || bugInput.jira_key,
    scored_at: isoTimestamp(input.now),
    bug_input: bugInput,
  };
  if (heuristic) score.heuristic = heuristic;
  await writeScoreFile(scoreFile, score);

  let downloadedImages: string[] | undefined;
  if (input.downloadImages) {
    downloadedImages =
      bugInput.source === 'jira'
        ? await downloadJiraImages(bugInput.jira_key, ctx, input.downloadImages)
        : await downloadGithubImages(bugInput, input.downloadImages);
  }

  return {
    skipped: false,
    scoreKey,
    scoreFile,
    issueRef: score.issue_ref ?? scoreKey,
    heuristic,
    bugInput,
    downloadedImages,
  };
}
