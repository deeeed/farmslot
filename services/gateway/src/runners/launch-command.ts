import { DEFAULT_CURSOR_MODEL, type SafetyTier } from '@farmslot/protocol';

import type { loadSlotVars } from '../core/config.js';
import { expandDispatchCmd } from '../core/hooks.js';
import { shellQuote } from '../core/tmux.js';

import {
  normalizeRunner,
  runnerDefaultSafetyTier,
  runnerFlagsForTier,
  runnerNeedsPostLaunchPrompt,
} from './registry.js';

const CODEX_REASONING_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh']);

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
  return `cd ${shellQuote(options.repo)} && ${options.binary}${flagFragment} --model ${effectiveModel}`;
}

export function resolveCursorAgentBinary(preferred?: string | null): string {
  if (preferred && preferred.trim()) return preferred.trim();
  return 'agent';
}

export function assertRunnerLaunchPrerequisites(
  _vars: Awaited<ReturnType<typeof loadSlotVars>>,
  _runnerId?: string | null,
): void {
  // No runner-specific prerequisites today. Per-runner binary resolution
  // (resolveCodexBinary / resolveCursorAgentBinary / etc.) falls back to the
  // bare CLI name when the pool omits an explicit `*_path`, matching SSH
  // PATH lookup. Machines whose binary lives outside PATH (or under a
  // non-canonical name like `agent` instead of `cursor-agent`) must still
  // configure `<runner>_path` in their pool JSON; the failure surfaces at
  // launch time as a missing-binary error rather than here.
}

export function buildCodexExecLaunch(options: {
  binary: string;
  model?: string | null;
  effort?: string | null;
  prompt?: string;
  repo: string;
  /** Safety tier (ADR-023). Omit to let `runnerFlagsForTier` apply the codex default (`sandboxed`). */
  safetyTier?: SafetyTier;
}): string {
  const modelFlag = options.model && options.model !== 'unknown' ? ` --model ${options.model}` : '';
  const effortFlag = codexReasoningEffortFlag(options.effort);
  const workerConfigFlags = codexWorkerConfigFlags();
  const flagList = runnerFlagsForTier('codex', options.safetyTier);
  const flagFragment = flagList.length ? ` ${flagList.join(' ')}` : '';
  const prompt = options.prompt?.trim() ? ` ${shellQuote(options.prompt)}` : '';
  return `unset CLAUDECODE && cd '${options.repo}' && ${options.binary}${flagFragment}${effortFlag}${workerConfigFlags}${modelFlag}${prompt}`;
}

function codexReasoningEffortFlag(effort?: string | null): string {
  const normalized = effort?.trim().toLowerCase();
  if (!normalized || normalized === 'auto') return '';
  if (!CODEX_REASONING_EFFORTS.has(normalized)) {
    throw new Error(`Invalid Codex reasoning effort: ${effort}`);
  }
  return ` --config ${shellQuote(`model_reasoning_effort="${normalized}"`)}`;
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
 * runner-specific placeholder such as {codex_path}/{opencode_path}/{cursor_path}.
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
  return false;
}

export interface BuildLaunchOptions {
  /** Override the repo used for inline `cd` (defaults to `vars.remoteRepo`). */
  repo?: string;
  /** Relative path to the TASK.md passed to dispatch_cmd expansion. */
  taskFile?: string;
  /** Reasoning effort passed through to dispatch_cmd expansion. */
  effort?: string;
  /**
   * Required when `runner === 'fake'`: the relative task directory the fake
   * runner consumes (e.g. `.task/fix/…`).
   */
  taskDir?: string;
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
  /**
   * Embed the prompt into a headless print-style launch when the runner supports it.
   * Omit for persistent interactive worker/relaunch paths that need tmux nudges.
   */
  headlessPrintPrompt?: boolean;
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

  // none runner: no launch command (silent sentinel; callers decide what to do).
  if (runner === 'none') return '';

  // fake runner: self-contained npx harness; ignores dispatch_cmd entirely.
  if (runner === 'fake') {
    if (!opts.taskDir) {
      throw new Error(`Runner 'fake' requires opts.taskDir to locate the harness task directory`);
    }
    return `cd '${repo}' && npx farmslot fake-runner --task-dir '${opts.taskDir}' --scenario success --step-delay-ms 500`;
  }

  const safetyFlagsString = runnerFlagsForTier(runner, tier).join(' ');
  const expanded = hasDispatchCmd
    ? expandDispatchCmd(vars, {
        runner,
        model: model ?? undefined,
        taskFile: opts.taskFile,
        taskPrompt: launchPrompt,
        effort: opts.effort,
        safetyFlags: safetyFlagsString,
      })
    : '';

  // Claude: either route through dispatch_cmd (production dispatch) or launch
  // inline via its configured binary + inline flags (relaunch paths).
  if (runner === 'claude') {
    if (opts.claudeUsesDispatchCmd) {
      if (!hasDispatchCmd) {
        throw new Error(`No dispatch_cmd in pool config for ${vars.machine}`);
      }
      return `unset CLAUDECODE && ${expanded}${cmdHasModelPlaceholder ? '' : modelFlag}`;
    }
    const claudePath = vars.claudePath || 'claude';
    const flagList = runnerFlagsForTier(runner, tier);
    const flags = flagList.join(' ');
    const headlessFlags = opts.headlessPrintPrompt ? ' --disable-slash-commands' : '';
    const promptArg =
      opts.headlessPrintPrompt && prompt.trim() ? ` --print ${shellQuote(prompt)}` : '';
    return `cd '${repo}' && unset CLAUDECODE && ${claudePath}${flags ? ` ${flags}` : ''}${modelFlag}${headlessFlags}${promptArg}`;
  }

  // Codex: route through dispatch_cmd when it's runner-aware; otherwise fall
  // back to the inline exec-mode launcher (keeps working on pools that only
  // know about Claude-shaped dispatch templates).
  if (runner === 'codex') {
    if (cmdIsRunnerAware) {
      return `unset CLAUDECODE && ${injectCodexReasoningEffortFlag(expanded, vars, opts.effort)}`;
    }
    // Use the configured codex_path when present; otherwise leave resolution to
    // the worker shell's PATH. Do not infer a Node-sibling binary because asdf
    // toolchains can leave stale Codex installs beside older Node versions.
    return buildCodexExecLaunch({
      binary: resolveCodexBinary(vars.codexPath),
      model,
      effort: opts.effort,
      prompt: launchPrompt,
      repo,
      safetyTier: tier,
    });
  }

  // Cursor Agent: route through runner-aware dispatch templates when configured,
  // otherwise use the inline TUI-first argv-prompt launcher. The default model
  // is runner-owned (`composer-2`) rather than borrowed from Claude/Codex.
  if (runner === 'cursor') {
    if (cmdIsRunnerAware) {
      return expanded;
    }
    return buildCursorAgentLaunch({
      binary: resolveCursorAgentBinary(vars.cursorPath),
      model,
      prompt,
      repo,
      safetyTier: tier,
    });
  }

  // Any other runner (opencode + future additions): must have a runner-aware
  // dispatch_cmd — there is no inline fallback.
  if (!cmdIsRunnerAware) {
    throw new Error(
      `Runner '${runner}' requires a runner-aware dispatch_cmd on ${vars.machine}. ` +
        `Use {runner_path} or a runner-specific placeholder such as {opencode_path}/{cursor_path}.`,
    );
  }
  return `unset CLAUDECODE && ${expanded}`;
}

function injectCodexReasoningEffortFlag(
  command: string,
  vars: Awaited<ReturnType<typeof loadSlotVars>>,
  effort?: string | null,
): string {
  const workerConfigFlags = codexWorkerConfigFlags();
  if (command.includes('mcp_servers.n8n-mcp.enabled=false')) {
    return command;
  }
  if (command.includes('model_reasoning_effort')) {
    return injectCodexWorkerConfigFlags(command, vars, workerConfigFlags);
  }
  const effortFlag = codexReasoningEffortFlag(effort);
  const flags = `${effortFlag}${workerConfigFlags}`;
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
