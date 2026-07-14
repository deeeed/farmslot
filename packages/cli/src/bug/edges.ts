// edges.ts — spawned side-effect edges for the bug pipeline. gh / claude are
// spawned CLIs (they carry their own auth/session); Jira and image downloads go
// through curl (kept as a spawned edge). Every edge fails loudly — no swallowed
// stderr, no `|| true` — so a real auth/network failure surfaces instead of
// masquerading as "no data".

import { execFile } from 'node:child_process';
import { stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// gh/Jira responses and image bytes can be large; give the child a roomy buffer.
const MAX_BUFFER = 32 * 1024 * 1024;

function edgeError(tool: string, code: string, err: unknown): Error {
  const e = err as { stderr?: string; message?: string };
  const detail = (e.stderr || e.message || String(err)).trim();
  return Object.assign(new Error(`${tool} failed: ${detail}`), {
    code,
    userAction: `Ensure \`${tool}\` is installed and authenticated, then re-run.`,
  });
}

/** Run `gh` with the given args and return stdout. Throws loudly on non-zero exit. */
export async function ghJson(args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync('gh', args, { maxBuffer: MAX_BUFFER });
    return stdout;
  } catch (err) {
    throw edgeError('gh', 'GH_FAILED', err);
  }
}

/** Fetch a GitHub issue as raw JSON for parseBugInput. */
export function fetchGitHubIssue(repo: string, number: string): Promise<string> {
  return ghJson(['issue', 'view', number, '--repo', repo, '--json', 'title,body,labels,state,url']);
}

/** Fetch a Jira issue via curl basic auth. `fields` is the REST `fields=` list. */
export async function fetchJiraIssue(
  baseUrl: string,
  key: string,
  fields: string,
  email: string,
  token: string,
): Promise<string> {
  return curlGet(`${baseUrl}/rest/api/3/issue/${key}?fields=${fields}`, {
    basicAuth: `${email}:${token}`,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** GET a URL via curl (loud: --fail-with-body, -sS). Returns the response body. */
export async function curlGet(
  url: string,
  opts: { basicAuth?: string; headers?: Record<string, string> } = {},
): Promise<string> {
  const args = ['--fail-with-body', '-sS', '-L'];
  if (opts.basicAuth) args.push('-u', opts.basicAuth);
  for (const [key, value] of Object.entries(opts.headers ?? {}))
    args.push('-H', `${key}: ${value}`);
  args.push(url);
  try {
    const { stdout } = await execFileAsync('curl', args, { maxBuffer: MAX_BUFFER });
    return stdout;
  } catch (err) {
    throw edgeError('curl', 'CURL_FAILED', err);
  }
}

/**
 * Download a URL to `dir/filename` via curl. Returns the filename on success, or
 * null when the download produced an empty file (which is removed). Auth is
 * optional (Jira attachments need it; public GitHub assets do not).
 */
export async function curlDownload(
  url: string,
  dir: string,
  filename: string,
  opts: { basicAuth?: string; headers?: Record<string, string> } = {},
): Promise<string | null> {
  const dest = path.join(dir, filename);
  const args = ['-L', '-sS', '--fail-with-body', '-o', dest];
  if (opts.basicAuth) args.push('-u', opts.basicAuth);
  for (const [key, value] of Object.entries(opts.headers ?? {}))
    args.push('-H', `${key}: ${value}`);
  args.push(url);
  try {
    await execFileAsync('curl', args, { maxBuffer: MAX_BUFFER });
  } catch (err) {
    throw edgeError('curl', 'CURL_FAILED', err);
  }
  const size = await stat(dest)
    .then((s) => s.size)
    .catch(() => 0);
  if (size > 0) return filename;
  await unlink(dest).catch(() => undefined);
  return null;
}

/**
 * Run a project scoring script (project.json `scoring.script`, {{INPUT_FILE}}
 * already substituted) from the project directory. Returns its stdout.
 */
export async function runScorer(script: string, projectDir: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync('bash', ['-c', script], {
      cwd: projectDir,
      maxBuffer: MAX_BUFFER,
    });
    return stdout;
  } catch (err) {
    throw edgeError('scoring script', 'SCORER_FAILED', err);
  }
}

/** Call the `claude` CLI with a prompt and model, returning the text response. */
export async function runClaude(prompt: string, model: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync(
      'claude',
      ['-p', prompt, '--model', model, '--output-format', 'text'],
      { maxBuffer: MAX_BUFFER },
    );
    return stdout;
  } catch (err) {
    throw edgeError('claude', 'CLAUDE_FAILED', err);
  }
}
