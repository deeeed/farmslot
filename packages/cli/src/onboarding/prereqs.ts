// onboarding/prereqs.ts — prerequisite + runner detection shared by doctor and install.sh.
import { spawnSync } from 'node:child_process';
import { accessSync, constants, readFileSync } from 'node:fs';
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

/**
 * Parse the minimum version out of an engines range like ">=22.12.0", "^22",
 * "22.15.0". Lower bound only — upper bounds (caret/tilde ceilings) are
 * intentionally ignored; onboarding only enforces "at least this version".
 */
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

export const KNOWN_RUNNERS = ['claude', 'codex', 'cursor-agent', 'grok'] as const;

/** Runner state: missing from PATH, installed but not signed in, or ready to work. */
export type RunnerStatus = 'missing' | 'inactive' | 'authenticated';

export interface RunnerResult {
  name: string;
  found: boolean;
  status: RunnerStatus;
}

const RUNNER_INSTALL_HINTS: Record<string, string> = {
  claude: 'npm install -g @anthropic-ai/claude-code',
  codex: 'npm install -g @openai/codex',
  'cursor-agent': 'see https://cursor.com/cli',
  grok: 'install Grok CLI, then run grok login',
};

const RUNNER_LOGIN_HINTS: Record<string, string> = {
  claude: 'run: claude (sign in interactively)',
  codex: 'run: codex login',
  'cursor-agent': 'run: cursor-agent login',
  grok: 'run: grok login',
};

// Probes run for all runners on every doctor pass — keep the hang ceiling low.
const AUTH_PROBE_TIMEOUT_MS = 5_000;

// PATH entries that belong to a version manager's shim layer. A shim for a runner
// that is not installed under the *active* runtime errors ("No version is set",
// exit 126/127) instead of answering, and shadows a real install further down PATH
// (e.g. ~/.npm-global/bin). We re-resolve outside these to find the working binary.
const SHIM_PATH_MARKERS = ['/.asdf/shims', '/.asdf/bin', '/.nvm/'];

/** PATH with version-manager shim dirs removed (the "default" the user's shell uses). */
function defaultRunnerPath(): string {
  return (process.env.PATH ?? '')
    .split(':')
    .filter((dir) => dir && !SHIM_PATH_MARKERS.some((marker) => dir.includes(marker)))
    .join(':');
}

/** Resolve an executable on the default (shim-free) PATH. */
function resolveOutsideShims(name: string): string | null {
  for (const dir of defaultRunnerPath().split(':')) {
    if (!dir) continue;
    const candidate = join(dir, name);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Not an executable here — keep scanning. (Expected: most PATH dirs lack it.)
    }
  }
  return null;
}

/** Auth probe per runner. Exit 0 + the expected marker = authenticated. */
function probeRunnerAuth(name: string): boolean {
  // Markers are mirrored by install.sh's bash probe — keep both in sync.
  const probes: Record<string, { args: string[]; marker: RegExp }> = {
    claude: { args: ['auth', 'status'], marker: /"loggedin":\s*true/i },
    codex: { args: ['login', 'status'], marker: /logged in (as|using)/i },
    'cursor-agent': { args: ['status'], marker: /logged in (as|using)/i },
    grok: { args: ['models'], marker: /logged in/i },
  };
  const probe = probes[name];
  if (!probe) return false;
  // Resolve the real binary from the default (shim-free) PATH and run it under that
  // PATH, so its node/runtime also resolves to the working install rather than a
  // broken asdf/nvm shim that would error ("No version is set") and shadow it.
  const runnerPath = defaultRunnerPath();
  const bin = resolveOutsideShims(name) ?? name;
  const result = spawnSync(bin, probe.args, {
    encoding: 'utf-8',
    timeout: AUTH_PROBE_TIMEOUT_MS,
    env: { ...process.env, PATH: runnerPath },
    // stdin from /dev/null: some runner CLIs (e.g. `claude auth status`) block reading
    // a non-TTY stdin and would otherwise hang until the timeout, reading as inactive.
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error || result.status !== 0) return false;
  return probe.marker.test(`${result.stdout}\n${result.stderr}`);
}

export function detectRunners(): RunnerResult[] {
  return KNOWN_RUNNERS.map((name) => {
    if (!commandExists(name)) return { name, found: false, status: 'missing' as const };
    return {
      name,
      found: true,
      status: probeRunnerAuth(name) ? ('authenticated' as const) : ('inactive' as const),
    };
  });
}

export function runnerHint(name: string, status: RunnerStatus = 'missing'): string {
  if (status === 'inactive') return RUNNER_LOGIN_HINTS[name] ?? '';
  return RUNNER_INSTALL_HINTS[name] ?? '';
}
