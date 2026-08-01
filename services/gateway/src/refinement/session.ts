// Domain-neutral refinement session launch/attach helpers shared by roadmap and backlog.

import { execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import type { SafetyTier, TmuxWorkerRef } from '@farmslot/protocol';

import { isLocal } from '../core/exec.js';
import { assertNoUnknownPlaceholders } from '../core/hooks.js';
import { farmslotRoot, loadPoolConfigs } from '../fleet/state.js';
import { runnerFlagsForTier } from '../runners/registry.js';

const execFileAsync = promisify(execFile);

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export async function tmuxSessionExists(session: string): Promise<boolean> {
  try {
    await execFileAsync('tmux', ['has-session', '-t', `=${session}`]);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException & { code?: number }).code === 1) return false;
    throw err;
  }
}

async function localTmuxWorkerNodeId(): Promise<string> {
  const pools = await loadPoolConfigs();
  const localPool = pools.find((pool) => isLocal(pool.host, pool.machine));
  return localPool?.machine ?? os.hostname().replace(/\.local$/, '');
}

export async function resolveTmuxSessionWorker(session: string): Promise<TmuxWorkerRef> {
  const { stdout } = await execFileAsync('tmux', [
    'list-panes',
    '-t',
    `=${session}`,
    '-F',
    '#{session_name}\t#{window_index}\t#{window_name}\t#{pane_index}\t#{pane_id}',
  ]);
  const [line] = stdout.split('\n').filter(Boolean);
  if (!line) throw new Error(`tmux session ${session} has no panes`);
  const [sessionName, window, windowName, pane, paneId] = line.split('\t');
  const target = paneId || `${sessionName}:${window}.${pane}`;
  return {
    nodeId: await localTmuxWorkerNodeId(),
    session: sessionName,
    window,
    ...(windowName ? { windowName } : {}),
    pane,
    ...(paneId ? { paneId } : {}),
    target,
  };
}

export function defaultRefinementRunnerCommand(
  runner: string | undefined,
  model: string | undefined,
  promptPath: string,
  safetyTier?: SafetyTier,
): string | null {
  const runnerId = runner?.trim();
  if (!runnerId) return null;
  const modelFlag = model?.trim() ? ` --model ${shellQuote(model.trim())}` : '';
  const promptArg = `"$(cat ${shellQuote(promptPath)})"`;
  const safetyFlags = runnerFlagsForTier(runnerId, safetyTier).map(shellQuote).join(' ');
  if (runnerId === 'codex') {
    const codexSafety = safetyFlags || '--sandbox workspace-write --ask-for-approval on-request';
    return [
      shellQuote('codex'),
      `--cd ${shellQuote(farmslotRoot)}`,
      codexSafety,
      modelFlag.trim(),
      promptArg,
    ]
      .filter(Boolean)
      .join(' ');
  }
  if (runnerId === 'cursor') {
    const flags = safetyFlags ? ` ${safetyFlags}` : '';
    return `${shellQuote('cursor-agent')} --workspace ${shellQuote(farmslotRoot)}${flags}${modelFlag} ${promptArg}`;
  }
  const flags = safetyFlags ? ` ${safetyFlags}` : '';
  return `${shellQuote(runnerId)}${flags}${modelFlag} ${promptArg}`;
}

export function expandRefinementRunnerCommand(
  command: string,
  context: {
    runner?: string;
    model?: string;
    promptPath: string;
    itemFile: string;
    safetyTier?: SafetyTier;
  },
  label = 'Refinement command',
): string {
  const replacements: Record<string, string> = {
    runner: shellQuote(context.runner ?? ''),
    model: shellQuote(context.model ?? ''),
    prompt_path: shellQuote(context.promptPath),
    item_file: shellQuote(context.itemFile),
    safety_tier: shellQuote(context.safetyTier ?? ''),
    safety_flags: runnerFlagsForTier(context.runner ?? '', context.safetyTier)
      .map(shellQuote)
      .join(' '),
  };
  assertNoUnknownPlaceholders(command, Object.keys(replacements), label);
  let expanded = command;
  for (const [key, value] of Object.entries(replacements)) {
    expanded = expanded.replaceAll(`{{${key}}}`, value);
  }
  if (!command.includes('{{prompt_path}}'))
    expanded = `${expanded} ${shellQuote(context.promptPath)}`;
  return expanded;
}

export function buildRefinementShellCommand(params: {
  promptPath: string;
  itemFile: string;
  runnerCommand?: string;
  runner?: string;
  model?: string;
  safetyTier?: SafetyTier;
  /** Shell fragment after cd, before the runner (env exports, etc.). */
  prelude: string;
  fallbackMessages: string[];
  commandLabel?: string;
}): string {
  const absolutePromptPath = pathResolve(params.promptPath);
  const absoluteItemFile = pathResolve(params.itemFile);
  const commandTemplate = params.runnerCommand?.trim();
  const defaultCommand = defaultRefinementRunnerCommand(
    params.runner,
    params.model,
    absolutePromptPath,
    params.safetyTier,
  );
  const prelude = params.prelude;
  if (commandTemplate) {
    return `cd ${shellQuote(farmslotRoot)} && ${prelude} && ${expandRefinementRunnerCommand(
      commandTemplate,
      {
        ...(params.runner ? { runner: params.runner } : {}),
        ...(params.model ? { model: params.model } : {}),
        ...(params.safetyTier ? { safetyTier: params.safetyTier } : {}),
        promptPath: absolutePromptPath,
        itemFile: absoluteItemFile,
      },
      params.commandLabel ?? 'Refinement command',
    )}`;
  }
  if (defaultCommand)
    return `cd ${shellQuote(farmslotRoot)} && ${prelude} && exec ${defaultCommand}`;
  return [
    `cd ${shellQuote(farmslotRoot)}`,
    prelude,
    ...params.fallbackMessages.map((message) => `printf '%s\\n' ${shellQuote(message)}`),
    'exec ${SHELL:-zsh} -l',
  ].join(' && ');
}

function pathResolve(filePath: string): string {
  return path.resolve(farmslotRoot, filePath);
}

export async function launchRefinementTmuxSession(params: {
  session: string;
  shellCommand: string;
}): Promise<boolean> {
  if (await tmuxSessionExists(params.session)) return false;
  await execFileAsync('tmux', [
    'new-session',
    '-d',
    '-s',
    params.session,
    '-c',
    farmslotRoot,
    params.shellCommand,
  ]);
  return true;
}

export function attachCommandForSession(session: string): string {
  return `tmux attach -t ${shellQuote(`=${session}`)}`;
}
