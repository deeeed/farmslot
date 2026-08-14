import path from 'node:path';

import {
  DEFAULT_CODEX_EFFORT,
  DEFAULT_CURSOR_MODEL,
  DEFAULT_GROK_EFFORT,
  DEFAULT_GROK_MODEL,
  type SafetyTier,
  type ScriptedRunnerConfig,
} from '@farmslot/protocol';

import type { loadSlotVars } from '../core/config.js';
import { expandDispatchCmd } from '../core/hooks.js';
import { shellExpressionForRemotePath } from '../core/remote-paths.js';
import { shellQuote } from '../core/tmux.js';

import {
  normalizeRunner,
  runnerDefaultSafetyTier,
  runnerFlagsForTier,
  runnerNeedsPostLaunchPrompt,
  runnerSessionReloadCapability,
} from './registry.js';
import {
  buildClaudeObservabilityFallbackCommand,
  buildRunnerObservabilityInstallCommand,
  claudeObservabilitySettingsPath,
  withRunnerObservabilityInstall,
} from './runner-observability.js';

const CODEX_REASONING_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh']);
const CODEX_PLUGIN_HOOK_ARGS =
  ' "$FARMSLOT_CODEX_PLUGIN_HOOK_ARG_1" "$FARMSLOT_CODEX_PLUGIN_HOOK_ARG_2"';

/**
 * Resolve reasoning effort for runners that support it.
 * - empty/omitted → runner default (Codex/Grok: xhigh)
 * - `auto` → leave unset so the CLI/config default applies
 * - any other non-empty value → pass through
 */
export function resolveRunnerEffort(runnerId: string, effort?: string | null): string | undefined {
  const runner = normalizeRunner(runnerId);
  const trimmed = effort?.trim();
  if (trimmed?.toLowerCase() === 'auto') return undefined;
  if (trimmed) return trimmed;
  if (runner === 'codex') return DEFAULT_CODEX_EFFORT;
  if (runner === 'grok') return DEFAULT_GROK_EFFORT;
  return undefined;
}

const RECIPE_SOURCE_ENV_NAMES = [
  'FARMSLOT_RECIPE_SOURCE_TRUST',
  'FARMSLOT_RECIPE_SOURCE_KIND',
  'FARMSLOT_RECIPE_SOURCE_NAME',
  'FARMSLOT_RECIPE_SOURCE_DIGEST',
  'FARMSLOT_RECIPE_APPROVE_PLAN',
] as const;

/**
 * Mark agent commands spawned for a task containing caller-untrusted recipe
 * input. The source sidecar is written by the gateway, not by recipe content.
 * This preserves provenance across runner launches; it is not an OS sandbox for
 * a worker that already has unrestricted shell access.
 */
export function withTaskRecipeTrustEnvironment(
  command: string,
  repo: string,
  taskDir?: string,
): string {
  const clear = `unset ${RECIPE_SOURCE_ENV_NAMES.join(' ')}`;
  if (!taskDir) return `${clear}; ${command}`;
  const taskRoot = path.posix.isAbsolute(taskDir) ? taskDir : path.posix.join(repo, taskDir);
  const sidecar = path.posix.join(taskRoot, 'inputs/inherited/recipe-source.json');
  const mark = [
    'unset FARMSLOT_RECIPE_SOURCE_DIGEST FARMSLOT_RECIPE_APPROVE_PLAN',
    'export FARMSLOT_RECIPE_SOURCE_TRUST=untrusted',
    'export FARMSLOT_RECIPE_SOURCE_KIND=task',
    'export FARMSLOT_RECIPE_SOURCE_NAME=task-inherited',
  ].join('; ');
  return `if [ -f ${shellExpressionForRemotePath(sidecar)} ]; then ${mark}; else ${clear}; fi; ${command}`;
}

/**
 * How long post-launch prompt delivery waits for an interactive runner TUI to
 * reach a stable idle composer. Claude launches also run observability install
 * first, so cold starts routinely exceed the legacy 30–60s window.
 */
export const RUNNER_LAUNCH_READY_TIMEOUT_MS = 120_000;

export function buildCursorAgentLaunch(options: {
  binary: string;
  model?: string | null;
  prompt: string;
  repo: string;
  safetyTier?: SafetyTier;
}): string {
  const effectiveModel =
    options.model && options.model !== 'unknown' ? options.model : DEFAULT_CURSOR_MODEL;
  const flagList = runnerFlagsForTier('cursor', options.safetyTier);
  const flagFragment = flagList.length ? ` ${flagList.join(' ')}` : '';
  const prompt = options.prompt.trim() ? ` ${shellQuote(options.prompt)}` : '';
  return `cd ${shellQuote(options.repo)} && ${options.binary}${flagFragment} --model ${effectiveModel}${prompt}`;
}

export function resolveCursorAgentBinary(preferred?: string | null): string {
  if (preferred && preferred.trim()) return preferred.trim();
  return 'cursor-agent';
}

export function buildGrokLaunch(options: {
  binary: string;
  model?: string | null;
  effort?: string | null;
  prompt: string;
  repo: string;
  safetyTier?: SafetyTier;
}): string {
  const effectiveModel =
    options.model && options.model !== 'unknown' ? options.model : DEFAULT_GROK_MODEL;
  const flagList = runnerFlagsForTier('grok', options.safetyTier);
  const flagFragment = flagList.length ? ` ${flagList.join(' ')}` : '';
  const effortFlag = grokEffortFlag(options.effort);
  return `cd ${shellQuote(options.repo)} && ${options.binary}${flagFragment}${effortFlag} --model ${effectiveModel}`;
}

export function resolveGrokBinary(preferred?: string | null): string {
  if (preferred && preferred.trim()) return preferred.trim();
  return 'grok';
}

/**
 * Interactive refinement launch argv (roadmap/backlog tmux sessions).
 * Runner-name CLI syntax lives here — not in domain refinement modules.
 * Prompt content is read from `promptPath` at shell runtime via `cat`.
 */
export function buildInteractiveRefinementRunnerCommand(options: {
  runner: string;
  model?: string | null;
  promptPath: string;
  repo: string;
  safetyTier?: SafetyTier;
}): string | null {
  const runnerId = options.runner.trim();
  if (!runnerId) return null;
  const modelFlag = options.model?.trim() ? ` --model ${shellQuote(options.model.trim())}` : '';
  const promptArg = `"$(cat ${shellQuote(options.promptPath)})"`;
  const safetyFlags = runnerFlagsForTier(runnerId, options.safetyTier).map(shellQuote).join(' ');
  if (runnerId === 'codex') {
    const codexSafety = safetyFlags || '--sandbox workspace-write --ask-for-approval on-request';
    return [
      shellQuote(resolveCodexBinary()),
      `--cd ${shellQuote(options.repo)}`,
      codexSafety,
      modelFlag.trim(),
      promptArg,
    ]
      .filter(Boolean)
      .join(' ');
  }
  if (runnerId === 'cursor') {
    const flags = safetyFlags ? ` ${safetyFlags}` : '';
    return `${shellQuote(resolveCursorAgentBinary())} --workspace ${shellQuote(options.repo)}${flags}${modelFlag} ${promptArg}`;
  }
  if (runnerId === 'grok') {
    const flags = safetyFlags ? ` ${safetyFlags}` : '';
    return `${shellQuote(resolveGrokBinary())}${flags}${modelFlag} ${promptArg}`;
  }
  const flags = safetyFlags ? ` ${safetyFlags}` : '';
  return `${shellQuote(runnerId)}${flags}${modelFlag} ${promptArg}`;
}

/** Runners whose persisted sessions can be resumed via buildRunnerSessionReloadCommand. */
export function runnerSupportsSessionReload(runnerId: string): boolean {
  return runnerSessionReloadCapability(runnerId) !== 'none';
}

export function buildRunnerSessionReloadCommand(
  vars: Awaited<ReturnType<typeof loadSlotVars>>,
  runnerId: string,
  model: string | null | undefined,
  sessionId: string,
  opts: {
    repo?: string;
    taskDir?: string;
    effort?: string | null;
    safetyTier?: SafetyTier;
    runtimeDir?: string;
    codexAccountLabel?: string | null;
    codexAuthSource?: string | null;
    initialPrompt?: string;
  } = {},
): string {
  const runner = normalizeRunner(runnerId);
  const repo = opts.repo ?? vars.remoteRepo;
  const tier = opts.safetyTier ?? runnerDefaultSafetyTier(runner);
  const quotedSessionId = shellQuote(sessionId);
  const initialPrompt = opts.initialPrompt?.trim()
    ? ` ${shellQuote(opts.initialPrompt.trim())}`
    : '';

  if (runner === 'claude') {
    const installCommand = buildRunnerObservabilityInstallCommand(
      vars,
      runner,
      repo,
      opts.runtimeDir,
    );
    const modelFlag = model && model !== 'unknown' ? ` --model ${model}` : '';
    const flagList = runnerFlagsForTier(runner, tier);
    const flags = flagList.length ? ` ${flagList.join(' ')}` : '';
    const claudePath = vars.claudePath || 'claude';
    const settingsFlag = ` --settings ${shellExpressionForRemotePath(
      claudeObservabilitySettingsPath(repo, opts.runtimeDir ?? '.agent'),
    )}`;
    const settingsFallback = buildClaudeObservabilityFallbackCommand(
      claudeObservabilitySettingsPath(repo, opts.runtimeDir ?? '.agent'),
    );
    return withTaskRecipeTrustEnvironment(
      withRunnerObservabilityInstall(
        `cd ${shellExpressionForRemotePath(repo)} && unset CLAUDECODE && ${claudePath}${flags}${modelFlag}${settingsFlag} --resume ${quotedSessionId}${initialPrompt}`,
        installCommand,
        settingsFallback,
      ),
      repo,
      opts.taskDir,
    );
  }

  if (runner === 'codex') {
    const installCommand = buildRunnerObservabilityInstallCommand(
      vars,
      runner,
      repo,
      opts.runtimeDir,
      { accountLabel: opts.codexAccountLabel, authSource: opts.codexAuthSource },
    );
    const modelFlag = model && model !== 'unknown' ? ` --model ${model}` : '';
    const effortFlag = codexReasoningEffortFlag(opts.effort);
    const workerConfigFlags = codexWorkerConfigFlags();
    const flagList = runnerFlagsForTier(runner, tier);
    const flags = flagList.length ? ` ${flagList.join(' ')}` : '';
    const codexHomeSetup = buildCodexHomeSetup(repo, opts.runtimeDir ?? '.agent');
    return withTaskRecipeTrustEnvironment(
      withRunnerObservabilityInstall(
        `unset CLAUDECODE && cd ${shellQuote(repo)} && ${codexHomeSetup} && ${resolveCodexBinary(
          vars.codexPath,
        )}${CODEX_PLUGIN_HOOK_ARGS} resume${flags}${effortFlag}${workerConfigFlags}${modelFlag} ${quotedSessionId}${initialPrompt}`,
        installCommand,
      ),
      repo,
      opts.taskDir,
    );
  }

  if (runner === 'grok') {
    const modelFlag = model && model !== 'unknown' ? ` --model ${model}` : '';
    const effortFlag = grokEffortFlag(opts.effort);
    const flagList = runnerFlagsForTier(runner, tier);
    const flags = flagList.length ? ` ${flagList.join(' ')}` : '';
    return withTaskRecipeTrustEnvironment(
      `cd ${shellQuote(repo)} && ${resolveGrokBinary(
        vars.grokPath,
      )}${flags}${effortFlag}${modelFlag} --resume ${quotedSessionId}${initialPrompt}`,
      repo,
      opts.taskDir,
    );
  }

  throw new Error(`Runner '${runner}' does not support persisted session reload`);
}

export function assertRunnerLaunchPrerequisites(
  _vars: Awaited<ReturnType<typeof loadSlotVars>>,
  _runnerId?: string | null,
): void {
  // No runner-specific prerequisites today. Per-runner binary resolution
  // (resolveCodexBinary / resolveCursorAgentBinary / etc.) falls back to the
  // bare CLI name when the pool omits an explicit `*_path`, matching SSH
  // PATH lookup. Machines whose binary lives outside PATH (or under a
  // non-standard install location) must still
  // configure `<runner>_path` in their pool JSON; the failure surfaces at
  // launch time as a missing-binary error rather than here.
}

export function buildCodexHomeSetup(repo: string, runtimeDir = '.agent'): string {
  const codexHome = path.posix.join(repo, runtimeDir, 'codex-home');
  // Codex refuses to start when CODEX_HOME points at a non-existent dir ("Error
  // finding codex home"), which leaves dispatch with an empty pane and a false
  // ready-timeout. The observability install (bootstrapCodexHome) provisions this
  // isolated home (auth + isolated config.toml with hook-trust + hooks.json) so the
  // host's ~/.codex config is never written. Use it ONLY when that install actually
  // provisioned it (auth present); otherwise fall back to the global ~/.codex with no
  // farmslot observability, so a codex worker launches regardless. We never create or
  // write the home here — that keeps the global config clean and avoids a half-built
  // home that codex would reject.
  return (
    `if [ -e ${shellQuote(`${codexHome}/auth.json`)} ]; then export CODEX_HOME=${shellQuote(codexHome)}; FARMSLOT_CODEX_PLUGIN_HOOK_ARG_1='--config'; FARMSLOT_CODEX_PLUGIN_HOOK_ARG_2='features.hooks=true'; ` +
    `else unset CODEX_HOME; FARMSLOT_CODEX_PLUGIN_HOOK_ARG_1='--disable'; FARMSLOT_CODEX_PLUGIN_HOOK_ARG_2='plugin_hooks'; echo "[farmslot] codex-home not provisioned; using global ~/.codex without observability" >&2; fi`
  );
}

export function buildCodexExecLaunch(options: {
  binary: string;
  model?: string | null;
  effort?: string | null;
  prompt?: string;
  repo: string;
  runtimeDir?: string;
  /** Safety tier (ADR-023). Omit to let `runnerFlagsForTier` apply the codex default (`sandboxed`). */
  safetyTier?: SafetyTier;
}): string {
  const modelFlag = options.model && options.model !== 'unknown' ? ` --model ${options.model}` : '';
  const effortFlag = codexReasoningEffortFlag(options.effort);
  const workerConfigFlags = codexWorkerConfigFlags();
  const flagList = runnerFlagsForTier('codex', options.safetyTier);
  const flagFragment = flagList.length ? ` ${flagList.join(' ')}` : '';
  const prompt = options.prompt?.trim() ? ` ${shellQuote(options.prompt)}` : '';
  const codexHomeSetup = buildCodexHomeSetup(options.repo, options.runtimeDir ?? '.agent');
  return `unset CLAUDECODE && cd ${shellQuote(options.repo)} && ${codexHomeSetup} && ${options.binary}${CODEX_PLUGIN_HOOK_ARGS}${flagFragment}${effortFlag}${workerConfigFlags}${modelFlag}${prompt}`;
}

function codexReasoningEffortFlag(effort?: string | null): string {
  const normalized = effort?.trim().toLowerCase();
  // Explicit `auto` leaves Codex config untouched (CLI / config.toml default).
  if (normalized === 'auto') return '';
  const effective = normalized || DEFAULT_CODEX_EFFORT;
  if (!CODEX_REASONING_EFFORTS.has(effective)) {
    throw new Error(`Invalid Codex reasoning effort: ${effort}`);
  }
  return ` --config ${shellQuote(`model_reasoning_effort="${effective}"`)}`;
}

function grokEffortFlag(effort?: string | null): string {
  const normalized = effort?.trim();
  // Explicit `auto` leaves Grok config untouched.
  if (normalized?.toLowerCase() === 'auto') return '';
  const effective = normalized || DEFAULT_GROK_EFFORT;
  return ` --effort ${effective}`;
}

function codexWorkerConfigFlags(): string {
  // Do not inject `mcp_servers.<name>.enabled=false` for arbitrary server
  // names. Newer Codex versions reject partial MCP tables when the server is
  // not already defined in the node's config, which breaks portable dispatch.
  return '';
}

export function resolveCodexBinary(preferred?: string | null): string {
  if (preferred && preferred.trim()) return preferred.trim();
  return 'codex';
}

/**
 * Detect whether the pool's dispatch_cmd is runner-aware — i.e. it already
 * references the runner binary via {runner_path}, {runner}, or a
 * runner-specific placeholder such as {codex_path}/{opencode_path}/{cursor_path}/{grok_path}.
 *
 * Consumers never branch on this directly — it's absorbed into
 * {@link buildLaunchCommand} so every call site gets identical semantics.
 */
function dispatchCmdIsRunnerAware(dispatchCmd: string | undefined | null, runner: string): boolean {
  if (!dispatchCmd) return false;
  if (dispatchCmd.includes('{runner_path}') || dispatchCmd.includes('{runner}')) {
    return true;
  }
  if (runner === 'codex' && dispatchCmd.includes('{codex_path}')) return true;
  if (runner === 'opencode' && dispatchCmd.includes('{opencode_path}')) return true;
  if (runner === 'cursor' && dispatchCmd.includes('{cursor_path}')) return true;
  if (runner === 'grok' && dispatchCmd.includes('{grok_path}')) return true;
  return false;
}

export interface ScriptedCommandLaunchConfig {
  command: string;
  timeoutMs?: number;
  cwd?: string;
}

function buildScriptedRunnerLaunch(options: {
  repo: string;
  projectName: string;
  taskDir: string;
  scripted: ScriptedRunnerConfig;
  command?: ScriptedCommandLaunchConfig;
}): string {
  const base = [
    'FARMSLOT_ROOT="$PWD"',
    ...(options.scripted.mode === 'scenario' ? ['FARMSLOT_ENABLE_SCRIPTED_SCENARIOS=1'] : []),
    'node',
    '"$PWD/packages/cli/bin/farmslot.mjs"',
    'scripted-runner',
    '--task-dir',
    shellQuote(options.taskDir),
  ];
  if (options.scripted.mode === 'scenario') {
    base.push('--mode', 'scenario', '--scenario', options.scripted.scenario);
    if (options.scripted.stepDelayMs !== undefined) {
      base.push('--step-delay-ms', String(options.scripted.stepDelayMs));
    }
  } else {
    if (!options.command) {
      throw new Error(`scripted command mode requires a resolved project commandRef`);
    }
    base.push('--mode', 'command', '--project', shellQuote(options.projectName));
    base.push('--command-ref', shellQuote(options.scripted.commandRef));
    const timeoutMs = options.scripted.timeoutMs ?? options.command.timeoutMs;
    if (timeoutMs !== undefined) base.push('--timeout-ms', String(timeoutMs));
  }
  return `cd ${shellQuote(options.repo)} && ${base.join(' ')}`;
}

export interface BuildLaunchOptions {
  /** Override the repo used for inline `cd` (defaults to `vars.remoteRepo`). */
  repo?: string;
  /** Relative path to the TASK.md passed to dispatch_cmd expansion. */
  taskFile?: string;
  /** Reasoning effort passed through to dispatch_cmd expansion. */
  effort?: string;
  /** Relative worker task directory consumed by exec-mode runners such as `scripted`. */
  taskDir?: string;
  /** Required when runner is scripted. */
  scripted?: ScriptedRunnerConfig;
  /** Resolved project-owned command for scripted.command mode. */
  scriptedCommand?: ScriptedCommandLaunchConfig;
  /**
   * When true, the Claude runner routes through `expandDispatchCmd` and
   * requires a pool `dispatch_cmd` (production dispatch flow).
   * When false (default), the Claude runner is launched inline via its
   * configured binary + tier-driven flags — used by relaunch paths
   * (self-review, CI follow-up) that always bypass the dispatch template.
   */
  claudeUsesDispatchCmd?: boolean;
  /**
   * Runner execution safety tier (ADR-023). Overrides the runner's fallback.
   * When omitted, `runnerDefaultSafetyTier(runnerId)` is consulted.
   */
  safetyTier?: SafetyTier;
  /** Project runtime directory that owns observability files (defaults to .agent). */
  runtimeDir?: string;
  /**
   * Provider account label resolved for this launch. Installer expands the
   * credential path on the execution host (multi-node safe). Does not change
   * buildCodexHomeSetup output.
   */
  codexAccountLabel?: string | null;
  /**
   * Optional explicit auth.json path override (tests). Prefer codexAccountLabel.
   */
  codexAuthSource?: string | null;
}

/**
 * Construct the shell command used to launch a runner inside a tmux pane.
 *
 * Single source of truth across dispatch, self-review, and CI-watch relaunch
 * sites. Callers pass the runner id + prompt; the function absorbs
 * `expandDispatchCmd` routing, runner-aware-dispatch detection, and
 * per-runner inline flag selection via the capability registry.
 */
export function buildLaunchCommand(
  vars: Awaited<ReturnType<typeof loadSlotVars>>,
  runnerId: string,
  model: string | null | undefined,
  prompt: string,
  opts: BuildLaunchOptions = {},
): string {
  const runner = normalizeRunner(runnerId);
  const repo = opts.repo ?? vars.remoteRepo;
  const hasDispatchCmd = Boolean(vars.dispatchCmd);
  const cmdIsRunnerAware = dispatchCmdIsRunnerAware(vars.dispatchCmd, runner);
  const cmdHasModelPlaceholder = hasDispatchCmd && vars.dispatchCmd.includes('{model}');
  const modelFlag = model && model !== 'unknown' ? ` --model ${model}` : '';
  const tier = opts.safetyTier ?? runnerDefaultSafetyTier(runner);
  const launchPrompt = runnerNeedsPostLaunchPrompt(runner) ? '' : prompt;

  const withRecipeTrust = (command: string): string =>
    withTaskRecipeTrustEnvironment(
      command,
      repo,
      opts.taskDir ?? (opts.taskFile ? path.posix.dirname(opts.taskFile) : undefined),
    );

  // none runner: no launch command (silent sentinel; callers decide what to do).
  if (runner === 'none') return '';

  // scripted runner: checkout-local non-LLM harness; ignores dispatch_cmd entirely.
  if (runner === 'scripted') {
    if (!opts.taskDir) {
      throw new Error(`Runner 'scripted' requires opts.taskDir to locate the task directory`);
    }
    if (!opts.scripted) {
      throw new Error(`Runner 'scripted' requires opts.scripted`);
    }
    return withRecipeTrust(
      buildScriptedRunnerLaunch({
        repo,
        projectName: vars.projectName,
        taskDir: opts.taskDir,
        scripted: opts.scripted,
        command: opts.scriptedCommand,
      }),
    );
  }

  const safetyFlagsString = runnerFlagsForTier(runner, tier).join(' ');
  // Resolve defaults before template expansion so `{effort}` placeholders get xhigh
  // for codex/grok when the operator left effort unset.
  const resolvedEffort = resolveRunnerEffort(runner, opts.effort);
  const expanded = hasDispatchCmd
    ? expandDispatchCmd(vars, {
        runner,
        model: model ?? undefined,
        taskFile: opts.taskFile,
        taskPrompt: launchPrompt,
        effort: resolvedEffort,
        safetyFlags: safetyFlagsString,
      })
    : '';

  // Claude: either route through dispatch_cmd (production dispatch) or launch
  // inline via its configured binary + inline flags (relaunch paths).
  if (runner === 'claude') {
    const installCommand = buildRunnerObservabilityInstallCommand(
      vars,
      runner,
      repo,
      opts.runtimeDir,
    );
    const settingsFlag = ` --settings ${shellExpressionForRemotePath(
      claudeObservabilitySettingsPath(repo, opts.runtimeDir ?? '.agent'),
    )}`;
    const settingsFallback = buildClaudeObservabilityFallbackCommand(
      claudeObservabilitySettingsPath(repo, opts.runtimeDir ?? '.agent'),
    );
    if (opts.claudeUsesDispatchCmd) {
      if (!hasDispatchCmd) {
        throw new Error(`No dispatch_cmd in pool config for ${vars.machine}`);
      }
      if (
        !vars.dispatchCmd.includes('{runner_path}') &&
        !vars.dispatchCmd.includes('{claude_path}')
      ) {
        throw new Error(
          `Claude dispatch_cmd on ${vars.machine} must include {runner_path} or {claude_path} so runtime arguments target the runner executable`,
        );
      }
      const runnerArgs = [cmdHasModelPlaceholder ? '' : modelFlag.trim(), settingsFlag.trim()]
        .filter(Boolean)
        .join(' ');
      const claudeDispatchCommand = expandDispatchCmd(vars, {
        runner,
        model: model ?? undefined,
        taskFile: opts.taskFile,
        taskPrompt: launchPrompt,
        effort: resolvedEffort,
        safetyFlags: safetyFlagsString,
        runnerArgs,
      });
      return withRecipeTrust(
        withRunnerObservabilityInstall(
          `unset CLAUDECODE && ${claudeDispatchCommand}`,
          installCommand,
          settingsFallback,
        ),
      );
    }
    const claudePath = vars.claudePath || 'claude';
    const flagList = runnerFlagsForTier(runner, tier);
    const flags = flagList.join(' ');
    return withRecipeTrust(
      withRunnerObservabilityInstall(
        `cd ${shellExpressionForRemotePath(repo)} && unset CLAUDECODE && ${claudePath}${flags ? ` ${flags}` : ''}${modelFlag}${settingsFlag}`,
        installCommand,
        settingsFallback,
      ),
    );
  }

  // Codex: route through dispatch_cmd when it's runner-aware; otherwise fall
  // back to the inline exec-mode launcher (keeps working on pools that only
  // know about Claude-shaped dispatch templates).
  if (runner === 'codex') {
    const installCommand = buildRunnerObservabilityInstallCommand(
      vars,
      runner,
      repo,
      opts.runtimeDir,
      { accountLabel: opts.codexAccountLabel, authSource: opts.codexAuthSource },
    );
    if (cmdIsRunnerAware) {
      return withRecipeTrust(
        withRunnerObservabilityInstall(
          `unset CLAUDECODE && ${buildCodexHomeSetup(repo, opts.runtimeDir)} && ${injectCodexReasoningEffortFlag(expanded, vars, opts.effort)}`,
          installCommand,
        ),
      );
    }
    // Use the configured codex_path when present; otherwise leave resolution to
    // the worker shell's PATH. Do not infer a Node-sibling binary because asdf
    // toolchains can leave stale Codex installs beside older Node versions.
    return withRecipeTrust(
      withRunnerObservabilityInstall(
        buildCodexExecLaunch({
          binary: resolveCodexBinary(vars.codexPath),
          model,
          effort: opts.effort, // buildCodexExecLaunch applies DEFAULT_CODEX_EFFORT when omitted
          prompt: launchPrompt,
          repo,
          runtimeDir: opts.runtimeDir,
          safetyTier: tier,
        }),
        installCommand,
      ),
    );
  }

  // Cursor Agent: route through runner-aware dispatch templates when configured,
  // otherwise use the inline TUI-first launcher. The task prompt is delivered
  // after the interactive composer is ready.
  if (runner === 'cursor') {
    if (cmdIsRunnerAware) {
      return withRecipeTrust(expanded);
    }
    return withRecipeTrust(
      buildCursorAgentLaunch({
        binary: resolveCursorAgentBinary(vars.cursorPath),
        model,
        prompt,
        repo,
        safetyTier: tier,
      }),
    );
  }

  // Grok Build CLI: same interactive contract as Cursor. Launch the TUI first
  // and deliver the task prompt after the composer is ready.
  if (runner === 'grok') {
    if (cmdIsRunnerAware) {
      return withRecipeTrust(expanded);
    }
    return withRecipeTrust(
      buildGrokLaunch({
        binary: resolveGrokBinary(vars.grokPath),
        model,
        effort: opts.effort,
        prompt,
        repo,
        safetyTier: tier,
      }),
    );
  }

  // Any other runner (opencode + future additions): must have a runner-aware
  // dispatch_cmd — there is no inline fallback.
  if (!cmdIsRunnerAware) {
    throw new Error(
      `Runner '${runner}' requires a runner-aware dispatch_cmd on ${vars.machine}. ` +
        `Use {runner_path} or a runner-specific placeholder such as {opencode_path}/{cursor_path}/{grok_path}.`,
    );
  }
  return withRecipeTrust(`unset CLAUDECODE && ${expanded}`);
}

function injectCodexReasoningEffortFlag(
  command: string,
  vars: Awaited<ReturnType<typeof loadSlotVars>>,
  effort?: string | null,
): string {
  const workerConfigFlags = codexWorkerConfigFlags();
  if (command.includes('mcp_servers.n8n-mcp.enabled=false')) {
    return injectCodexWorkerConfigFlags(command, vars, CODEX_PLUGIN_HOOK_ARGS);
  }
  if (command.includes('model_reasoning_effort')) {
    return injectCodexWorkerConfigFlags(
      command,
      vars,
      `${CODEX_PLUGIN_HOOK_ARGS}${workerConfigFlags}`,
    );
  }
  const effortFlag = codexReasoningEffortFlag(effort);
  const flags = `${CODEX_PLUGIN_HOOK_ARGS}${effortFlag}${workerConfigFlags}`;
  return injectCodexWorkerConfigFlags(command, vars, flags);
}

function injectCodexWorkerConfigFlags(
  command: string,
  vars: Awaited<ReturnType<typeof loadSlotVars>>,
  flags: string,
): string {
  const configuredPath = vars.codexPath?.trim();
  if (configuredPath && command.includes(configuredPath)) {
    return command.replace(configuredPath, `${configuredPath}${flags}`);
  }
  // Inline fallback intentionally targets the bare PATH-resolved `codex`
  // command. Configured absolute paths are handled above, so this regex does
  // not need to match `/path/to/codex`.
  return command.replace(/(^|[\s;&|])(codex)(?=$|[\s;&|])/u, `$1$2${flags}`);
}
