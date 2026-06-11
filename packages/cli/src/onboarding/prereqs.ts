// onboarding/prereqs.ts — prerequisite + runner detection shared by doctor and install.sh.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { repoRoot } from './workspace.js';

export interface PrereqResult {
  name: string;
  found: boolean;
  version: string | null;
  ok: boolean;
  detail: string;
  hint?: string;
}

/** Extract the first semver-ish version from a --version output line. */
export function parseVersionOutput(output: string): string | null {
  const match = output.match(/(\d+)\.(\d+)(?:\.(\d+))?/);
  return match ? `${match[1]}.${match[2]}.${match[3] ?? '0'}` : null;
}

/** Parse the minimum version out of an engines range like ">=22.12.0", "^22", "22.15.0". */
export function parseMinimumVersion(range: string): [number, number, number] | null {
  const match = range.match(/(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
  if (!match) return null;
  return [Number(match[1]), Number(match[2] ?? 0), Number(match[3] ?? 0)];
}

export function versionAtLeast(version: string, minimum: [number, number, number]): boolean {
  const parts = parseMinimumVersion(version);
  if (!parts) return false;
  for (let i = 0; i < 3; i++) {
    if (parts[i] !== minimum[i]) return parts[i] > minimum[i];
  }
  return true;
}

/** Read engines.node from the repo's root package.json. */
export function requiredNodeRange(root: string = repoRoot): string | null {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8')) as {
    engines?: { node?: string };
  };
  return pkg.engines?.node ?? null;
}

function commandVersion(cmd: string, args: string[] = ['--version']): string | null {
  const result = spawnSync(cmd, args, { encoding: 'utf-8' });
  if (result.error || result.status !== 0) return null;
  return parseVersionOutput(`${result.stdout}\n${result.stderr}`);
}

function commandExists(cmd: string): boolean {
  const result = spawnSync('bash', ['-c', `command -v -- '${cmd}'`], { encoding: 'utf-8' });
  return result.status === 0;
}

/** Absolute path of a command on PATH, or null. */
export function commandPath(cmd: string): string | null {
  const result = spawnSync('bash', ['-c', `command -v -- '${cmd}'`], { encoding: 'utf-8' });
  return result.status === 0 ? result.stdout.trim() : null;
}

const INSTALL_HINTS: Record<string, string> = {
  git: 'macOS: xcode-select --install · Linux: apt install git',
  node: 'install via https://nodejs.org or a version manager (asdf/nvm); see .tool-versions',
  yarn: 'corepack enable (ships with node) — repo pins yarn via packageManager',
  tmux: 'macOS: brew install tmux · Linux: apt install tmux',
  python3: 'macOS: brew install python3 · Linux: apt install python3',
};

/** Version flag per tool — tmux only understands -V. */
const VERSION_ARGS: Record<string, string[]> = { tmux: ['-V'] };

export function checkPrereqs(root: string = repoRoot): PrereqResult[] {
  const results: PrereqResult[] = [];

  for (const name of ['git', 'node', 'yarn', 'tmux', 'python3']) {
    const version = commandVersion(name, VERSION_ARGS[name]);
    if (version === null) {
      results.push({
        name,
        found: false,
        version: null,
        ok: false,
        detail: 'not found on PATH',
        hint: INSTALL_HINTS[name],
      });
      continue;
    }
    let ok = true;
    let detail = version;
    if (name === 'node') {
      const range = requiredNodeRange(root);
      const minimum = range ? parseMinimumVersion(range) : null;
      if (minimum && !versionAtLeast(version, minimum)) {
        ok = false;
        detail = `${version} (requires ${range})`;
      }
    }
    results.push({
      name,
      found: true,
      version,
      ok,
      detail,
      hint: ok ? undefined : INSTALL_HINTS[name],
    });
  }
  return results;
}

export const KNOWN_RUNNERS = ['claude', 'codex', 'cursor-agent'] as const;

export interface RunnerResult {
  name: string;
  found: boolean;
}

const RUNNER_HINTS: Record<string, string> = {
  claude: 'npm install -g @anthropic-ai/claude-code',
  codex: 'npm install -g @openai/codex',
  'cursor-agent': 'see https://cursor.com/cli',
};

export function detectRunners(): RunnerResult[] {
  return KNOWN_RUNNERS.map((name) => ({ name, found: commandExists(name) }));
}

export function runnerHint(name: string): string {
  return RUNNER_HINTS[name] ?? '';
}
