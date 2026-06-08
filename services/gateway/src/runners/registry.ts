// runners.ts — Runner definitions and helpers (ADR-023 capability model)
// Capability-based registry: RunnerDefinition exposes runner capabilities; launch-command.ts owns shell command construction.

import path from 'node:path';

import {
  DEFAULT_CLAUDE_MODEL,
  DEFAULT_CURSOR_MODEL,
  type SafetyTier,
  type WorkerSignal,
} from '@farmslot/protocol';

import type { loadSlotVars } from '../core/config.js';
import { execOnSlot } from '../core/exec.js';
import {
  firstWindowTarget,
  resolveTmuxSession,
  shellQuote,
  tmuxSendTextCommand,
  tmuxShellSnippet,
} from '../core/tmux.js';
import { isTerminalWorkerSignal, normalizeWorkerSignal } from '../tasks/worker-signals.js';

/**
 * Env prefix for worker sessions.
 *
 * The asdf shim path is deliberately prepended before the runner starts so
 * every shell the runner opens inherits repo-local `.tool-versions` resolution.
 * Without this, machine-global package-manager installs (notably Homebrew's
 * `node`) can shadow the project-pinned Node version even when the slot
 * fixture injected the correct `.tool-versions` file.
 */
export const WORKER_ENV_PREFIX =
  'export DISABLE_OMC=1 DISABLE_OMX=1; ASDF_SHIMS="${ASDF_DATA_DIR:-$HOME/.asdf}/shims"; if [ -d "$ASDF_SHIMS" ]; then export PATH="$ASDF_SHIMS:$PATH"; fi';

export interface RunnerDefinition {
  id: string;
  defaultLaunchMode: 'interactive' | 'exec';
  processMatchers: string[];
  supportsInteractivePrompt: boolean;
  needsPostLaunchPrompt: boolean;
  supportsTmuxNudges: boolean;
  continueCommand: string | null;
  /** Runner writes session files on disk (e.g. resumable session state). */
  persistsSessionFiles: boolean;
  /** Runner's TUI can show a busy "composer" pane that swallows send-keys — poll before sending. */
  requiresBusyComposerPoll: boolean;
  /**
   * Per-tier CLI flags appended to the runner binary (ADR-023). Every tier maps to
   * an explicit list so callers never branch on runner-id when selecting flags —
   * the registry lookup picks the right set.
   */
  flagsByTier: Record<SafetyTier, string[]>;
  /**
   * Runner's fallback safety tier (ADR-023). Consulted only when neither the
   * Run nor the project config specified one. Lives on the registry entry so
   * `runnerDefaultSafetyTier()` stays a thin reader instead of another switch.
   */
  defaultSafetyTier: SafetyTier;
  /** Default model used when the operator/project did not provide one. */
  defaultModel: string | null;
  /**
   * Predicate invoked by `runCreate` to reject incompatible runner+model
   * combos at entry. Codex CLI accepts an `--model claude-opus` flag at the
   * binary level but the API rejects it with HTTP 400 ("'opus' not supported
   * with ChatGPT account"). Catching the mismatch synchronously avoids
   * dispatching workers that immediately error out. Only the obvious cross-
   * family case is enforced (Anthropic vs ChatGPT) — anything else passes
   * through and the runner CLI is the source of truth at dispatch time.
   */
  acceptsModel(model: string): boolean;
}

const DEFAULT_RUNNER = 'claude';
const RUNNER_ALIASES: Record<string, string> = {
  'claude-code': 'claude',
};

// Anthropic-family model names (claude). Codex on a ChatGPT account rejects
// these at the API layer ("'opus' is not supported with ChatGPT account"),
// so the cross-runner compat check below uses this prefix set as the deny
// list for codex and the allow set for claude.
const CLAUDE_MODEL_PREFIXES = /^(claude|opus|sonnet|haiku)\b/i;

export const KNOWN_RUNNERS: Record<string, RunnerDefinition> = {
  claude: {
    id: 'claude',
    defaultLaunchMode: 'interactive',
    processMatchers: ['claude'],
    supportsInteractivePrompt: true,
    needsPostLaunchPrompt: true,
    supportsTmuxNudges: true,
    continueCommand: '/continue',
    persistsSessionFiles: true,
    requiresBusyComposerPoll: false,
    // Claude has no "more dangerous" mode beyond --dangerously-skip-permissions,
    // so full-auto and dangerous collapse onto the same flag. Sandboxed drops it.
    flagsByTier: {
      sandboxed: [],
      'full-auto': ['--dangerously-skip-permissions'],
      dangerous: ['--dangerously-skip-permissions'],
    },
    // ADR-023 §3: safety tier is a policy decision, not a runner capability.
    // The intrinsic fallback is sandboxed (safest posture). Projects opt into
    // higher tiers via project.json `default_safety_tier`.
    defaultSafetyTier: 'sandboxed',
    defaultModel: DEFAULT_CLAUDE_MODEL,
    acceptsModel: (model) => model === 'unknown' || CLAUDE_MODEL_PREFIXES.test(model),
  },
  codex: {
    id: 'codex',
    defaultLaunchMode: 'interactive',
    processMatchers: ['codex'],
    supportsInteractivePrompt: true,
    needsPostLaunchPrompt: true,
    supportsTmuxNudges: true,
    // This string is sent into an already-running Codex TUI when resuming a paused
    // monitor. It must be natural language, not the shell-only `codex --continue`
    // launcher, or the text gets inserted into chat instead of executed by zsh.
    continueCommand: 'Continue the current task from where you left off.',
    persistsSessionFiles: true,
    requiresBusyComposerPoll: true,
    // Codex tier mapping:
    //   sandboxed  — default; Codex CLI prompts for approvals on destructive ops.
    //   full-auto  — `--full-auto`: auto-execute without prompts, sandbox boundary intact.
    //   dangerous  — `--dangerously-bypass-approvals-and-sandbox`: bypass sandbox + approvals.
    // The full-auto flag is what keeps CI/self-review/relaunch flows from stalling
    // on approval prompts when the project opts into tier='full-auto'.
    flagsByTier: {
      sandboxed: [],
      'full-auto': ['--full-auto'],
      dangerous: ['--dangerously-bypass-approvals-and-sandbox'],
    },
    // ADR-023 §3: safety tier is a policy decision, not a runner capability.
    // The intrinsic fallback is sandboxed (safest posture). Projects opt into
    // higher tiers via project.json `default_safety_tier`.
    defaultSafetyTier: 'sandboxed',
    defaultModel: 'gpt-5.5',
    acceptsModel: (model) => model === 'unknown' || !CLAUDE_MODEL_PREFIXES.test(model),
  },
  cursor: {
    id: 'cursor',
    defaultLaunchMode: 'interactive',
    processMatchers: ['(^|/)(cursor-)?agent($| )'],
    // Cursor Agent's normal Farmslot path is the interactive TUI. Unlike Codex,
    // Cursor must be launched with no argv task prompt; Farmslot sends the task
    // after the TUI input handler is live so humans can inspect/steer the pane.
    supportsInteractivePrompt: true,
    needsPostLaunchPrompt: true,
    supportsTmuxNudges: true,
    continueCommand: null,
    persistsSessionFiles: false,
    requiresBusyComposerPoll: false,
    flagsByTier: {
      sandboxed: ['--sandbox', 'enabled'],
      'full-auto': ['--force', '--sandbox', 'enabled'],
      dangerous: ['--force', '--sandbox', 'disabled'],
    },
    defaultSafetyTier: 'sandboxed',
    defaultModel: DEFAULT_CURSOR_MODEL,
    acceptsModel: (model) => model === 'unknown' || (model?.trim().length ?? 0) > 0,
  },
  opencode: {
    id: 'opencode',
    defaultLaunchMode: 'exec',
    processMatchers: ['opencode'],
    supportsInteractivePrompt: false,
    needsPostLaunchPrompt: false,
    supportsTmuxNudges: false,
    continueCommand: null,
    persistsSessionFiles: false,
    requiresBusyComposerPoll: false,
    flagsByTier: { sandboxed: [], 'full-auto': [], dangerous: [] },
    defaultSafetyTier: 'sandboxed',
    defaultModel: null,
    acceptsModel: () => true,
  },
  none: {
    id: 'none',
    defaultLaunchMode: 'exec',
    processMatchers: [],
    supportsInteractivePrompt: false,
    needsPostLaunchPrompt: false,
    supportsTmuxNudges: false,
    continueCommand: null,
    persistsSessionFiles: false,
    requiresBusyComposerPoll: false,
    flagsByTier: { sandboxed: [], 'full-auto': [], dangerous: [] },
    defaultSafetyTier: 'sandboxed',
    defaultModel: null,
    acceptsModel: () => true,
  },
  fake: {
    id: 'fake',
    defaultLaunchMode: 'exec',
    processMatchers: ['farmslot-fake-runner', 'fake-runner'],
    supportsInteractivePrompt: false,
    needsPostLaunchPrompt: false,
    supportsTmuxNudges: false,
    continueCommand: null,
    persistsSessionFiles: false,
    requiresBusyComposerPoll: false,
    flagsByTier: { sandboxed: [], 'full-auto': [], dangerous: [] },
    defaultSafetyTier: 'sandboxed',
    defaultModel: null,
    acceptsModel: () => true,
  },
};

/**
 * Runner's fallback safety tier (ADR-023). Consulted only when neither the
 * Run nor the project config specified one. The tier lives on each
 * `RunnerDefinition.defaultSafetyTier`, so this helper is a thin registry
 * reader — unknown runners default to sandboxed.
 */
export function runnerDefaultSafetyTier(runnerId?: string | null): SafetyTier {
  if (!isKnownRunner(runnerId)) return 'sandboxed';
  return getRunnerDefinition(runnerId).defaultSafetyTier;
}

export function runnerDefaultModel(runnerId?: string | null): string | null {
  if (!isKnownRunner(runnerId)) return null;
  return getRunnerDefinition(runnerId).defaultModel;
}

/**
 * Resolve the CLI flags a runner should launch with for a given tier. Falls
 * back to the runner's default tier when `tier` is omitted. Unknown runners
 * emit no flags — safer default than borrowing Claude's `--dangerously-*`.
 */
export function runnerFlagsForTier(runnerId: string, tier?: SafetyTier): string[] {
  if (!isKnownRunner(runnerId)) return [];
  const def = getRunnerDefinition(runnerId);
  const effective = tier ?? runnerDefaultSafetyTier(runnerId);
  return def.flagsByTier[effective] ?? [];
}

/**
 * Cross-runner compat check. Codex on a ChatGPT account rejects Anthropic
 * model names with HTTP 400, so `runCreate` calls this to fail fast on
 * obvious mismatches before slot allocation. `'unknown'` passes through —
 * it's a placeholder, not a real model name.
 */
export function runnerSupportsModel(
  runnerId: string | null | undefined,
  model: string | null | undefined,
): boolean {
  if (!model) return true;
  return getRunnerDefinition(runnerId).acceptsModel(model);
}

function isKnownRunner(runnerId?: string | null): boolean {
  if (!runnerId) return false;
  return Object.prototype.hasOwnProperty.call(KNOWN_RUNNERS, normalizeRunner(runnerId));
}

export function normalizeRunner(runnerId?: string | null): string {
  const normalized = (runnerId ?? DEFAULT_RUNNER).trim().toLowerCase();
  return (RUNNER_ALIASES[normalized] ?? normalized) || DEFAULT_RUNNER;
}

export function defaultAlternateReviewRunner(runnerId?: string | null): string {
  const current = normalizeRunner(runnerId);
  return (
    Object.keys(KNOWN_RUNNERS).find(
      (candidate) => candidate !== current && KNOWN_RUNNERS[candidate].supportsInteractivePrompt,
    ) ?? DEFAULT_RUNNER
  );
}

export function getRunnerDefinition(runnerId?: string | null): RunnerDefinition {
  const normalized = normalizeRunner(runnerId);
  const def = KNOWN_RUNNERS[normalized] ?? KNOWN_RUNNERS[DEFAULT_RUNNER];
  if (!def) throw new Error(`Unknown runner: ${runnerId}`);
  return def;
}

export function runnerSupportsInteractivePrompt(runnerId?: string | null): boolean {
  if (!isKnownRunner(runnerId)) return false;
  return getRunnerDefinition(runnerId).supportsInteractivePrompt;
}

export function runnerSupportsTmuxNudges(runnerId?: string | null): boolean {
  if (!isKnownRunner(runnerId)) return false;
  return getRunnerDefinition(runnerId).supportsTmuxNudges;
}

export function runnerLaunchCommandUsesHeadlessPrint(
  runnerId?: string | null,
  launchCommand?: unknown,
): boolean {
  const runner = normalizeRunner(runnerId);
  if (typeof launchCommand !== 'string' || !launchCommand.trim()) return false;
  if (runner !== 'cursor') return false;
  return /(^|\s)--print(\s|$)/.test(launchCommand) || /(^|\s)-p(\s|$)/.test(launchCommand);
}

export function runnerSupportsTmuxNudgesForLaunch(
  runnerId?: string | null,
  launchCommand?: unknown,
): boolean {
  const runner = normalizeRunner(runnerId);
  // Explicit headless Cursor launches are the exception: --print has no live chat prompt
  // behind tmux stdin, so do not send dead keystrokes even though Cursor's normal TUI
  // launch is nudge-capable.
  if (runnerLaunchCommandUsesHeadlessPrint(runner, launchCommand)) return false;
  if (runnerSupportsTmuxNudges(runner)) return true;
  return false;
}

export function runnerTmuxNudgeUnsupportedDescription(
  runnerId?: string | null,
  launchCommand?: unknown,
  violationType?: string,
): string {
  const runner = normalizeRunner(runnerId);
  const reason =
    violationType === 'stuck'
      ? 'has not produced terminal output'
      : violationType === 'idle'
        ? 'appears idle'
        : 'is waiting';
  if (runner === 'cursor' && runnerLaunchCommandUsesHeadlessPrint(runner, launchCommand)) {
    return `Cursor ${reason}, but this lane was launched with cursor-agent --print/headless, so tmux keystrokes cannot reach a live chat prompt. Re-run or resume Cursor instead of using tmux nudge.`;
  }
  return `${runnerId ?? 'runner'} ${reason}, but this launch mode does not support tmux nudges`;
}

export function runnerNeedsPostLaunchPrompt(runnerId?: string | null): boolean {
  if (!isKnownRunner(runnerId)) return false;
  return getRunnerDefinition(runnerId).needsPostLaunchPrompt;
}

export function runnerContinueCommand(runnerId?: string | null): string | null {
  if (!isKnownRunner(runnerId)) return null;
  return getRunnerDefinition(runnerId).continueCommand;
}

export function runnerPersistsSessionFiles(runnerId?: string | null): boolean {
  // Unknown/custom runners are treated as non-session-backed by default so
  // dispatch does not scan ~/.claude|~/.codex for them or attach an unrelated
  // runnerSessionPath to the run. Known built-ins carry their registry flag.
  if (!isKnownRunner(runnerId)) return false;
  return getRunnerDefinition(runnerId).persistsSessionFiles;
}

export function runnerProcessPattern(runnerId?: string | null): RegExp {
  if (!isKnownRunner(runnerId)) {
    const normalized = normalizeRunner(runnerId);
    return normalized ? new RegExp(normalized) : /^$/;
  }
  const matchers = getRunnerDefinition(runnerId).processMatchers;
  if (matchers.length === 0) return /^$/;
  return new RegExp(matchers.join('|'));
}

export function runnerProcessPatternSource(runnerId?: string | null): string {
  const normalized = normalizeRunner(runnerId);
  if (runnerId == null || runnerId === '' || normalized === DEFAULT_RUNNER) {
    // Broad fallback for unknown/legacy slots — callers should prefer an explicit runner
    // whenever available to avoid matching unrelated panes on mixed-runner machines.
    return 'claude|codex|opencode|farmslot-fake-runner|fake-runner';
  }
  if (!isKnownRunner(runnerId)) return normalized;
  const matchers = getRunnerDefinition(runnerId).processMatchers;
  return matchers.length > 0 ? matchers.join('|') : normalized;
}

export function runnerLineLooksWaiting(line: string, runnerId?: string | null): boolean {
  const runner = normalizeRunner(runnerId);
  const value = line.trim();
  if (!value) return false;
  if (runner === 'claude') {
    return (
      value === '❯' ||
      value.startsWith('⏵⏵') ||
      value.endsWith('❯') ||
      (value.includes('Allow') && value.includes('?')) ||
      /^\d+\.\s/.test(value) ||
      /press enter to continue/i.test(value) ||
      /waiting for input/i.test(value)
    );
  }
  if (runner === 'codex' || runner === 'opencode') {
    return (
      value === '›' || value.startsWith('› ') || /continue|resume|waiting|press enter/i.test(value)
    );
  }
  if (runner === 'cursor') {
    return /continue|resume|waiting|press enter|send a message|type a message|plan, search, build anything/i.test(
      value,
    );
  }
  return false;
}

export function runnerPaneLooksIdle(lines: string[], runnerId?: string | null): boolean {
  // Cursor/Claude/Codex can render an input box with several trailing blank or
  // border lines after the actual placeholder. Inspect the last meaningful
  // content lines, not the last raw terminal rows, or post-launch prompt
  // delivery can miss a ready TUI and fail as "not stable".
  const tail = lines
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-8);
  return tail.some((line) => runnerLineLooksWaiting(line, runnerId));
}

export function runnerPaneShowsWorkspaceTrustPrompt(
  pane: string,
  runnerId?: string | null,
): boolean {
  const runner = normalizeRunner(runnerId);
  if (runner !== 'cursor') return false;
  const value = normalizePaneText(pane).toLowerCase();
  return (
    value.includes('[a] trust this workspace') &&
    value.includes('[q] quit') &&
    value.includes('use arrow keys to navigate')
  );
}

export interface RunnerLaunchBlocker {
  kind: 'workspace-trust' | 'auth-required';
  summary: string;
  autoAction: 'cursor-trust-workspace' | null;
}

export function detectRunnerLaunchBlocker(
  pane: string,
  runnerId?: string | null,
): RunnerLaunchBlocker | null {
  if (runnerPaneShowsWorkspaceTrustPrompt(pane, runnerId)) {
    return {
      kind: 'workspace-trust',
      summary:
        'Cursor is waiting for workspace trust confirmation before the chat input is available.',
      autoAction: 'cursor-trust-workspace',
    };
  }

  const lines = normalizePaneText(pane)
    .split('\n')
    .map((line) => line.trim().toLowerCase())
    .filter(Boolean);
  if (lines.some((line) => runnerLineShowsAuthBlocker(line))) {
    return {
      kind: 'auth-required',
      summary: `${normalizeRunner(runnerId)} requires login/authentication before Farmslot can deliver the task prompt.`,
      autoAction: null,
    };
  }

  return null;
}

function runnerLineShowsAuthBlocker(line: string): boolean {
  // Optional MCP integrations can print warnings like
  // "The sentry MCP server is not logged in. Run codex mcp login sentry" while
  // the runner TUI itself is ready. Treat auth blockers line-by-line and ignore
  // MCP warnings so an unrelated "MCP failed" line elsewhere in the pane cannot
  // combine with an optional "mcp login" hint into a false runner-auth failure.
  if (/\bmcp\b/.test(line)) return false;
  return (
    /\b(login|log in|authenticate|authentication|auth)\b/.test(line) &&
    /\b(expired|required|failed|please|needed|unauthorized|not authenticated|not logged in)\b/.test(
      line,
    )
  );
}

async function writeRunnerLaunchBlockerSnapshot(
  vars: Awaited<ReturnType<typeof loadSlotVars>>,
  relativePath: string,
  content: string,
): Promise<void> {
  const targetPath = path.posix.isAbsolute(relativePath)
    ? relativePath
    : `${vars.remoteRepo}/${relativePath}`;
  const payload = Buffer.from(content, 'utf-8').toString('base64');
  const script = [
    "python3 - <<'PY'",
    'from pathlib import Path',
    'import base64',
    `target = Path(${JSON.stringify(targetPath)})`,
    `target.parent.mkdir(parents=True, exist_ok=True)`,
    `target.write_bytes(base64.b64decode(${JSON.stringify(payload)}))`,
    'PY',
  ].join('\n');
  const result = await execOnSlot(vars, script);
  if (result.exitCode !== 0) {
    throw new Error(
      `Failed to write runner blocker snapshot ${targetPath}: ${result.stderr || result.stdout || `exit ${result.exitCode}`}`,
    );
  }
}

export function paneShowsBusyComposer(pane: string): boolean {
  return (
    /tab to queue message/i.test(pane) ||
    /Working \(/i.test(pane) ||
    /background terminal running/i.test(pane) ||
    // Claude mid-turn spinner — added 2026-05-21 after the mm-3 regression where the new
    // `· Composing…` marker (first appeared in the operator's most recent Claude version
    // upgrade) was not in the busy set, causing nudge send-keys to land while the runner was
    // still composing and Enter to be buffered. Matches spinner-prefixed forms across glyphs.
    /[·*•✶]\s*Composing[…\.]/i.test(pane)
  );
}

function normalizePaneText(value: string): string {
  return value
    .replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
    .replace(/([/-])\s+/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

function instructionNeedle(message: string): string {
  return normalizePaneText(message).slice(0, 160);
}

export function runnerPaneContainsInstruction(pane: string, message: string): boolean {
  const needle = instructionNeedle(message);
  if (!needle) return false;
  return normalizePaneText(pane).includes(needle);
}

export function runnerPaneHasProgressAfterInstruction(pane: string, message: string): boolean {
  const needle = instructionNeedle(message);
  if (!needle) return false;
  const compactPane = normalizePaneText(pane);
  const idx = compactPane.lastIndexOf(needle);
  if (idx === -1) return false;
  const after = compactPane.slice(idx + needle.length);
  return (
    /\b(Working|Running|Reading|Explored|Edited|Editing|Ran|UserPromptSubmit hook|SessionStart hook)\b/i.test(
      after,
    ) || /[•✔✖]\s/.test(after)
  );
}

function paneLineLooksShellPrompt(line: string): boolean {
  return /^[^\s@]+@[^\s]+\s+\S+\s+[%$#]\s*$/.test(line.trim());
}

function runnerPaneShowsCurrentCursorProgress(pane: string, runnerId?: string | null): boolean {
  if (normalizeRunner(runnerId) !== 'cursor') return false;
  const tail = pane
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-12);
  let progressIndex = -1;
  for (let i = tail.length - 1; i >= 0; i--) {
    if (
      /[⠁-⣿⠀]+\s*(Reading|Composing|Working|Editing|Running)\b(?:\s+\d+\s+tokens)?/i.test(
        tail[i] ?? '',
      )
    ) {
      progressIndex = i;
      break;
    }
  }
  if (progressIndex === -1) return false;
  return !tail.slice(progressIndex + 1).some((line) => paneLineLooksShellPrompt(line));
}

export function runnerPaneShowsPromptAccepted(
  pane: string,
  previousPane: string,
  message: string,
  marker: string,
  runnerId?: string | null,
): boolean {
  if (pane === previousPane) return false;
  if (
    runnerPaneShowsCurrentCursorProgress(pane, runnerId) &&
    (runnerPaneContainsInstruction(pane, message) ||
      (marker && paneTailText(pane, 16).includes(marker)))
  ) {
    return true;
  }
  // Seeing the marker alone is not proof that the runner accepted the prompt:
  // Codex can echo the full instruction (including SELF-REVIEW.md/TASK.md) in
  // the live composer while the final Enter was swallowed. Treat that as not
  // accepted so sendRunnerPostLaunchPrompt sends a bare Enter and verifies
  // actual progress instead of leaving the run stuck at an idle prompt.
  if (runnerPaneHasBufferedInstruction(pane, message, runnerId)) return false;
  if (runnerPaneHasProgressAfterInstruction(pane, message)) return true;
  if (marker && pane.includes(marker)) return !runnerPaneLooksIdle(pane.split('\n'), runnerId);
  return !runnerPaneLooksIdle(pane.split('\n'), runnerId);
}

export function runnerPaneHasPendingInstruction(
  pane: string,
  message: string,
  runnerId?: string | null,
): boolean {
  const needle = instructionNeedle(message);
  if (!needle) return false;
  const lines = pane
    .replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const tail = lines.slice(-12).join(' ');
  const compactTail = normalizePaneText(tail);
  const idx = compactTail.lastIndexOf(needle);
  if (idx === -1) return false;
  const runner = normalizeRunner(runnerId);

  // Common model-driver failure: the instruction is visible at the live composer prompt,
  // but no response/progress marker appears after it. A later bare Enter submits it.
  if (runnerPaneHasProgressAfterInstruction(tail, message)) return false;

  if (runner === 'codex') {
    return /(^|\s)›\s/.test(compactTail) && /\bContext\s+\d+%|\bgpt-[\w.-]+\b/i.test(compactTail);
  }
  if (runner === 'cursor') {
    return (
      /plan, search, build anything|composer\s+\d/i.test(compactTail) &&
      compactTail.includes(needle)
    );
  }
  if (runner === 'claude') {
    return (
      compactTail.includes(needle) && (compactTail.includes('❯') || /ctx:\d+%/i.test(compactTail))
    );
  }
  return false;
}

export function runnerPaneHasBufferedInstruction(
  pane: string,
  message: string,
  runnerId?: string | null,
): boolean {
  if (runnerPaneHasPendingInstruction(pane, message, runnerId)) return true;
  return (
    runnerPaneContainsInstruction(pane, message) &&
    !runnerPaneHasProgressAfterInstruction(pane, message)
  );
}

export function runnerBufferedInstructionSubmitKey(
  pane: string,
  runnerId?: string | null,
): 'Enter' | 'Tab' {
  // Codex's TUI shows "tab to queue message" while the current turn/hooks are
  // still busy. In that state a bare Enter does not submit the visible composer
  // text; it leaves dispatch with a false "prompt delivery failed" even though
  // the prompt is clearly buffered. Use the key the TUI explicitly requests.
  if (normalizeRunner(runnerId) === 'codex' && /tab to queue message/i.test(pane)) {
    return 'Tab';
  }
  return 'Enter';
}

function paneTailText(pane: string, lines = 12): string {
  return pane.split('\n').slice(-lines).join('\n');
}

export function runnerPaneShouldSubmitExistingInstruction(
  pane: string,
  message: string,
  marker: string,
  runnerId?: string | null,
  options: { allowMarkerOnly?: boolean } = {},
): boolean {
  if (runnerPaneHasBufferedInstruction(pane, message, runnerId)) return true;
  if (
    options.allowMarkerOnly !== true ||
    !marker ||
    !paneTailText(pane).includes(marker) ||
    runnerPaneHasProgressAfterInstruction(pane, message)
  ) {
    return false;
  }
  return true;
}

async function captureTmuxPane(
  vars: Awaited<ReturnType<typeof loadSlotVars>>,
  target: string,
  tailLines = 40,
): Promise<string> {
  return (
    await execOnSlot(
      vars,
      tmuxShellSnippet(`capture-pane -p -t ${shellQuote(target)} 2>/dev/null | tail -${tailLines}`),
    )
  ).stdout;
}

async function submitRunnerInstruction(
  vars: Awaited<ReturnType<typeof loadSlotVars>>,
  target: string,
  runner: string,
  message: string,
  logPrefix: string,
  mode: 'send' | 'submit-existing',
): Promise<boolean> {
  if (mode === 'send') {
    await execOnSlot(vars, tmuxSendTextCommand(target, message, { enter: true }));
  } else {
    const pane = await captureTmuxPane(vars, target);
    const submitKey = runnerBufferedInstructionSubmitKey(pane, runner);
    await execOnSlot(
      vars,
      tmuxShellSnippet(`send-keys -t ${shellQuote(target)} ${submitKey} 2>/dev/null`),
    );
  }

  for (let attempt = 1; attempt <= 5; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    const pane = await captureTmuxPane(vars, target);
    if (!runnerPaneHasBufferedInstruction(pane, message, runner)) return true;
    if (attempt < 5) {
      const submitKey = runnerBufferedInstructionSubmitKey(pane, runner);
      console.warn(`[${logPrefix}] instruction appears buffered in ${target}; sending submit key`);
      await execOnSlot(
        vars,
        tmuxShellSnippet(`send-keys -t ${shellQuote(target)} ${submitKey} 2>/dev/null`),
      );
    }
  }

  console.warn(
    `[${logPrefix}] instruction still appears pending in ${target} after submit verification`,
  );
  return false;
}

export async function sendRunnerInstructionSafely(
  vars: Awaited<ReturnType<typeof loadSlotVars>>,
  target: string,
  runnerId: string,
  message: string,
  logPrefix: string,
  timeoutMs = 30000,
  opts: { forceBusyPoll?: boolean } = {},
): Promise<boolean> {
  const runner = normalizeRunner(runnerId);
  const def = getRunnerDefinition(runner);
  // Skip the busy-composer poll iff the runner doesn't require it AND the caller didn't opt
  // in. Most call sites send into an idle prompt where the registry default (Claude: false,
  // codex: true) is correct. The branch-affinity nudge flow targets a Claude session that may
  // be mid-tool-use, where send-keys gets queued or eaten unless we wait for the busy marker
  // to clear — it passes `forceBusyPoll: true` to override the per-runner default.
  if (!def.requiresBusyComposerPoll && !opts.forceBusyPoll) {
    const pane = await captureTmuxPane(vars, target);
    if (runnerPaneHasPendingInstruction(pane, message, runner)) {
      return submitRunnerInstruction(vars, target, runner, message, logPrefix, 'submit-existing');
    }
    return submitRunnerInstruction(vars, target, runner, message, logPrefix, 'send');
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const pane = await captureTmuxPane(vars, target);
    if (runnerPaneHasPendingInstruction(pane, message, runner)) {
      return submitRunnerInstruction(vars, target, runner, message, logPrefix, 'submit-existing');
    }
    if (runnerPaneContainsInstruction(pane, message)) {
      if (runnerPaneHasProgressAfterInstruction(pane, message)) {
        console.log(
          `[${logPrefix}] instruction already submitted in ${target} — skip duplicate send`,
        );
        return true;
      }
      console.log(`[${logPrefix}] instruction already present in ${target}; sending submit key`);
      return submitRunnerInstruction(vars, target, runner, message, logPrefix, 'submit-existing');
    }
    if (!paneShowsBusyComposer(pane)) {
      return submitRunnerInstruction(vars, target, runner, message, logPrefix, 'send');
    }
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  console.warn(
    `[${logPrefix}] runner ${runner} stayed busy; skipped sending duplicate/queued prompt to ${target}`,
  );
  return false;
}

export async function sendRunnerPostLaunchPrompt(
  vars: Awaited<ReturnType<typeof loadSlotVars>>,
  target: string,
  runnerId: string,
  message: string,
  marker: string,
  logPrefix: string,
  opts: {
    readyTimeoutMs?: number;
    stabilityPolls?: number;
    pollIntervalMs?: number;
    verifyWaitMs?: number;
    maxAttempts?: number;
    blockerSnapshotPath?: string;
    signalPath?: string;
  } = {},
): Promise<void> {
  const runner = normalizeRunner(runnerId);
  const readyTimeoutMs = opts.readyTimeoutMs ?? 30_000;
  const stabilityPolls = opts.stabilityPolls ?? 3;
  const pollIntervalMs = opts.pollIntervalMs ?? 1500;
  const verifyWaitMs = opts.verifyWaitMs ?? 2000;
  const maxAttempts = opts.maxAttempts ?? 3;

  const readyStart = Date.now();
  let lastPane = '';
  let stableCount = 0;
  let ready = false;
  let workspaceTrustAnswered = false;
  const snapshottedBlockers = new Set<string>();
  while (Date.now() - readyStart < readyTimeoutMs) {
    await new Promise((r) => setTimeout(r, pollIntervalMs));
    const pane = (
      await execOnSlot(
        vars,
        tmuxShellSnippet(`capture-pane -p -t ${shellQuote(target)} 2>/dev/null`),
      )
    ).stdout;
    const blocker = detectRunnerLaunchBlocker(pane, runner);
    if (blocker && opts.blockerSnapshotPath && !snapshottedBlockers.has(blocker.kind)) {
      await writeRunnerLaunchBlockerSnapshot(
        vars,
        opts.blockerSnapshotPath,
        [
          `runner=${runner}`,
          `target=${target}`,
          `repo=${vars.remoteRepo}`,
          `kind=${blocker.kind}`,
          `summary=${blocker.summary}`,
          `capturedAt=${new Date().toISOString()}`,
          '',
          pane,
        ].join('\n'),
      );
      snapshottedBlockers.add(blocker.kind);
    }
    if (blocker?.autoAction === 'cursor-trust-workspace' && !workspaceTrustAnswered) {
      const trustResult = await execOnSlot(
        vars,
        tmuxShellSnippet(`send-keys -t ${shellQuote(target)} a 2>/dev/null`),
      );
      if (trustResult.exitCode !== 0) {
        throw new Error(
          `Failed to accept Cursor workspace trust prompt in ${target}: ${
            trustResult.stderr || trustResult.stdout || `exit ${trustResult.exitCode}`
          }`,
        );
      }
      console.log(
        `[${logPrefix}] accepted Cursor workspace trust prompt for ${target} (${vars.remoteRepo})`,
      );
      workspaceTrustAnswered = true;
      stableCount = 0;
      lastPane = '';
      continue;
    }
    if (blocker) {
      throw new Error(
        `${blocker.summary} Snapshot: ${opts.blockerSnapshotPath ?? 'not configured'}. ` +
          `Prompt delivery aborted before the ${readyTimeoutMs / 1000}s readiness timeout.`,
      );
    }
    if (!runnerPaneLooksIdle(pane.split('\n'), runner)) {
      stableCount = 0;
      lastPane = '';
      continue;
    }
    if (pane === lastPane) {
      stableCount++;
      if (stableCount >= stabilityPolls) {
        ready = true;
        break;
      }
    } else {
      stableCount = 1;
      lastPane = pane;
    }
  }

  if (!ready) {
    const timeoutPane = (
      await execOnSlot(
        vars,
        tmuxShellSnippet(`capture-pane -p -t ${shellQuote(target)} 2>/dev/null | tail -80`),
      )
    ).stdout;
    let snapshotNote = '';
    if (opts.blockerSnapshotPath) {
      try {
        await writeRunnerLaunchBlockerSnapshot(
          vars,
          opts.blockerSnapshotPath,
          [
            `runner=${runner}`,
            `target=${target}`,
            `repo=${vars.remoteRepo}`,
            'kind=ready-timeout',
            `summary=${runner} did not reach a stable ready state before prompt delivery timed out.`,
            `capturedAt=${new Date().toISOString()}`,
            '',
            timeoutPane,
          ].join('\n'),
        );
        snapshotNote = ` Snapshot: ${opts.blockerSnapshotPath}.`;
      } catch (err) {
        snapshotNote = ` Snapshot write failed: ${(err as Error).message}`;
      }
    }
    throw new Error(
      `${runner} did not reach a stable ready state within ${readyTimeoutMs / 1000}s in tmux target ${target}. ` +
        `Prompt delivery aborted to avoid sending into a half-booted runner TUI.${snapshotNote}\n` +
        `Last pane content:\n${timeoutPane}`,
    );
  }

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const preSendPane = (
      await execOnSlot(
        vars,
        tmuxShellSnippet(`capture-pane -p -t ${shellQuote(target)} 2>/dev/null`),
      )
    ).stdout;
    const sendCommand = runnerPaneShouldSubmitExistingInstruction(
      preSendPane,
      message,
      marker,
      runner,
      { allowMarkerOnly: attempt > 1 },
    )
      ? tmuxShellSnippet(
          `send-keys -t ${shellQuote(target)} ${runnerBufferedInstructionSubmitKey(preSendPane, runner)} 2>/dev/null`,
        )
      : tmuxSendTextCommand(target, message, { enter: true });
    const promptResult = await execOnSlot(vars, sendCommand);
    if (promptResult.exitCode !== 0) {
      throw new Error(
        `Failed to send prompt to ${target}: ${promptResult.stderr || promptResult.stdout || `exit ${promptResult.exitCode}`}`,
      );
    }
    await new Promise((r) => setTimeout(r, verifyWaitMs));
    const postPane = (
      await execOnSlot(
        vars,
        tmuxShellSnippet(`capture-pane -p -t ${shellQuote(target)} 2>/dev/null`),
      )
    ).stdout;
    if (runnerPaneShowsPromptAccepted(postPane, lastPane, message, marker, runner)) {
      console.log(
        `[${logPrefix}] prompt delivered to ${target} (attempt ${attempt}/${maxAttempts})`,
      );
      return;
    }
    if (runnerPaneHasBufferedInstruction(postPane, message, runner)) {
      console.log(
        `[${logPrefix}] prompt appears buffered after attempt ${attempt}/${maxAttempts}; retrying with submit key`,
      );
      lastPane = postPane;
      continue;
    }
    console.log(
      `[${logPrefix}] prompt not echoed after attempt ${attempt}/${maxAttempts}, retrying`,
    );
    lastPane = postPane;
  }

  const failurePane = (
    await execOnSlot(
      vars,
      tmuxShellSnippet(`capture-pane -p -t ${shellQuote(target)} 2>/dev/null | tail -80`),
    )
  ).stdout;
  if (opts.signalPath) {
    const signalResult = await execOnSlot(
      vars,
      `cat ${shellQuote(opts.signalPath)} 2>/dev/null`,
      vars.remoteRepo,
    );
    if (signalResult.exitCode === 0 && runnerSignalShowsCompletion(signalResult.stdout)) {
      console.log(
        `[${logPrefix}] prompt delivery verifier missed completed task; accepting ${opts.signalPath}`,
      );
      return;
    }
  }
  let snapshotNote = '';
  if (opts.blockerSnapshotPath) {
    try {
      await writeRunnerLaunchBlockerSnapshot(
        vars,
        opts.blockerSnapshotPath,
        [
          `runner=${runner}`,
          `target=${target}`,
          `repo=${vars.remoteRepo}`,
          'kind=prompt-delivery-failed',
          `summary=Prompt sent ${maxAttempts} times but the pane did not show marker/progress acceptance.`,
          `capturedAt=${new Date().toISOString()}`,
          '',
          failurePane,
        ].join('\n'),
      );
      snapshotNote = ` Snapshot: ${opts.blockerSnapshotPath}.`;
    } catch (err) {
      snapshotNote = ` Snapshot write failed: ${(err as Error).message}`;
    }
  }
  throw new Error(
    `Prompt delivery failed after ${maxAttempts} attempts in tmux target ${target}. ` +
      `The pane did not change, echo "${marker}", or show runner progress, meaning the runner input handler was not live.${snapshotNote}\n` +
      `Last pane content:\n${failurePane}`,
  );
}

export function runnerSignalShowsCompletion(signalText: string): boolean {
  let signal: unknown;
  try {
    signal = JSON.parse(signalText);
  } catch {
    // A missing/incomplete/partially-written signal is expected while workers
    // are still running. It is not completion evidence.
    return false;
  }
  if (!signal || typeof signal !== 'object') return false;
  const result = normalizeWorkerSignal(signal as WorkerSignal);
  return (
    result.ok &&
    isTerminalWorkerSignal(result.signal) &&
    (result.signal.status === 'complete' || result.signal.status === 'done')
  );
}

export async function resolvePrimaryWorkerTarget(
  vars: Awaited<ReturnType<typeof loadSlotVars>>,
  reviewWindow = 'self-review',
): Promise<string> {
  try {
    const session = await resolveTmuxSession(vars.slotId, vars);
    const out = (
      await execOnSlot(
        vars,
        tmuxShellSnippet(
          `list-windows -t ${shellQuote(session)} -F '#{window_index} #{window_name}' 2>/dev/null`,
        ),
      )
    ).stdout.trim();
    const lines = out
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    for (const line of lines) {
      const [index, ...rest] = line.split(/\s+/);
      const name = rest.join(' ');
      if (index && name !== reviewWindow) {
        return `${session}:${index}`;
      }
    }
  } catch {
    // Fall through to legacy target
  }
  const session = await resolveTmuxSession(vars.slotId, vars);
  // base-index-1 hosts (mini.local etc.) have no `${session}:0`, so the
  // legacy fallback would hand the caller a non-existent target. Resolve the
  // actual first window via the shared helper — same pattern dispatch and
  // killAgentInSession use.
  return firstWindowTarget(vars, session);
}

export function stripRunnerNoise(content: string, runnerId?: string | null): string {
  const runner = normalizeRunner(runnerId);
  const lines = content
    .split('\n')
    .map((line) => line.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').trimEnd());

  if (runner === 'claude') {
    return lines
      .filter((line) => !/^─ Worked for /.test(line))
      .filter((line) => !/^⏵/.test(line))
      .filter((line) => !/^─{10,}/.test(line))
      .filter((line) => !/^⏸/.test(line))
      .filter((line) => !/\[OMC#.*\]/.test(line))
      .filter((line) => !/shift\+tab to cycle/i.test(line))
      .join('\n');
  }

  return lines.join('\n');
}
