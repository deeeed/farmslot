// runners.ts — Runner definitions and helpers (ADR-023 capability model)
// Capability-based registry: RunnerDefinition exposes runner capabilities; launch-command.ts owns shell command construction.

import path from 'node:path';

import {
  DEFAULT_CLAUDE_MODEL,
  DEFAULT_CURSOR_MODEL,
  DEFAULT_GROK_MODEL,
  DEFAULT_RUNNER,
  isReviewerWindowName,
  normalizeRunner,
  RUNNER_ALIASES,
  type SafetyTier,
  type WorkerSignal,
} from '@farmslot/protocol';

import { writeAuditRecord } from '../auto-recovery/audit-writer.js';
import type { loadSlotVars } from '../core/config.js';
import { execOnSlot } from '../core/exec.js';
import {
  ensureTmuxWindowMinimumSize,
  firstWindowTarget,
  resolveTmuxPaneId,
  resolveTmuxSession,
  shellQuote,
  tmuxSendTextCommand,
  tmuxShellSnippet,
} from '../core/tmux.js';
import { isTerminalWorkerSignal, normalizeWorkerSignal } from '../tasks/worker-signals.js';

import { claudeHookObservability } from './claude-observability.js';
import {
  buildPendingDegradedAgreementEntry,
  buildRunnerObservabilityAgreementEntry,
  logRunnerObservabilityAgreement,
} from './observability-agreement.js';
import {
  buildObservabilityDegradedIntelligenceAction,
  buildObservabilityDegradedRecovery,
  logObservabilityDegradedRecovery,
} from './observability-degraded.js';
import { runnerActivityIsBusy, runnerObservabilityDirForSlot } from './observability-files.js';
import {
  instructionNeedle,
  normalizeInstructionText,
  runnerPromptDigest,
} from './observability-prompt-digest.js';
import {
  computePromptAcceptedSinceMs,
  isObservabilityReadingAuthoritative,
  RUNNER_HOOK_SAFE_SEND_TIMEOUT_MS,
  RUNNER_PANE_SAFE_SEND_TIMEOUT_MS,
  selectIdleFromObservabilityAndPane,
  selectPendingFromObservabilityAndPane,
} from './observability-send-decision.js';
import { writeRunnerPromptSentinel } from './observability-sentinel.js';
import type {
  ObservabilityReading,
  ObservabilityScope,
  RunnerActivity,
  RunnerObservability,
} from './observability-types.js';
import { readPaneStateFromCapture } from './pane-state-script.js';
import { probeRunnerHandoffAck } from './prompt-delivery-evidence.js';

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
  /** Runner starts with the task in argv and must clear safe launch blockers before dispatch can trust task execution. */
  resolvesPreTaskLaunchBlockers: boolean;
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
  /**
   * How runner liveness is observed. Event-driven runners expose hook/statusline
   * files; pane-only runners rely on tmux capture; none skips observability reads.
   */
  observabilityScope: ObservabilityScope;
  /** Post-send hook heartbeat window for degraded-mode detection (ADR-032). Null skips check. */
  observabilityHeartbeatMs?: number | null;
}

interface PaneClassifierResult {
  state: string;
  confidence: number;
  reason: string;
  suggestedAction?: string;
}

async function classifyRunnerPaneStateBestEffortLazy(opts: {
  runner: string;
  target: string;
  pane: string;
  expected: string;
}): Promise<PaneClassifierResult> {
  const { classifyRunnerPaneStateBestEffort } = await import('./pane-classifier.js');
  return classifyRunnerPaneStateBestEffort(opts);
}

// Canonical id vocabulary lives in @farmslot/protocol (shared with slot-config
// template expansion); re-exported so existing imports keep working.
export { DEFAULT_RUNNER, normalizeRunner, RUNNER_ALIASES };

export function assertSupportedRunnerSpelling(runnerId?: string | null): void {
  if ((runnerId ?? '').trim().toLowerCase() === 'fake') {
    throw new Error("runner 'fake' is no longer supported; use runner 'scripted'");
  }
}

// Anthropic-family model names (claude). Codex on a ChatGPT account rejects
// these at the API layer ("'opus' is not supported with ChatGPT account"),
// so the cross-runner compat check below uses this prefix set as the deny
// list for codex and the allow set for claude.
const CLAUDE_MODEL_PREFIXES = /^(claude|opus|sonnet|haiku|fable)\b/i;

export const KNOWN_RUNNERS: Record<string, RunnerDefinition> = {
  claude: {
    id: 'claude',
    defaultLaunchMode: 'interactive',
    processMatchers: ['claude'],
    supportsInteractivePrompt: true,
    needsPostLaunchPrompt: true,
    resolvesPreTaskLaunchBlockers: false,
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
    observabilityScope: 'event-driven',
    observabilityHeartbeatMs: 5000,
  },
  codex: {
    id: 'codex',
    defaultLaunchMode: 'interactive',
    processMatchers: ['codex'],
    supportsInteractivePrompt: true,
    needsPostLaunchPrompt: true,
    resolvesPreTaskLaunchBlockers: false,
    supportsTmuxNudges: true,
    // This string is sent into an already-running Codex TUI when resuming a paused
    // monitor. It must be natural language, not the shell-only `codex --continue`
    // launcher, or the text gets inserted into chat instead of executed by zsh.
    continueCommand: 'Continue the current task from where you left off.',
    persistsSessionFiles: true,
    requiresBusyComposerPoll: true,
    // Codex tier mapping:
    //   sandboxed  — default; Codex CLI prompts for approvals on destructive ops.
    //   full-auto  — workspace-write sandbox with approval prompts disabled.
    //   dangerous  — `--dangerously-bypass-approvals-and-sandbox`: bypass sandbox + approvals.
    // Keep this as explicit supported flags instead of the removed `--full-auto`
    // shorthand so fresh launches and session resumes use the same safety tier.
    flagsByTier: {
      sandboxed: [],
      'full-auto': ['--sandbox', 'workspace-write', '--ask-for-approval', 'never'],
      dangerous: ['--dangerously-bypass-approvals-and-sandbox'],
    },
    // ADR-023 §3: safety tier is a policy decision, not a runner capability.
    // The intrinsic fallback is sandboxed (safest posture). Projects opt into
    // higher tiers via project.json `default_safety_tier`.
    defaultSafetyTier: 'sandboxed',
    defaultModel: 'gpt-5.5',
    acceptsModel: (model) => model === 'unknown' || !CLAUDE_MODEL_PREFIXES.test(model),
    observabilityScope: 'event-driven',
    observabilityHeartbeatMs: 5000,
  },
  cursor: {
    id: 'cursor',
    defaultLaunchMode: 'interactive',
    processMatchers: ['(^|/)(cursor-)?agent($| )'],
    // Cursor Agent v2026.06.19 leaves tmux-injected prompts buffered/reset at
    // the "Run Everything" composer. Passing the task as argv starts the same
    // steerable TUI turn without the fragile post-launch key path.
    supportsInteractivePrompt: true,
    needsPostLaunchPrompt: false,
    resolvesPreTaskLaunchBlockers: true,
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
    observabilityScope: 'pane-only',
  },
  grok: {
    id: 'grok',
    defaultLaunchMode: 'interactive',
    processMatchers: ['(^|/)grok($| )'],
    // Grok Build's default mode is an interactive TUI. Match Cursor's
    // operator contract: open the pane first, then deliver the task prompt
    // after the live composer is ready. Session persistence points at
    // ~/.grok/sessions so usage extraction can join summary.json to Grok logs.
    supportsInteractivePrompt: true,
    needsPostLaunchPrompt: true,
    resolvesPreTaskLaunchBlockers: false,
    supportsTmuxNudges: true,
    continueCommand: null,
    persistsSessionFiles: true,
    requiresBusyComposerPoll: false,
    flagsByTier: {
      sandboxed: [],
      'full-auto': ['--permission-mode', 'auto'],
      dangerous: ['--permission-mode', 'bypassPermissions'],
    },
    defaultSafetyTier: 'sandboxed',
    defaultModel: DEFAULT_GROK_MODEL,
    acceptsModel: (model) => model === 'unknown' || (model?.trim().length ?? 0) > 0,
    observabilityScope: 'pane-only',
  },
  opencode: {
    id: 'opencode',
    defaultLaunchMode: 'exec',
    processMatchers: ['opencode'],
    supportsInteractivePrompt: false,
    needsPostLaunchPrompt: false,
    resolvesPreTaskLaunchBlockers: false,
    supportsTmuxNudges: false,
    continueCommand: null,
    persistsSessionFiles: false,
    requiresBusyComposerPoll: false,
    flagsByTier: { sandboxed: [], 'full-auto': [], dangerous: [] },
    defaultSafetyTier: 'sandboxed',
    defaultModel: null,
    acceptsModel: () => true,
    observabilityScope: 'none',
  },
  none: {
    id: 'none',
    defaultLaunchMode: 'exec',
    processMatchers: [],
    supportsInteractivePrompt: false,
    needsPostLaunchPrompt: false,
    resolvesPreTaskLaunchBlockers: false,
    supportsTmuxNudges: false,
    continueCommand: null,
    persistsSessionFiles: false,
    requiresBusyComposerPoll: false,
    flagsByTier: { sandboxed: [], 'full-auto': [], dangerous: [] },
    defaultSafetyTier: 'sandboxed',
    defaultModel: null,
    acceptsModel: () => true,
    observabilityScope: 'none',
  },
  scripted: {
    id: 'scripted',
    defaultLaunchMode: 'exec',
    processMatchers: ['farmslot scripted-runner', 'scripted-runner'],
    supportsInteractivePrompt: false,
    needsPostLaunchPrompt: false,
    resolvesPreTaskLaunchBlockers: false,
    supportsTmuxNudges: false,
    continueCommand: null,
    persistsSessionFiles: false,
    requiresBusyComposerPoll: false,
    flagsByTier: { sandboxed: [], 'full-auto': [], dangerous: [] },
    defaultSafetyTier: 'sandboxed',
    defaultModel: null,
    acceptsModel: () => true,
    observabilityScope: 'none',
  },
};

const KNOWN_RUNNER_OBSERVABILITY: Record<string, RunnerObservability> = {
  claude: claudeHookObservability,
  codex: claudeHookObservability,
};

export function getRunnerObservability(runnerId?: string | null): RunnerObservability | null {
  if (!runnerId) return null;
  const def = getRunnerDefinition(runnerId);
  if (def.observabilityScope !== 'event-driven') return null;
  return KNOWN_RUNNER_OBSERVABILITY[normalizeRunner(runnerId)] ?? null;
}

export {
  RUNNER_HOOK_SAFE_SEND_TIMEOUT_MS,
  RUNNER_PANE_SAFE_SEND_TIMEOUT_MS,
} from './observability-send-decision.js';

/**
 * ADR-032 Phase 3: is the pane retired for this runner's send/idle/pending decisions?
 *
 * Hook-only send decisions require an intrinsic capability profile, not a flag: the runner must be
 * `event-driven` with a hook observability provider AND not require the busy-composer pane poll.
 * Claude fits (hooks + `requiresBusyComposerPoll: false`) so its decisions are hook-only and the
 * pane predicates are never consulted for them. Codex keeps `requiresBusyComposerPoll: true` — its
 * TUI buffers input and must poll the pane before sending — so it stays on the pane-fallback path.
 * Pane-only runners (grok/cursor) and `none` have no hook provider and are never retired.
 */
export function isRunnerPaneRetired(runnerId?: string | null): boolean {
  if (!runnerId) return false;
  const def = getRunnerDefinition(runnerId);
  if (def.observabilityScope !== 'event-driven' || !getRunnerObservability(runnerId)) return false;
  return def.requiresBusyComposerPoll !== true;
}

export function resolveSafeSendTimeoutMs(runnerId: string): number {
  const def = getRunnerDefinition(runnerId);
  if (def.observabilityScope === 'event-driven' && getRunnerObservability(runnerId)) {
    return RUNNER_HOOK_SAFE_SEND_TIMEOUT_MS;
  }
  return RUNNER_PANE_SAFE_SEND_TIMEOUT_MS;
}

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
  _runnerId?: string | null,
  launchCommand?: unknown,
): boolean {
  if (typeof launchCommand !== 'string' || !launchCommand.trim()) return false;
  return /(^|\s)--print(\s|$)/.test(launchCommand) || /(^|\s)-p(\s|$)/.test(launchCommand);
}

export function runnerSupportsTmuxNudgesForLaunch(
  runnerId?: string | null,
  launchCommand?: unknown,
): boolean {
  const runner = normalizeRunner(runnerId);
  // Explicit headless launches are the exception: --print has no live chat prompt
  // behind tmux stdin, so do not send dead keystrokes even when the runner's normal TUI
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
  if (runnerLaunchCommandUsesHeadlessPrint(runner, launchCommand)) {
    return `${runner} ${reason}, but this lane was launched with --print/headless, so tmux keystrokes cannot reach a live chat prompt. Re-run or resume the worker instead of using tmux nudge.`;
  }
  return `${runnerId ?? 'runner'} ${reason}, but this launch mode does not support tmux nudges`;
}

export function runnerNeedsPostLaunchPrompt(runnerId?: string | null): boolean {
  if (!isKnownRunner(runnerId)) return false;
  return getRunnerDefinition(runnerId).needsPostLaunchPrompt;
}

export function runnerResolvesPreTaskLaunchBlockers(runnerId?: string | null): boolean {
  if (!isKnownRunner(runnerId)) return false;
  return getRunnerDefinition(runnerId).resolvesPreTaskLaunchBlockers;
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
    return 'claude|codex|opencode|cursor-agent|grok|scripted-runner';
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
  if (runner === 'grok') {
    if (/continue|resume|waiting|press enter|send a message|type a message/i.test(value)) {
      return true;
    }
    // Empty composer only. Grok echoes submitted task text after ❯ while still working;
    // treating that as "waiting for input" causes false monitor violations.
    const composerCore = value.replace(/[│┃]/g, '').trim();
    if (composerCore === '❯' || /^❯\s*$/.test(composerCore)) return true;
    if (/^❯\s+\S/.test(composerCore)) return false;
    return /(^|\s)❯\s*$/.test(composerCore);
  }
  return false;
}

export function grokPaneShowsColdStartSession(pane: string, runnerId?: string | null): boolean {
  if (normalizeRunner(runnerId) !== 'grok') return false;
  return readPaneStateFromCapture(pane, runnerId).launchBlocker === 'cold-start';
}

export function runnerPaneHasDeferredLaunchBlocker(
  pane: string,
  runnerId?: string | null,
  blocker: RunnerLaunchBlocker | null = detectRunnerLaunchBlocker(pane, runnerId),
): boolean {
  return blocker?.defer === true;
}

export function runnerPaneLooksIdle(lines: string[], runnerId?: string | null): boolean {
  // Cursor/Claude/Codex can render an input box with several trailing blank or
  // border lines after the actual placeholder. Inspect the last meaningful
  // content lines, not the last raw terminal rows, or post-launch prompt
  // delivery can miss a ready TUI and fail as "not stable".
  const fullPane = lines.join('\n');
  // Launch blockers (MCP init, session warmup, etc.) can live outside the composer tail.
  if (runnerPaneHasDeferredLaunchBlocker(fullPane, runnerId)) return false;
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
  const value = normalizeInstructionText(pane).toLowerCase();
  return (
    value.includes('[a] trust this workspace') &&
    value.includes('[q] quit') &&
    value.includes('use arrow keys to navigate')
  );
}

function runnerPaneShowsGrokProjectDirectoryPrompt(
  pane: string,
  runnerId?: string | null,
): boolean {
  if (normalizeRunner(runnerId) !== 'grok') return false;
  const value = normalizeInstructionText(pane).toLowerCase();
  return (
    value.includes('run grok build in a project directory') &&
    value.includes('(current)') &&
    value.includes('enter:submit')
  );
}

export interface RunnerLaunchBlocker {
  kind:
    | 'workspace-trust'
    | 'project-directory'
    | 'auth-required'
    | 'mcp-init'
    | 'cold-start'
    | 'usage-limit';
  summary: string;
  autoAction: 'cursor-trust-workspace' | 'grok-select-current-project' | null;
  /** Wait for the blocker to clear instead of failing prompt delivery. */
  defer?: boolean;
}

export function runnerLaunchBlockerAutoActionKey(
  autoAction: RunnerLaunchBlocker['autoAction'],
): 'a' | 'Enter' | null {
  if (autoAction === 'cursor-trust-workspace') return 'a';
  if (autoAction === 'grok-select-current-project') return 'Enter';
  return null;
}

/**
 * Map a high-confidence pane-classifier trust suggestion to a safe tmux key.
 * Prefer the deterministic launch-blocker auto-action when the pane still
 * matches; otherwise fall back to the runner's known trust confirmation key.
 * Returns null when the classifier result is not an actionable trust prompt.
 */
export function keyForClassifierTrustAction(
  classifier: { state: string; confidence: number; suggestedAction?: string },
  runnerId: string | null | undefined,
  pane: string,
): 'a' | 'Enter' | null {
  if (classifier.confidence < 0.8) return null;
  if (classifier.state !== 'trust_prompt') return null;
  if (classifier.suggestedAction !== 'send_yes' && classifier.suggestedAction !== 'send_enter') {
    return null;
  }
  const runner = normalizeRunner(runnerId);
  const blocker = detectRunnerLaunchBlocker(pane, runner);
  const fromBlocker = runnerLaunchBlockerAutoActionKey(blocker?.autoAction ?? null);
  if (fromBlocker) return fromBlocker;
  if (runner === 'cursor') return 'a';
  if (runner === 'grok') return 'Enter';
  return null;
}

export function detectRunnerLaunchBlocker(
  pane: string,
  runnerId?: string | null,
): RunnerLaunchBlocker | null {
  const paneState = readPaneStateFromCapture(pane, runnerId);
  const runner = normalizeRunner(runnerId);
  switch (paneState.launchBlocker) {
    case 'workspace-trust':
      return {
        kind: 'workspace-trust',
        summary:
          'Cursor is waiting for workspace trust confirmation before the chat input is available.',
        autoAction: 'cursor-trust-workspace',
      };
    case 'project-directory':
      return {
        kind: 'project-directory',
        summary:
          'Grok is waiting for project-directory selection before the chat input is available.',
        autoAction: 'grok-select-current-project',
      };
    case 'mcp-init':
      return {
        kind: 'mcp-init',
        summary: 'Runner is still initializing MCP integrations before the composer accepts input.',
        autoAction: null,
        defer: true,
      };
    case 'cold-start':
      return {
        kind: 'cold-start',
        summary: 'Runner session is still warming up before the composer accepts input.',
        autoAction: null,
        defer: true,
      };
    case 'usage-limit':
      return {
        kind: 'usage-limit',
        summary: `${runner} hit a usage/rate limit — the composer will not accept prompts until the limit resets.`,
        autoAction: null,
      };
    case 'auth-required':
      return {
        kind: 'auth-required',
        summary: `${runner} requires login/authentication before Farmslot can deliver the task prompt.`,
        autoAction: null,
      };
    default:
      break;
  }

  // Fallback when pane-state.sh is unavailable in unit tests or minimal captures.
  if (runnerPaneShowsWorkspaceTrustPrompt(pane, runnerId)) {
    return {
      kind: 'workspace-trust',
      summary:
        'Cursor is waiting for workspace trust confirmation before the chat input is available.',
      autoAction: 'cursor-trust-workspace',
    };
  }
  if (runnerPaneShowsGrokProjectDirectoryPrompt(pane, runnerId)) {
    return {
      kind: 'project-directory',
      summary:
        'Grok is waiting for project-directory selection before the chat input is available.',
      autoAction: 'grok-select-current-project',
    };
  }
  const lines = pane
    .split('\n')
    .map((line) => normalizeInstructionText(line).toLowerCase())
    .filter(Boolean);
  if (lines.some((line) => runnerLineShowsAuthBlocker(line))) {
    return {
      kind: 'auth-required',
      summary: `${runner} requires login/authentication before Farmslot can deliver the task prompt.`,
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

/**
 * ADR-032 Phase 3A: three-state read of the live composer. Only the LAST prompt-marker line (the
 * live composer) is inspected; transcript-history echoes above it are ignored. The hook-only send
 * loop uses this as a pre-send safety confirmation — never a send decision.
 *
 * - `'draft'`   — the composer holds text (busy/queued marker via {@link paneShowsBusyComposer}, or
 *                 a non-empty prompt line): a fresh type would concatenate onto it.
 * - `'empty'`   — a bare prompt (optionally trailed by a `ctx:N%` status Claude renders): safe to
 *                 type fresh.
 * - `'unknown'` — no prompt marker found at all: the composer state cannot be POSITIVELY
 *                 determined, so callers MUST hold rather than fresh-type into an unseen buffer
 *                 (fail-closed — a missing marker is not proof of an empty composer).
 */
export type ComposerDraftState = 'draft' | 'empty' | 'unknown';

export function runnerPaneComposerDraftState(
  pane: string,
  runnerId?: string | null,
): ComposerDraftState {
  if (paneShowsBusyComposer(pane)) return 'draft';
  const markers = normalizeRunner(runnerId) === 'codex' ? ['›', '❯'] : ['❯', '›'];
  const lines = pane
    .replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i]!.trimStart();
    const marker = markers.find((m) => line.startsWith(m));
    if (!marker) continue;
    const rest = line.slice(marker.length).trim();
    // Strip only a TRAILING/standalone `ctx:N%` status (the suffix Claude renders on the composer
    // line). A bare prompt — nothing left after the strip — is empty. A draft that merely BEGINS
    // `ctx:N%` (e.g. an operator note) keeps its text and reads as a draft, not empty.
    const withoutStatus = rest.replace(/\s*ctx:\d+%\s*$/i, '').trim();
    return withoutStatus ? 'draft' : 'empty';
  }
  return 'unknown';
}

export function runnerPaneContainsInstruction(pane: string, message: string): boolean {
  const needle = instructionNeedle(message);
  if (!needle) return false;
  return normalizeInstructionText(pane).includes(needle);
}

export function runnerPaneHasProgressAfterInstruction(pane: string, message: string): boolean {
  const needle = instructionNeedle(message);
  if (!needle) return false;
  const compactPane = normalizeInstructionText(pane);
  const idx = compactPane.lastIndexOf(needle);
  if (idx === -1) return false;
  const after = compactPane.slice(idx + needle.length);
  return (
    /\b(Working|Running|Reading|Explored|Edited|Editing|Ran|Starting session|Thinking|Thought|Turn completed|UserPromptSubmit hook|SessionStart hook|Effecting|Pollinating)\b/i.test(
      after,
    ) || /[•✔✖]\s/.test(after)
  );
}

export function runnerPaneHasQueuedInstruction(pane: string, message: string): boolean {
  if (!runnerPaneContainsInstruction(pane, message)) return false;
  const compactPane = normalizeInstructionText(pane).toLowerCase();
  return (
    compactPane.includes('messages to be submitted after next tool call') ||
    compactPane.includes('submitted after next tool call') ||
    compactPane.includes('message queued') ||
    compactPane.includes('queued message') ||
    compactPane.includes('tab to queue message')
  );
}

function claudePaneShowsQueuedInstruction(pane: string, message: string): boolean {
  return runnerPaneHasQueuedInstruction(pane, message);
}

function claudePaneShowsSubmittedInstruction(pane: string, message: string): boolean {
  const needle = instructionNeedle(message);
  if (!needle) return false;
  const compactPane = normalizeInstructionText(pane);
  const idx = compactPane.lastIndexOf(needle);
  if (idx === -1) return false;
  const after = compactPane.slice(idx + needle.length);

  // Claude terminal output is cosmetic and changes often. Do not parse spinner
  // labels as correctness signals. The only terminal distinction we need here is
  // whether the instruction left the live composer and entered transcript
  // history; completion is proven later by signal files/artifacts.
  return /(?:^|\s)❯(?:\s|$)/.test(after) || /\bctx:\d+%\b/i.test(after);
}

function grokComposerTail(pane: string): string {
  const lines = pane.split('\n');
  let start = 0;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*#\d+\s/.test(lines[i] ?? '')) {
      start = i + 1;
    }
  }
  return lines.slice(start).join('\n');
}

function grokPaneShowsSubmittedInstruction(pane: string, message: string): boolean {
  const needle = instructionNeedle(message);
  if (!needle) return false;
  if (runnerPaneHasDeferredLaunchBlocker(pane, 'grok')) return false;
  const compactPane = normalizeInstructionText(pane);
  if (
    !new RegExp(`#\\d+\\s+${needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i').test(compactPane)
  ) {
    return false;
  }
  if (runnerPaneHasProgressAfterInstruction(pane, message)) return true;
  return !runnerPaneHasPendingInstruction(grokComposerTail(pane), message, 'grok');
}

export function runnerPaneShowsSubmittedInstruction(
  pane: string,
  message: string,
  runnerId?: string | null,
): boolean {
  switch (normalizeRunner(runnerId)) {
    case 'claude':
      return claudePaneShowsSubmittedInstruction(pane, message);
    case 'grok':
      return grokPaneShowsSubmittedInstruction(pane, message);
    default:
      return false;
  }
}

/** Pre-send duplicate guard — stricter than post-send acceptance for Grok MCP races. */
export function runnerPaneShowsPreSendDuplicateInstruction(
  pane: string,
  message: string,
  runnerId?: string | null,
): boolean {
  const runner = normalizeRunner(runnerId);
  if (runner === 'grok') {
    if (
      runnerPaneShowsCurrentInteractiveProgress(pane, runner) &&
      runnerPaneContainsInstruction(pane, message)
    ) {
      return true;
    }
    return false;
  }
  return (
    runnerPaneShowsCurrentInteractiveProgress(pane, runner) &&
    runnerPaneContainsInstruction(pane, message)
  );
}

function paneLineLooksShellPrompt(line: string): boolean {
  return /^[^\s@]+@[^\s]+\s+\S+\s+[%$#]\s*$/.test(line.trim());
}

export function runnerPaneShowsCurrentInteractiveProgress(
  pane: string,
  runnerId?: string | null,
): boolean {
  const runner = normalizeRunner(runnerId);
  if (runner !== 'cursor' && runner !== 'grok' && runner !== 'claude' && runner !== 'codex')
    return false;
  const tail = pane
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-12);
  let progressIndex = -1;
  for (let i = tail.length - 1; i >= 0; i--) {
    if (
      // Codex renders bullet-prefixed progress (`• Working (2m 02s • esc to interrupt)`,
      // `• Explored`, `• Ran …`) with an animated timer rather than the braille spinner,
      // so it shares claude's matcher. Without this, codex progress is never recognized as
      // "task already running" and the readiness gate falsely times out against the timer.
      (runner === 'claude' || runner === 'codex'
        ? /(?:[✻✢✽✶✷✸✹✺✼✣*•]\s*)?(Spinning|Running|Working|Reading|Thinking|Composing|Editing|Explored|Effecting|Pollinating)[…\.]?/i.test(
            tail[i] ?? '',
          ) || /running in the background|esc to interrupt/i.test(tail[i] ?? '')
        : /[⠁-⣿⠀]+\s*(Reading|Composing|Working|Editing|Running|Starting session)\b(?:\s+\d+\s+tokens)?/i.test(
            tail[i] ?? '',
          )) ||
      /\b(Thinking|Thought)\b/i.test(tail[i] ?? '')
    ) {
      progressIndex = i;
      break;
    }
  }
  if (progressIndex === -1) return false;
  return !tail.slice(progressIndex + 1).some((line) => paneLineLooksShellPrompt(line));
}

export function runnerPaneShowsTaskAlreadyRunning(
  pane: string,
  message: string,
  marker: string,
  runnerId?: string | null,
): boolean {
  if (!runnerPaneShowsCurrentInteractiveProgress(pane, runnerId)) return false;
  const tail = paneTailText(pane, 80);
  return runnerPaneContainsInstruction(tail, message) || Boolean(marker && tail.includes(marker));
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
    runnerPaneShowsCurrentInteractiveProgress(pane, runnerId) &&
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
  if (runnerPaneHasQueuedInstruction(pane, message)) return true;
  if (runnerPaneHasBufferedInstruction(pane, message, runnerId)) return false;
  if (runnerPaneShowsSubmittedInstruction(pane, message, runnerId)) return true;
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
  const compactTail = normalizeInstructionText(tail);
  const idx = compactTail.lastIndexOf(needle);
  if (idx === -1) return false;
  const runner = normalizeRunner(runnerId);

  // Common model-driver failure: the instruction is visible at the live composer prompt,
  // but no response/progress marker appears after it. A later bare Enter submits it.
  if (runnerPaneHasProgressAfterInstruction(tail, message)) return false;

  if (runner === 'codex') {
    return /(^|\s)›\s/.test(compactTail) && /\bContext\s+\d+%|\bgpt-[\w.-]+\b/i.test(compactTail);
  }
  if (runner === 'cursor' || runner === 'grok') {
    if (runner === 'cursor') {
      return (
        /plan, search, build anything|composer\s+\d/i.test(compactTail) &&
        compactTail.includes(needle)
      );
    }
    return compactTail.includes(needle) && /(^|\s|[│┃])❯(?:\s|[│┃]|$)/.test(compactTail);
  }
  if (runner === 'claude') {
    if (claudePaneShowsQueuedInstruction(pane, message)) return true;
    if (claudePaneShowsSubmittedInstruction(pane, message)) return false;
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
  if (runnerPaneShowsSubmittedInstruction(pane, message, runnerId)) return false;
  if (runnerPaneHasPendingInstruction(pane, message, runnerId)) return true;
  if (normalizeRunner(runnerId) === 'claude') return false;
  return (
    runnerPaneContainsInstruction(pane, message) &&
    !runnerPaneHasProgressAfterInstruction(pane, message)
  );
}

export function runnerBufferedInstructionSubmitKey(
  pane: string,
  runnerId?: string | null,
): 'Enter' | 'Tab' | 'C-m' {
  // Codex's TUI shows "tab to queue message" while the current turn/hooks are
  // still busy. In that state a bare Enter does not submit the visible composer
  // text; it leaves dispatch with a false "prompt delivery failed" even though
  // the prompt is clearly buffered. Use the key the TUI explicitly requests.
  if (normalizeRunner(runnerId) === 'codex' && /tab to queue message/i.test(pane)) {
    return 'Tab';
  }
  // Cursor Agent v2026.06.19 renders a "Run Everything" composer where tmux's
  // named Enter key can leave the prompt buffered. A carriage return submits
  // the exact same visible prompt reliably.
  if (normalizeRunner(runnerId) === 'cursor') {
    return 'C-m';
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

async function readRunnerActivityFromObservability(
  vars: Awaited<ReturnType<typeof loadSlotVars>>,
  target: string,
  runner: string,
): Promise<ObservabilityReading<RunnerActivity> | null> {
  const observability = getRunnerObservability(runner);
  if (!observability) return null;
  try {
    return await observability.getActivity(vars, target);
  } catch (error) {
    console.warn(
      `[runner-observability] activity read failed for ${vars.slotId}: ${(error as Error).message}`,
    );
    return null;
  }
}

type HookPendingDecision = { kind: 'hook'; pending: boolean } | { kind: 'fallback' };

async function resolvePendingInstructionObsFirst(
  vars: Awaited<ReturnType<typeof loadSlotVars>>,
  target: string,
  runner: string,
  message: string,
  sinceMs: number,
): Promise<HookPendingDecision> {
  const observability = getRunnerObservability(runner);
  if (!observability) return { kind: 'fallback' };
  try {
    const reading = await observability.promptAccepted(
      vars,
      target,
      runnerPromptDigest(message),
      sinceMs,
    );
    if (!isObservabilityReadingAuthoritative(reading)) return { kind: 'fallback' };
    // Accepted digest still needs pane confirmation — live composer can override stale hooks.
    if (reading.value === true) return { kind: 'fallback' };
    return { kind: 'hook', pending: true };
  } catch (error) {
    console.warn(
      `[runner-observability] promptAccepted read failed for ${vars.slotId}: ${(error as Error).message}`,
    );
    return { kind: 'fallback' };
  }
}

async function runnerHasPendingInstruction(
  vars: Awaited<ReturnType<typeof loadSlotVars>>,
  target: string,
  runner: string,
  message: string,
  pane: string,
  sinceMs: number,
): Promise<boolean> {
  const panePending = runnerPaneHasPendingInstruction(pane, message, runner);
  const observability = getRunnerObservability(runner);
  if (!observability) return panePending;
  try {
    const reading = await observability.promptAccepted(
      vars,
      target,
      runnerPromptDigest(message),
      sinceMs,
    );
    return selectPendingFromObservabilityAndPane(reading, panePending).pending;
  } catch (error) {
    console.warn(
      `[runner-observability] promptAccepted read failed for ${vars.slotId}: ${(error as Error).message}`,
    );
    return panePending;
  }
}

type HookBusyDecision = { kind: 'hook'; busy: boolean } | { kind: 'fallback' };

async function sendRunnerInstructionWhenPaneClear(
  vars: Awaited<ReturnType<typeof loadSlotVars>>,
  target: string,
  runner: string,
  message: string,
  pane: string,
  promptAcceptedSinceMs: number,
  logPrefix: string,
): Promise<boolean> {
  if (
    await runnerHasPendingInstruction(vars, target, runner, message, pane, promptAcceptedSinceMs)
  ) {
    const submitted = await submitRunnerInstruction(
      vars,
      target,
      runner,
      message,
      logPrefix,
      'submit-existing',
    );
    if (submitted === 'ok') return true;
    // A stuck buffer must NOT be retyped over — the text would concatenate.
    if (submitted === 'stuck') return false;
    // Pending evidence was stale — nothing is actually buffered; type it below.
  } else if (runnerPaneContainsInstruction(pane, message)) {
    if (runnerPaneHasProgressAfterInstruction(pane, message)) {
      console.log(
        `[${logPrefix}] instruction already submitted in ${target} — skip duplicate send`,
      );
      return true;
    }
    console.log(`[${logPrefix}] instruction already present in ${target}; sending submit key`);
    const submitted = await submitRunnerInstruction(
      vars,
      target,
      runner,
      message,
      logPrefix,
      'submit-existing',
    );
    if (submitted === 'ok') return true;
    if (submitted === 'stuck') return false;
    // The pane text was a transcript echo, not a buffered composer. Retyping a
    // possibly-already-executed instruction is visible and recoverable; a
    // false delivery success stalls the caller silently — prefer the retype.
  }
  await recordRunnerObservabilityAgreement(vars, target, runner, pane, logPrefix);
  return (await submitRunnerInstruction(vars, target, runner, message, logPrefix, 'send')) === 'ok';
}

async function runnerLooksIdleObsFirst(
  vars: Awaited<ReturnType<typeof loadSlotVars>>,
  target: string,
  runner: string,
  pane: string,
): Promise<boolean> {
  const paneIdle = runnerPaneLooksIdle(pane.split('\n'), runner);
  const reading = await readRunnerActivityFromObservability(vars, target, runner);
  return selectIdleFromObservabilityAndPane(reading, paneIdle).idle;
}

async function waitForRunnerPromptSendReady(
  vars: Awaited<ReturnType<typeof loadSlotVars>>,
  target: string,
  runner: string,
  logPrefix: string,
  opts: { deadlineMs: number; pollIntervalMs: number },
): Promise<string> {
  const startedAt = Date.now();
  let pane = '';
  while (Date.now() < opts.deadlineMs) {
    pane = (
      await execOnSlot(
        vars,
        tmuxShellSnippet(`capture-pane -p -t ${shellQuote(target)} 2>/dev/null`),
      )
    ).stdout;
    const blocker = detectRunnerLaunchBlocker(pane, runner);
    if (runnerPaneHasDeferredLaunchBlocker(pane, runner, blocker)) {
      console.log(
        `[${logPrefix}] waiting for ${blocker?.kind ?? 'launch-blocker'} before prompt send to ${target}`,
      );
      await new Promise((resolve) => setTimeout(resolve, opts.pollIntervalMs));
      continue;
    }
    if (await runnerLooksIdleObsFirst(vars, target, runner, pane)) {
      return pane;
    }
    await new Promise((resolve) => setTimeout(resolve, opts.pollIntervalMs));
  }
  const blocker = detectRunnerLaunchBlocker(pane, runner);
  if (runnerPaneHasDeferredLaunchBlocker(pane, runner, blocker)) {
    throw new Error(
      `Runner launch (${runner}) still blocked by ${blocker?.kind ?? 'launch-blocker'} after ${Math.round((Date.now() - startedAt) / 1000)}s in tmux target ${target}. Prompt delivery aborted.\nLast pane content:\n${pane}`,
    );
  }
  if (!(await runnerLooksIdleObsFirst(vars, target, runner, pane))) {
    throw new Error(
      `Runner launch (${runner}) did not reach a stable ready state within the prompt-send wait window in tmux target ${target}. Prompt delivery aborted.\nLast pane content:\n${pane}`,
    );
  }
  return pane;
}

async function runnerShowsPromptDeliveryAccepted(
  vars: Awaited<ReturnType<typeof loadSlotVars>>,
  target: string,
  runner: string,
  message: string,
  sinceMs: number,
  postPane: string,
  previousPane: string,
  marker: string,
  opts: {
    launchAckSignalPath?: string | null;
    requirePromptDigest?: boolean;
  } = {},
): Promise<boolean> {
  const def = getRunnerDefinition(runner);
  if (def.observabilityScope === 'event-driven') {
    const paneId = await resolveTmuxPaneId(vars, target);
    const handoff = await probeRunnerHandoffAck(vars, target, message, sinceMs, {
      paneId,
      launchAckSignalPath: opts.launchAckSignalPath,
      requirePromptDigest: opts.requirePromptDigest,
      preferHooks: true,
    });
    if (handoff.accepted) {
      console.log(
        `[runner-observability] prompt handoff accepted via ${handoff.source}: ${handoff.reason}`,
      );
      return true;
    }
  }
  if (runnerPaneShowsPromptAccepted(postPane, previousPane, message, marker, runner)) {
    return true;
  }
  const observability = getRunnerObservability(runner);
  if (!observability) return false;
  try {
    const reading = await observability.promptAccepted(
      vars,
      target,
      runnerPromptDigest(message),
      sinceMs,
    );
    return isObservabilityReadingAuthoritative(reading) && reading.value === true;
  } catch (error) {
    console.warn(
      `[runner-observability] promptAccepted read failed for ${vars.slotId}: ${(error as Error).message}`,
    );
    return false;
  }
}

async function resolveBusyComposerObsFirst(
  vars: Awaited<ReturnType<typeof loadSlotVars>>,
  target: string,
  runner: string,
): Promise<HookBusyDecision> {
  const reading = await readRunnerActivityFromObservability(vars, target, runner);
  if (isObservabilityReadingAuthoritative(reading) && reading.value !== 'unknown') {
    return { kind: 'hook', busy: runnerActivityIsBusy(reading.value) };
  }
  return { kind: 'fallback' };
}

async function recordRunnerObservabilityAgreement(
  vars: Awaited<ReturnType<typeof loadSlotVars>>,
  target: string,
  runner: string,
  pane: string,
  logPrefix: string,
): Promise<void> {
  const def = getRunnerDefinition(runner);
  if (def.observabilityScope !== 'event-driven') return;
  const observability = getRunnerObservability(runner);
  if (!observability) return;
  const paneBusy = paneShowsBusyComposer(pane);
  let reading: ObservabilityReading<RunnerActivity> | null = null;
  try {
    reading = await observability.getActivity(vars, target);
  } catch (error) {
    console.warn(
      `[runner-observability] activity read failed for ${vars.slotId}: ${(error as Error).message}`,
    );
  }
  logRunnerObservabilityAgreement(
    buildRunnerObservabilityAgreementEntry({
      slotId: vars.slotId,
      runner,
      target,
      logPrefix,
      paneBusy,
      reading,
      // Flag-off telemetry: this path is only reached by the pane-fallback (Phase 2) loop.
      paneRetired: false,
      timestamp: Date.now(),
    }),
  );
}

/**
 * Run context that lets a degraded hold reach the ADR-031 intelligence-action audit. `emit` is
 * optional: the audit record is persisted to disk regardless — `emit` only broadcasts the
 * degraded-audit flag flip to the UI, so background callers without an event channel still get the
 * persisted audit (the finding's requirement) by passing `runId` alone.
 */
export interface RunnerSendRecoveryContext {
  runId: string;
  emit?: (event: string, payload: unknown) => void;
}

/**
 * ADR-032 Phase 3A per-decision degraded record. Under the pane-retirement flag, every time the
 * hook-only loop resolves a degraded (unknown/absent/stale) decision, capture the pane ONCE for
 * the inverted agreement log (counterfactual: what the pane predicate would have said) using the
 * reading already in hand — do NOT re-read the signals, or a recovered/later-successful send would
 * lose the original degraded event. The pane read here is shadow logging, not a decision input.
 *
 * `degraded` names which signal actually lapsed: an `activity` read (busy/idle) or the `pending`
 * read (composer digest). The pending case logs the PROMPT reading — logging the healthy activity
 * read instead would resolve a non-null `hookBusy` and drop the `wouldConsultPane` soak count.
 */
async function recordObservabilityDegradedDecision(
  vars: Awaited<ReturnType<typeof loadSlotVars>>,
  target: string,
  runner: string,
  degraded:
    | { signal: 'activity'; reading: ObservabilityReading<RunnerActivity> | null }
    | { signal: 'pending'; reading: ObservabilityReading<boolean> | null },
  logPrefix: string,
): Promise<void> {
  const def = getRunnerDefinition(runner);
  if (def.observabilityScope !== 'event-driven') return;
  const pane = await captureTmuxPane(vars, target);
  const paneBusy = paneShowsBusyComposer(pane);
  logRunnerObservabilityAgreement(
    degraded.signal === 'pending'
      ? buildPendingDegradedAgreementEntry({
          slotId: vars.slotId,
          runner,
          target,
          logPrefix,
          paneBusy,
          promptReading: degraded.reading,
          timestamp: Date.now(),
        })
      : buildRunnerObservabilityAgreementEntry({
          slotId: vars.slotId,
          runner,
          target,
          logPrefix,
          paneBusy,
          reading: degraded.reading,
          paneRetired: true,
          timestamp: Date.now(),
        }),
  );
}

/**
 * ADR-032 Phase 3A terminal degraded record. When the hook-only send holds through its whole
 * window, emit the ADR-031 deterministic-recovery "hold-send" action. It is always logged for the
 * human trace and, when a run context is available, persisted through the intelligence-action
 * audit so the soak review and the run timeline both see the hold (not just `console.warn`).
 */
async function emitObservabilityDegradedRecovery(
  vars: Awaited<ReturnType<typeof loadSlotVars>>,
  target: string,
  runner: string,
  logPrefix: string,
  recovery?: RunnerSendRecoveryContext,
  cause: 'hook-lapse' | 'composer-draft' = 'hook-lapse',
): Promise<void> {
  const now = Date.now();
  // A composer-draft hold is a HEALTHY-hook hold (foreign/unverifiable composer text), not a hook
  // lapse — give it its own reason + audit patternId so the soak review does not miscount it as a
  // hook degradation (Finding #5).
  const composerDraft = cause === 'composer-draft';
  const action = buildObservabilityDegradedRecovery({
    slotId: vars.slotId,
    runner,
    target,
    now,
    ...(composerDraft
      ? {
          reason:
            'composer-draft-detected: live composer holds foreign/unverifiable draft text under pane-retired flag; holding send to avoid concatenation',
        }
      : {}),
  });
  logObservabilityDegradedRecovery(action, logPrefix);
  if (recovery) {
    // writeAuditRecord swallows its own IO errors and flips the run's degraded-audit flag, so a
    // failed write does not throw here and does not block the send loop's completion.
    await writeAuditRecord(
      buildObservabilityDegradedIntelligenceAction({
        runId: recovery.runId,
        now,
        runner,
        target,
        reason: action.reason,
        patternId: composerDraft ? 'composer-draft-hold' : 'observability-degraded-hold',
      }),
      { runId: recovery.runId, emit: recovery.emit ?? (() => undefined), now: new Date(now) },
    );
  }
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

async function warnIfObservabilityDegraded(
  vars: Awaited<ReturnType<typeof loadSlotVars>>,
  runner: string,
  sentAtMs: number,
  logPrefix: string,
): Promise<void> {
  const heartbeatMs = getRunnerDefinition(runner).observabilityHeartbeatMs;
  if (heartbeatMs == null) return;
  const obsDir = shellQuote(await runnerObservabilityDirForSlot(vars));
  const hooksPath = `${obsDir}/hooks.jsonl`;
  const deadline = Date.now() + heartbeatMs;
  while (Date.now() < deadline) {
    const stat = await execOnSlot(
      vars,
      `stat -f %m ${hooksPath} 2>/dev/null || stat -c %Y ${hooksPath} 2>/dev/null || echo 0`,
    );
    const mtimeSec = Number.parseInt(stat.stdout.trim(), 10);
    const mtimeMs = Number.isFinite(mtimeSec) ? mtimeSec * 1000 : 0;
    if (mtimeMs >= sentAtMs) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  console.warn(
    `[${logPrefix}] [observability] degraded — hooks.jsonl did not advance within ${heartbeatMs}ms after send-keys; pane fallback engaged`,
  );
}

type SubmitInstructionOutcome = 'ok' | 'not-buffered' | 'stuck';

async function submitRunnerInstruction(
  vars: Awaited<ReturnType<typeof loadSlotVars>>,
  target: string,
  runner: string,
  message: string,
  logPrefix: string,
  mode: 'send' | 'submit-existing',
): Promise<SubmitInstructionOutcome> {
  let sentAtMs: number | null = null;
  if (mode === 'send') {
    try {
      const sentinel = await writeRunnerPromptSentinel(vars, message);
      sentAtMs = sentinel.sentAt;
    } catch (error) {
      console.warn(`[${logPrefix}] failed to write prompt sentinel: ${(error as Error).message}`);
    }
    await execOnSlot(vars, tmuxSendTextCommand(target, message, { enter: true }));
  } else {
    const pane = await captureTmuxPane(vars, target);
    if (!runnerPaneHasBufferedInstruction(pane, message, runner)) {
      // Nothing is buffered: pressing a submit key would no-op, and the
      // absence-of-buffer verification below would then report success for an
      // instruction that was never delivered. Refuse so callers fall back to a
      // real send.
      console.log(
        `[${logPrefix}] submit-existing requested but no buffered instruction in ${target}`,
      );
      return 'not-buffered';
    }
    const submitKey = runnerBufferedInstructionSubmitKey(pane, runner);
    await execOnSlot(
      vars,
      tmuxShellSnippet(`send-keys -t ${shellQuote(target)} ${submitKey} 2>/dev/null`),
    );
  }

  for (let attempt = 1; attempt <= 5; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    const pane = await captureTmuxPane(vars, target);
    if (!runnerPaneHasBufferedInstruction(pane, message, runner)) {
      if (mode === 'send' && sentAtMs != null) {
        // Intentionally fire-and-forget: degraded heartbeat must not block send confirmation.
        void warnIfObservabilityDegraded(vars, runner, sentAtMs, logPrefix).catch((error) => {
          console.warn(
            `[${logPrefix}] [observability] degraded check failed: ${(error as Error).message}`,
          );
        });
      }
      return 'ok';
    }
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
  if (mode === 'send' && sentAtMs != null) {
    // Intentionally fire-and-forget: degraded heartbeat must not block send confirmation.
    void warnIfObservabilityDegraded(vars, runner, sentAtMs, logPrefix).catch((error) => {
      console.warn(
        `[${logPrefix}] [observability] degraded check failed: ${(error as Error).message}`,
      );
    });
  }
  return 'stuck';
}

type ClassifierActionRecovery =
  | { kind: 'ready'; pane: string }
  | { kind: 'task-accepted'; pane: string };

async function waitForPaneAfterClassifierAction(
  vars: Awaited<ReturnType<typeof loadSlotVars>>,
  target: string,
  runner: string,
  message: string,
  marker: string,
  opts: { timeoutMs: number; pollIntervalMs: number; stabilityPolls: number },
): Promise<ClassifierActionRecovery | null> {
  const deadline = Date.now() + opts.timeoutMs;
  let lastPane = '';
  let stableCount = 0;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, opts.pollIntervalMs));
    const pane = await captureTmuxPane(vars, target, 90);
    if (runnerPaneShowsTaskAlreadyRunning(pane, message, marker, runner)) {
      return { kind: 'task-accepted', pane };
    }
    if (!(await runnerLooksIdleObsFirst(vars, target, runner, pane))) {
      stableCount = 0;
      lastPane = '';
      continue;
    }
    if (pane === lastPane) {
      stableCount += 1;
      if (stableCount >= opts.stabilityPolls) return { kind: 'ready', pane };
    } else {
      stableCount = 1;
      lastPane = pane;
    }
  }
  return null;
}

/**
 * ADR-032 Phase 3 hook-only send loop. Reached only when {@link isRunnerPaneRetired} is true.
 * The decision to send/hold uses hook readings ONLY — the pane predicates
 * (`paneShowsBusyComposer` / `runnerPaneHasPendingInstruction` / `runnerPaneLooksIdle`) are
 * never consulted for the decision. Degraded readings (hook `unknown`/absent/stale) resolve to
 * busy: the send holds, and on timeout an ADR-031 deterministic recovery + attention is emitted
 * instead of falling back to the pane. Post-send delivery verification inside
 * {@link submitRunnerInstruction} still reads the pane, which is confirmation, not a decision.
 */
async function sendRunnerInstructionHookOnly(
  vars: Awaited<ReturnType<typeof loadSlotVars>>,
  target: string,
  runner: string,
  message: string,
  logPrefix: string,
  effectiveTimeoutMs: number,
  loopStartMs: number,
  promptAcceptedSinceMs: number,
  recovery?: RunnerSendRecoveryContext,
): Promise<boolean> {
  const observability = getRunnerObservability(runner);
  if (!observability) return false;
  const deadline = loopStartMs + effectiveTimeoutMs;
  // Track WHY the window held, kept distinct so the terminal audit record names the real cause: a
  // hook lapse (degraded hook signal) versus a composer hold (foreign/unverifiable draft the hook
  // signal cannot see). A composer hold with a healthy hook must NOT be recorded as a hook lapse.
  let sawHookDegraded = false;
  let sawComposerHold = false;
  while (Date.now() < deadline) {
    // Idempotent re-nudge: a high-confidence digest match means this exact message already
    // landed — don't duplicate the send.
    let promptReading: ObservabilityReading<boolean> | null = null;
    try {
      promptReading = await observability.promptAccepted(
        vars,
        target,
        runnerPromptDigest(message),
        promptAcceptedSinceMs,
        // Pane-retired path: absent hooks must resolve non-authoritative (degrade/hold), not a
        // fabricated medium-`false` that would fresh-send into a blind composer.
        true,
      );
    } catch (error) {
      console.warn(
        `[runner-observability] promptAccepted read failed for ${vars.slotId}: ${(error as Error).message}`,
      );
    }
    if (promptReading?.value === true && promptReading.confidence === 'high') return true;

    const activity = await readRunnerActivityFromObservability(vars, target, runner);
    const idleDecision = selectIdleFromObservabilityAndPane(activity, false, true);
    if (idleDecision.degraded) {
      sawHookDegraded = true;
      await recordObservabilityDegradedDecision(
        vars,
        target,
        runner,
        { signal: 'activity', reading: activity },
        logPrefix,
      );
      await new Promise((resolve) => setTimeout(resolve, 1500));
      continue;
    }
    if (!idleDecision.idle) {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      continue;
    }

    // Hook-authoritative idle. Before fresh-typing, consult the pending selector: an
    // authoritative not-accepted reading means the digest may already sit buffered in the
    // composer, so a fresh type would concatenate. A degraded pending reading has no proof the
    // composer is empty either — hold rather than risk a blind concat.
    const pendingDecision = selectPendingFromObservabilityAndPane(promptReading, false, true);
    if (pendingDecision.degraded) {
      sawHookDegraded = true;
      // Log the PENDING reading that lapsed — not the healthy activity read — or the soak metric
      // resolves a non-null hookBusy off the activity and drops this decision's wouldConsultPane.
      await recordObservabilityDegradedDecision(
        vars,
        target,
        runner,
        { signal: 'pending', reading: promptReading },
        logPrefix,
      );
      await new Promise((resolve) => setTimeout(resolve, 1500));
      continue;
    }
    if (pendingDecision.pending) {
      // Try to submit the buffered instruction first. submitRunnerInstruction verifies the
      // composer buffer INTERNALLY (confirmation, not a decision): it returns 'not-buffered'
      // when the composer is actually empty — proving it is safe to type fresh — and refuses
      // to retype over a 'stuck' buffer.
      const submitted = await submitRunnerInstruction(
        vars,
        target,
        runner,
        message,
        logPrefix,
        'submit-existing',
      );
      if (submitted === 'ok') return true;
      if (submitted === 'stuck') return false;
      // 'not-buffered' → OUR message is not buffered → fall through to the foreign-draft guard.
    }
    // Reaching here means our instruction is NOT buffered (submit-existing proved 'not-buffered',
    // or the hook read authoritative-accepted so nothing of ours is pending). Before typing fresh,
    // confirm the live composer is EMPTY: foreign draft text — an operator keystroke, another
    // instruction — that the hook signal cannot see would otherwise concatenate with the typed
    // message. This pane read is a pre-send safety confirmation, not a send decision; hold and let
    // the degraded window own it rather than risk a blind concat.
    const preSendPane = await captureTmuxPane(vars, target);
    const composerState = runnerPaneComposerDraftState(preSendPane, runner);
    if (composerState !== 'empty') {
      // 'draft' → foreign text a fresh type would concatenate onto. 'unknown' → no prompt marker,
      // so the composer state cannot be POSITIVELY confirmed empty — fail-closed and hold rather
      // than fresh-type into an unseen buffer. This is a healthy-hook composer hold, NOT a hook
      // lapse, so it records its own audit cause (Finding #5).
      sawComposerHold = true;
      console.warn(
        `[${logPrefix}] hook-only send held: live composer state '${composerState}' in ${target}; not typing to avoid concatenation`,
      );
      await new Promise((resolve) => setTimeout(resolve, 1500));
      continue;
    }
    // Composer proven empty (or nothing was pending) → type fresh.
    return (
      (await submitRunnerInstruction(vars, target, runner, message, logPrefix, 'send')) === 'ok'
    );
  }
  if (sawHookDegraded) {
    // Hook lapse held the window: emit the ADR-031 deterministic recovery + audit as a hook lapse.
    await emitObservabilityDegradedRecovery(
      vars,
      target,
      runner,
      logPrefix,
      recovery,
      'hook-lapse',
    );
  } else if (sawComposerHold) {
    // Healthy hook, but a foreign/unverifiable composer draft held the send the whole window.
    // Record it as a composer-draft hold — distinct evidence from a hook lapse (Finding #5).
    await emitObservabilityDegradedRecovery(
      vars,
      target,
      runner,
      logPrefix,
      recovery,
      'composer-draft',
    );
  } else {
    console.warn(
      `[${logPrefix}] runner ${runner} stayed busy; skipped sending duplicate/queued prompt to ${target}`,
    );
  }
  return false;
}

export async function sendRunnerInstructionSafely(
  vars: Awaited<ReturnType<typeof loadSlotVars>>,
  target: string,
  runnerId: string,
  message: string,
  logPrefix: string,
  timeoutMs?: number,
  opts: { forceBusyPoll?: boolean; recovery?: RunnerSendRecoveryContext } = {},
): Promise<boolean> {
  const runner = normalizeRunner(runnerId);
  const def = getRunnerDefinition(runner);
  const effectiveTimeoutMs = timeoutMs ?? resolveSafeSendTimeoutMs(runner);
  const loopStartMs = Date.now();
  const promptAcceptedSinceMs = computePromptAcceptedSinceMs(loopStartMs, effectiveTimeoutMs);
  // ADR-032 Phase 3: hook-capable runners that don't need the busy-composer poll (Claude) resolve
  // the decision from hooks only. Runners that require the poll (Codex) take the pane-fallback path
  // below.
  if (isRunnerPaneRetired(runner)) {
    return sendRunnerInstructionHookOnly(
      vars,
      target,
      runner,
      message,
      logPrefix,
      effectiveTimeoutMs,
      loopStartMs,
      promptAcceptedSinceMs,
      opts.recovery,
    );
  }
  // Skip the busy-composer poll iff the runner doesn't require it AND the caller didn't opt
  // in. Most call sites send into an idle prompt where the registry default (Claude: false,
  // codex: true) is correct. The branch-affinity nudge flow targets a Claude session that may
  // be mid-tool-use, where send-keys gets queued or eaten unless we wait for the busy marker
  // to clear — it passes `forceBusyPoll: true` to override the per-runner default.
  if (!def.requiresBusyComposerPoll && !opts.forceBusyPoll) {
    const pendingObs = await resolvePendingInstructionObsFirst(
      vars,
      target,
      runner,
      message,
      promptAcceptedSinceMs,
    );
    if (pendingObs.kind === 'hook' && pendingObs.pending) {
      // An authoritative not-accepted reading only means the runner never saw
      // the digest — it does NOT prove text is buffered in the composer. An
      // Enter on an empty composer reports success while the instruction was
      // never typed, so require pane evidence before submit-existing.
      const pane = await captureTmuxPane(vars, target);
      if (runnerPaneHasPendingInstruction(pane, message, runner)) {
        return (
          (await submitRunnerInstruction(
            vars,
            target,
            runner,
            message,
            logPrefix,
            'submit-existing',
          )) === 'ok'
        );
      }
      return sendRunnerInstructionWhenPaneClear(
        vars,
        target,
        runner,
        message,
        pane,
        promptAcceptedSinceMs,
        logPrefix,
      );
    }
    if (pendingObs.kind === 'fallback') {
      const pane = await captureTmuxPane(vars, target);
      return sendRunnerInstructionWhenPaneClear(
        vars,
        target,
        runner,
        message,
        pane,
        promptAcceptedSinceMs,
        logPrefix,
      );
    }
  }
  const deadline = loopStartMs + effectiveTimeoutMs;
  while (Date.now() < deadline) {
    const pendingObs = await resolvePendingInstructionObsFirst(
      vars,
      target,
      runner,
      message,
      promptAcceptedSinceMs,
    );
    let pane: string | null = null;
    const ensurePane = async (): Promise<string> => {
      if (pane == null) pane = await captureTmuxPane(vars, target);
      return pane;
    };

    if (pendingObs.kind === 'hook' && pendingObs.pending) {
      // Same pane-evidence rule as the fast path; with nothing buffered, fall
      // through to the busy-aware delivery below instead of a blind Enter.
      const captured = await ensurePane();
      if (runnerPaneHasPendingInstruction(captured, message, runner)) {
        return (
          (await submitRunnerInstruction(
            vars,
            target,
            runner,
            message,
            logPrefix,
            'submit-existing',
          )) === 'ok'
        );
      }
    } else if (pendingObs.kind === 'fallback') {
      const captured = await ensurePane();
      if (
        await runnerHasPendingInstruction(
          vars,
          target,
          runner,
          message,
          captured,
          promptAcceptedSinceMs,
        )
      ) {
        return (
          (await submitRunnerInstruction(
            vars,
            target,
            runner,
            message,
            logPrefix,
            'submit-existing',
          )) === 'ok'
        );
      }
    }

    const busyObs = await resolveBusyComposerObsFirst(vars, target, runner);
    if (busyObs.kind === 'hook') {
      if (!busyObs.busy) {
        const captured = await ensurePane();
        return sendRunnerInstructionWhenPaneClear(
          vars,
          target,
          runner,
          message,
          captured,
          promptAcceptedSinceMs,
          logPrefix,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 1500));
      continue;
    }

    const captured = await ensurePane();
    if (!paneShowsBusyComposer(captured)) {
      return sendRunnerInstructionWhenPaneClear(
        vars,
        target,
        runner,
        message,
        captured,
        promptAcceptedSinceMs,
        logPrefix,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  const timeoutPane = await captureTmuxPane(vars, target);
  await recordRunnerObservabilityAgreement(vars, target, runner, timeoutPane, logPrefix);
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
    launchAckSignalPath?: string;
    requirePromptDigest?: boolean;
    softAcceptOnHandoffAck?: boolean;
    handoffAckSinceMs?: number;
  } = {},
): Promise<void> {
  const runner = normalizeRunner(runnerId);
  const readyTimeoutMs = opts.readyTimeoutMs ?? 30_000;
  const stabilityPolls = opts.stabilityPolls ?? 3;
  const pollIntervalMs = opts.pollIntervalMs ?? 1500;
  const verifyWaitMs = opts.verifyWaitMs ?? 2000;
  const maxAttempts = opts.maxAttempts ?? 3;
  const softAcceptOnHandoffAck = opts.softAcceptOnHandoffAck !== false;
  const handoffAckSinceMs = opts.handoffAckSinceMs ?? Date.now();
  const requirePromptDigest = opts.requirePromptDigest === true;

  // Tiny windows (e.g. a 5-row pane after a detached-client reflow) truncate the
  // banner lines readiness matching depends on — re-enforce the minimum size
  // right before polling, not only at window creation.
  await ensureTmuxWindowMinimumSize(vars, target);

  const readyStart = Date.now();
  let readyDeadline = readyStart + readyTimeoutMs;
  let deadlineExtended = false;
  let blockerResolveDeadlineExtended = false;
  const extendDeadlineAfterBlockerResolve = (reason: string): void => {
    if (blockerResolveDeadlineExtended) return;
    blockerResolveDeadlineExtended = true;
    const bumpMs = Math.round(readyTimeoutMs / 2);
    readyDeadline = Math.max(readyDeadline, Date.now()) + bumpMs;
    console.log(
      `[${logPrefix}] extended readiness deadline by ${Math.round(bumpMs / 1000)}s after ${reason} in ${target}`,
    );
  };
  let lastCapturedPane = '';
  let lastPaneActivityAt = readyStart;
  let lastPane = '';
  let stableCount = 0;
  let ready = false;
  let workspaceTrustAttempts = 0;
  let grokProjectAttempts = 0;
  const maxBlockerAutoAttempts = 2;
  const snapshottedBlockers = new Set<string>();
  while (Date.now() < readyDeadline) {
    await new Promise((r) => setTimeout(r, pollIntervalMs));
    const pane = (
      await execOnSlot(
        vars,
        tmuxShellSnippet(`capture-pane -p -t ${shellQuote(target)} 2>/dev/null`),
      )
    ).stdout;
    if (pane !== lastCapturedPane) {
      lastCapturedPane = pane;
      lastPaneActivityAt = Date.now();
    }
    // A cold-starting runner can still be painting its boot output when the
    // deadline expires. Extend once by half the budget while activity is
    // recent instead of failing a launch that is visibly still progressing.
    if (
      !deadlineExtended &&
      readyDeadline - Date.now() <= pollIntervalMs &&
      Date.now() - lastPaneActivityAt <= 3 * pollIntervalMs
    ) {
      deadlineExtended = true;
      readyDeadline += Math.round(readyTimeoutMs / 2);
      console.log(
        `[${logPrefix}] runner in ${target} still starting at the readiness deadline — extending once by ${Math.round(readyTimeoutMs / 2000)}s`,
      );
    }
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
    const autoActionKey = runnerLaunchBlockerAutoActionKey(blocker?.autoAction ?? null);
    if (
      blocker?.autoAction === 'cursor-trust-workspace' &&
      autoActionKey &&
      workspaceTrustAttempts < maxBlockerAutoAttempts
    ) {
      const trustResult = await execOnSlot(
        vars,
        tmuxShellSnippet(
          `send-keys -t ${shellQuote(target)} ${shellQuote(autoActionKey)} 2>/dev/null`,
        ),
      );
      if (trustResult.exitCode !== 0) {
        throw new Error(
          `Failed to accept Cursor workspace trust prompt in ${target}: ${
            trustResult.stderr || trustResult.stdout || `exit ${trustResult.exitCode}`
          }`,
        );
      }
      workspaceTrustAttempts += 1;
      console.log(
        `[${logPrefix}] accepted Cursor workspace trust prompt for ${target} (${vars.remoteRepo})`,
      );
      extendDeadlineAfterBlockerResolve('auto-resolving workspace-trust');
      stableCount = 0;
      lastPane = '';
      continue;
    }
    if (
      blocker?.autoAction === 'grok-select-current-project' &&
      autoActionKey &&
      grokProjectAttempts < maxBlockerAutoAttempts
    ) {
      const selectResult = await execOnSlot(
        vars,
        tmuxShellSnippet(
          `send-keys -t ${shellQuote(target)} ${shellQuote(autoActionKey)} 2>/dev/null`,
        ),
      );
      if (selectResult.exitCode !== 0) {
        throw new Error(
          `Failed to select current Grok project directory in ${target}: ${
            selectResult.stderr || selectResult.stdout || `exit ${selectResult.exitCode}`
          }`,
        );
      }
      grokProjectAttempts += 1;
      console.log(
        `[${logPrefix}] selected current Grok project directory for ${target} (${vars.remoteRepo})`,
      );
      extendDeadlineAfterBlockerResolve('auto-resolving project-directory');
      stableCount = 0;
      lastPane = '';
      continue;
    }
    if (runnerPaneHasDeferredLaunchBlocker(pane, runner)) {
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
    if (runnerPaneShowsTaskAlreadyRunning(pane, message, marker, runner)) {
      console.log(
        `[${logPrefix}] prompt already executing in ${target}; skipping duplicate post-launch send`,
      );
      return;
    }
    if (!(await runnerLooksIdleObsFirst(vars, target, runner, pane))) {
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

  let timeoutPaneForFailure = '';
  let classifierForFailure: PaneClassifierResult | null = null;
  if (!ready) {
    timeoutPaneForFailure = (
      await execOnSlot(
        vars,
        tmuxShellSnippet(`capture-pane -p -t ${shellQuote(target)} 2>/dev/null | tail -80`),
      )
    ).stdout;
    classifierForFailure = await classifyRunnerPaneStateBestEffortLazy({
      runner,
      target,
      pane: timeoutPaneForFailure,
      expected: 'post-launch prompt ready for task delivery',
    });
    if (classifierForFailure.confidence >= 0.8 && classifierForFailure.state === 'ready') {
      console.log(
        `[${logPrefix}] pane classifier accepted ${target} as ready: ${classifierForFailure.reason}`,
      );
      ready = true;
      lastPane = timeoutPaneForFailure;
    }
    if (
      !ready &&
      classifierForFailure.confidence >= 0.8 &&
      (classifierForFailure.suggestedAction === 'send_enter' ||
        classifierForFailure.suggestedAction === 'send_ctrl_m') &&
      (classifierForFailure.state === 'command_not_submitted' ||
        classifierForFailure.state === 'prompt_buffered')
    ) {
      const key = classifierForFailure.suggestedAction === 'send_ctrl_m' ? 'C-m' : 'Enter';
      console.log(
        `[${logPrefix}] pane classifier suggested ${key} for ${target}: ${classifierForFailure.reason}`,
      );
      await execOnSlot(
        vars,
        tmuxShellSnippet(`send-keys -t ${shellQuote(target)} ${key} 2>/dev/null`),
      );
      const recovered = await waitForPaneAfterClassifierAction(
        vars,
        target,
        runner,
        message,
        marker,
        {
          timeoutMs: Math.min(30_000, Math.max(readyTimeoutMs, 5_000)),
          pollIntervalMs,
          stabilityPolls,
        },
      );
      if (recovered?.kind === 'task-accepted') {
        console.log(
          `[${logPrefix}] pane classifier submitted the buffered task in ${target}; skipping duplicate post-launch send`,
        );
        return;
      }
      if (recovered?.kind === 'ready') {
        ready = true;
        lastPane = recovered.pane;
      } else {
        timeoutPaneForFailure = (
          await execOnSlot(
            vars,
            tmuxShellSnippet(`capture-pane -p -t ${shellQuote(target)} 2>/dev/null | tail -80`),
          )
        ).stdout;
        classifierForFailure = await classifyRunnerPaneStateBestEffortLazy({
          runner,
          target,
          pane: timeoutPaneForFailure,
          expected: 'post-launch prompt ready for task delivery after classifier action',
        });
      }
    }
    // Trust/directory prompts can be classified confidently (send_yes) even when
    // the deterministic detector missed a truncated pane. Deliver the confirmation
    // keystroke instead of failing with a ready-timeout that already knew the fix.
    const trustKey =
      !ready && classifierForFailure
        ? keyForClassifierTrustAction(classifierForFailure, runner, timeoutPaneForFailure)
        : null;
    if (!ready && trustKey && classifierForFailure) {
      console.log(
        `[${logPrefix}] pane classifier suggested ${trustKey} for trust_prompt in ${target}: ${classifierForFailure.reason}`,
      );
      const trustSend = await execOnSlot(
        vars,
        tmuxShellSnippet(`send-keys -t ${shellQuote(target)} ${shellQuote(trustKey)} 2>/dev/null`),
      );
      if (trustSend.exitCode !== 0) {
        throw new Error(
          `Failed to apply classifier trust action ${trustKey} in ${target}: ${
            trustSend.stderr || trustSend.stdout || `exit ${trustSend.exitCode}`
          }`,
        );
      }
      extendDeadlineAfterBlockerResolve('classifier trust_prompt action');
      const recovered = await waitForPaneAfterClassifierAction(
        vars,
        target,
        runner,
        message,
        marker,
        {
          timeoutMs: Math.min(30_000, Math.max(readyTimeoutMs, 5_000)),
          pollIntervalMs,
          stabilityPolls,
        },
      );
      if (recovered?.kind === 'task-accepted') {
        console.log(
          `[${logPrefix}] pane classifier cleared trust prompt and task was already accepted in ${target}`,
        );
        return;
      }
      if (recovered?.kind === 'ready') {
        ready = true;
        lastPane = recovered.pane;
      } else {
        timeoutPaneForFailure = (
          await execOnSlot(
            vars,
            tmuxShellSnippet(`capture-pane -p -t ${shellQuote(target)} 2>/dev/null | tail -80`),
          )
        ).stdout;
        classifierForFailure = await classifyRunnerPaneStateBestEffortLazy({
          runner,
          target,
          pane: timeoutPaneForFailure,
          expected: 'post-launch prompt ready for task delivery after trust action',
        });
      }
    }
  }

  if (!ready) {
    const timeoutPane =
      timeoutPaneForFailure ||
      (
        await execOnSlot(
          vars,
          tmuxShellSnippet(`capture-pane -p -t ${shellQuote(target)} 2>/dev/null | tail -80`),
        )
      ).stdout;
    const classifier =
      classifierForFailure ??
      (await classifyRunnerPaneStateBestEffortLazy({
        runner,
        target,
        pane: timeoutPane,
        expected: 'post-launch prompt ready for task delivery',
      }));
    const classifierJson = JSON.stringify(classifier);
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
            `summary=runner launch did not reach a stable ready state before prompt delivery timed out.`,
            `capturedAt=${new Date().toISOString()}`,
            `classifier=${classifierJson}`,
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
      `Runner launch (${runner}) did not reach a stable ready state within ${readyTimeoutMs / 1000}s in tmux target ${target}. ` +
        `Pane classifier: ${classifier.state}/${classifier.confidence} action=${classifier.suggestedAction} (${classifier.reason}). ` +
        `Prompt delivery aborted to avoid sending into a half-booted runner TUI.${snapshotNote}\n` +
        `Last pane content:\n${timeoutPane}`,
    );
  }

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const immediatePane = (
      await execOnSlot(
        vars,
        tmuxShellSnippet(`capture-pane -p -t ${shellQuote(target)} 2>/dev/null`),
      )
    ).stdout;
    const immediateHandoff = await probeRunnerHandoffAck(vars, target, message, handoffAckSinceMs, {
      launchAckSignalPath: opts.launchAckSignalPath,
      preferHooks: getRunnerDefinition(runner).observabilityScope === 'event-driven',
      requirePromptDigest,
    });
    if (immediateHandoff.accepted) {
      console.log(
        `[${logPrefix}] prompt handoff already accepted before attempt ${attempt}/${maxAttempts}: ${immediateHandoff.reason}`,
      );
      return;
    }
    if (runnerPaneShowsPreSendDuplicateInstruction(immediatePane, message, runner)) {
      console.log(
        `[${logPrefix}] prompt already visible with runner progress in ${target}; skipping duplicate send`,
      );
      return;
    }
    if (runnerPaneShowsTaskAlreadyRunning(immediatePane, message, marker, runner)) {
      console.log(
        `[${logPrefix}] task already executing in ${target}; skipping duplicate send (attempt ${attempt}/${maxAttempts})`,
      );
      return;
    }
    const preSendPane = await waitForRunnerPromptSendReady(vars, target, runner, logPrefix, {
      deadlineMs: Date.now() + Math.min(60_000, readyTimeoutMs),
      pollIntervalMs,
    });
    const preSendHandoff = await probeRunnerHandoffAck(vars, target, message, handoffAckSinceMs, {
      launchAckSignalPath: opts.launchAckSignalPath,
      preferHooks: getRunnerDefinition(runner).observabilityScope === 'event-driven',
      requirePromptDigest,
    });
    if (preSendHandoff.accepted) {
      console.log(
        `[${logPrefix}] prompt handoff already accepted before attempt ${attempt}/${maxAttempts}: ${preSendHandoff.reason}`,
      );
      return;
    }
    if (runnerPaneShowsPreSendDuplicateInstruction(preSendPane, message, runner)) {
      console.log(
        `[${logPrefix}] prompt already visible with runner progress in ${target}; skipping duplicate send`,
      );
      return;
    }
    // The previous attempt's prompt may have been accepted just after its verify
    // window closed (e.g. codex only renders "Working" a few seconds after submit).
    // Re-check before sending again, or we deliver a duplicate prompt that lands as a
    // queued draft while the runner is already executing the task.
    if (runnerPaneShowsTaskAlreadyRunning(preSendPane, message, marker, runner)) {
      console.log(
        `[${logPrefix}] task already executing in ${target}; skipping duplicate send (attempt ${attempt}/${maxAttempts})`,
      );
      return;
    }
    const shouldSubmitOnly = runnerPaneShouldSubmitExistingInstruction(
      preSendPane,
      message,
      marker,
      runner,
      { allowMarkerOnly: attempt > 1 },
    );
    let sendCommand: string;
    if (shouldSubmitOnly) {
      sendCommand = tmuxShellSnippet(
        `send-keys -t ${shellQuote(target)} ${runnerBufferedInstructionSubmitKey(preSendPane, runner)} 2>/dev/null`,
      );
    } else {
      try {
        await writeRunnerPromptSentinel(vars, message);
      } catch (error) {
        console.warn(`[${logPrefix}] failed to write prompt sentinel: ${(error as Error).message}`);
      }
      sendCommand = tmuxSendTextCommand(target, message, { enter: true });
    }
    const sentAtMs = Date.now();
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
    const promptAcceptedSinceMs = sentAtMs - 500;
    if (
      await runnerShowsPromptDeliveryAccepted(
        vars,
        target,
        runner,
        message,
        promptAcceptedSinceMs,
        postPane,
        lastPane,
        marker,
        { launchAckSignalPath: opts.launchAckSignalPath, requirePromptDigest },
      )
    ) {
      console.log(
        `[${logPrefix}] prompt delivered to ${target} (attempt ${attempt}/${maxAttempts})`,
      );
      return;
    }
    if (runnerPaneHasQueuedInstruction(postPane, message)) {
      console.log(`[${logPrefix}] prompt queued in ${target} (attempt ${attempt}/${maxAttempts})`);
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
  if (runnerPaneHasQueuedInstruction(failurePane, message)) {
    console.log(
      `[${logPrefix}] prompt delivery verifier found queued instruction in ${target}; accepting delayed submit`,
    );
    return;
  }
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
  if (softAcceptOnHandoffAck) {
    const handoff = await probeRunnerHandoffAck(vars, target, message, handoffAckSinceMs, {
      launchAckSignalPath: opts.launchAckSignalPath,
      preferHooks: getRunnerDefinition(runner).observabilityScope === 'event-driven',
      requirePromptDigest,
    });
    if (handoff.accepted) {
      console.warn(
        `[${logPrefix}] prompt delivery pane verifier failed but handoff evidence accepted via ${handoff.source}: ${handoff.reason}`,
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
      if (index && !isReviewerWindowName(name)) {
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
