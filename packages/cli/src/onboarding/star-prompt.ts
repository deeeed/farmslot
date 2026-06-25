// onboarding/star-prompt.ts — one-time GitHub star prompt (OMX-style).
//
// Shown once per user when gh is installed and authenticated. Skipped without a
// TTY, when already prompted, or when FARMSLOT_NO_STAR_PROMPT is set.
import { spawnSync } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline/promises';

import { profilesPath } from '../gateway-profiles.js';

export const STAR_REPO = 'deeeed/farmslot';

interface StarPromptState {
  prompted_at: string;
}

export function starPromptStatePath(env: NodeJS.ProcessEnv = process.env): string {
  const home = dirname(profilesPath(env));
  return join(home, 'state', 'star-prompt.json');
}

export async function hasBeenPrompted(env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  const path = starPromptStatePath(env);
  try {
    const content = await readFile(path, 'utf-8');
    const state = JSON.parse(content) as StarPromptState;
    return typeof state.prompted_at === 'string';
  } catch {
    return false;
  }
}

export async function markPrompted(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const path = starPromptStatePath(env);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(
    path,
    JSON.stringify({ prompted_at: new Date().toISOString() }, null, 2) + '\n',
    'utf-8',
  );
}

export function isGhInstalled(): boolean {
  const result = spawnSync('gh', ['--version'], {
    encoding: 'utf-8',
    stdio: ['ignore', 'ignore', 'ignore'],
    timeout: 3000,
    windowsHide: true,
  });
  return !result.error && result.status === 0;
}

export function isGhAuthenticated(): boolean {
  const result = spawnSync('gh', ['auth', 'status'], {
    encoding: 'utf-8',
    stdio: ['ignore', 'ignore', 'ignore'],
    timeout: 5000,
    windowsHide: true,
  });
  return !result.error && result.status === 0;
}

export type StarRepoResult = { ok: true } | { ok: false; error: string };

export function starRepo(
  repo: string = STAR_REPO,
  spawnSyncFn: typeof spawnSync = spawnSync,
): StarRepoResult {
  const result = spawnSyncFn('gh', ['repo', 'star', repo], {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 10000,
    windowsHide: true,
  });
  if (result.error) return { ok: false, error: result.error.message };
  if (result.status !== 0) {
    const stderr = (result.stderr || '').trim();
    const stdout = (result.stdout || '').trim();
    return { ok: false, error: stderr || stdout || `gh exited ${result.status}` };
  }
  return { ok: true };
}

function starPromptDisabled(env: NodeJS.ProcessEnv): boolean {
  const v = env.FARMSLOT_NO_STAR_PROMPT;
  return v === '1' || v === 'true';
}

async function askYesNo(question: string, ttyPath?: string): Promise<boolean> {
  const input =
    ttyPath && !process.stdin.isTTY ? createReadStream(ttyPath) : (process.stdin as NodeJS.ReadableStream);
  const rl = createInterface({ input, output: process.stdout });
  try {
    const answer = (await rl.question(question)).trim().toLowerCase();
    return answer === '' || answer === 'y' || answer === 'yes';
  } finally {
    rl.close();
  }
}

export interface MaybePromptGithubStarDeps {
  env?: NodeJS.ProcessEnv;
  stdinIsTTY?: boolean;
  stdoutIsTTY?: boolean;
  ttyPath?: string;
  hasBeenPromptedFn?: (env: NodeJS.ProcessEnv) => Promise<boolean>;
  isGhInstalledFn?: () => boolean;
  isGhAuthenticatedFn?: () => boolean;
  markPromptedFn?: (env: NodeJS.ProcessEnv) => Promise<void>;
  askYesNoFn?: (question: string, ttyPath?: string) => Promise<boolean>;
  starRepoFn?: () => StarRepoResult;
  logFn?: (message: string) => void;
  warnFn?: (message: string) => void;
}

/** True when the interactive question was shown (including if the user declined). */
export async function maybePromptGithubStar(deps: MaybePromptGithubStarDeps = {}): Promise<boolean> {
  const env = deps.env ?? process.env;
  if (starPromptDisabled(env)) return false;

  const ttyPath = deps.ttyPath;
  const stdinIsTTY = deps.stdinIsTTY ?? (ttyPath ? true : Boolean(process.stdin.isTTY));
  const stdoutIsTTY = deps.stdoutIsTTY ?? Boolean(process.stdout.isTTY);
  if (!stdinIsTTY || !stdoutIsTTY) return false;

  const hasBeenPromptedImpl = deps.hasBeenPromptedFn ?? hasBeenPrompted;
  if (await hasBeenPromptedImpl(env)) return false;

  const isGhInstalledImpl = deps.isGhInstalledFn ?? isGhInstalled;
  const isGhAuthenticatedImpl = deps.isGhAuthenticatedFn ?? isGhAuthenticated;
  if (!isGhInstalledImpl() || !isGhAuthenticatedImpl()) return false;

  // Mark before asking so an interrupt still counts as prompted.
  const markPromptedImpl = deps.markPromptedFn ?? markPrompted;
  await markPromptedImpl(env);

  const askYesNoImpl = deps.askYesNoFn ?? askYesNo;
  const approved = await askYesNoImpl(
    '[farmslot] Enjoying farmslot? Star it on GitHub? [Y/n] ',
    ttyPath,
  );
  if (!approved) return true;

  const starRepoImpl = deps.starRepoFn ?? (() => starRepo());
  const star = starRepoImpl();
  if (star.ok) {
    (deps.logFn ?? console.log)('[farmslot] Thanks for the star!');
    return true;
  }
  (deps.warnFn ?? console.warn)(`[farmslot] Could not star repository automatically: ${star.error}`);
  return true;
}

export function starSupportHint(): string | null {
  if (!isGhInstalled() || !isGhAuthenticated()) return null;
  return `Support the project: gh repo star ${STAR_REPO}`;
}