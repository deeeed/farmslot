// core/hooks.ts — Hook and template expansion
// TypeScript port of lib/slot-common.sh: expand_hook, expand_template, expand_platform_field, render_fixture_template

import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { normalizeRunner } from '../runners/registry.js';

import { farmslotRoot, type ProjectVars, type RawProjectJson, type SlotVars } from './config.js';

const localHostname = os.hostname().replace(/\.local$/, '');

// ─── expandTemplate ───
// Substitutes all {{VAR}} placeholders in a string using resourceVars dynamically.

// Node deployment dir on remote machines (scripts + tools synced by deploy-node.sh)
const REMOTE_AGENT_DIR = '~/farmslot-node';

export function expandTemplate(
  template: string,
  slotVars: SlotVars,
  projectVars?: ProjectVars,
): string {
  return expandTemplateInternal(template, slotVars, projectVars, true);
}

function expandTemplateInternal(
  template: string,
  slotVars: SlotVars,
  projectVars: ProjectVars | undefined,
  includeProjectTemplateVars: boolean,
): string {
  let result = template;
  // Dynamic resource vars
  for (const [field, value] of Object.entries(slotVars.resourceVars)) {
    result = result.replaceAll(`{{${field}}}`, value);
    // Also support uppercase form (e.g. {{PLATFORM}}, {{ADB_SERIAL}})
    result = result.replaceAll(`{{${field.toUpperCase()}}}`, value);
  }
  // Optional resource placeholders are valid even when a slot does not carry
  // that resource (for example iOS slots have no adb_serial/avd). Match the
  // shell fixture-sync path by rendering missing optional resources as empty.
  for (const field of [
    'port',
    'cdp_port',
    'simulator',
    'avd',
    'adb_serial',
    'headless',
    'snapshot',
  ]) {
    result = result.replaceAll(`{{${field}}}`, '');
    result = result.replaceAll(`{{${field.toUpperCase()}}}`, '');
  }
  // Project-level vars
  const runtimeDir = projectVars?.runtimeDir ?? '.agent';
  const artifactDir = projectVars?.artifactDir ?? '.task';
  const recipeDir = projectVars?.recipeDir ?? `${runtimeDir}/recipes`;
  result = result.replaceAll('{{runtime_dir}}', runtimeDir);
  result = result.replaceAll('{{RUNTIME_DIR}}', runtimeDir);
  result = result.replaceAll('{{artifact_dir}}', artifactDir);
  result = result.replaceAll('{{ARTIFACT_DIR}}', artifactDir);
  result = result.replaceAll('{{recipe_dir}}', recipeDir);
  result = result.replaceAll('{{RECIPE_DIR}}', recipeDir);
  // farmslot_dir: local = repo root, remote = agent deployment dir
  const slotHost = slotVars.host.replace(/\.local$/, '');
  const isLocal =
    slotHost === 'localhost' || slotHost === '127.0.0.1' || slotHost === localHostname;
  const farmslotDir = isLocal ? farmslotRoot : REMOTE_AGENT_DIR;
  result = result.replaceAll('{{farmslot_dir}}', farmslotDir);
  result = result.replaceAll('{{FARMSLOT_DIR}}', farmslotDir);
  // Legacy aliases
  const port = slotVars.resourceVars.port ?? '';
  result = result.replaceAll('{{WATCHER_PORT}}', port);
  result = result.replaceAll('{{watcher_port}}', port);
  // SESSION = configured tmux session name. Do not infer it from slot id:
  // machine ids can contain hyphens and session names are independently configured.
  const session = slotVars.session;
  result = result.replaceAll('{{SLOT_ID}}', slotVars.slotId);
  result = result.replaceAll('{{slot_id}}', slotVars.slotId);
  result = result.replaceAll('{{SESSION}}', session);
  result = result.replaceAll('{{session}}', session);
  // REPO = slot checkout path; primary_repo = canonical project tree (worktree sandboxes).
  result = result.replaceAll('{{REPO}}', slotVars.repo);
  result = result.replaceAll('{{repo}}', slotVars.repo);
  const primaryRepo =
    typeof projectVars?.projectJson.primary_repo === 'string' &&
    projectVars.projectJson.primary_repo.trim()
      ? projectVars.projectJson.primary_repo.trim()
      : slotVars.repo;
  result = result.replaceAll('{{primary_repo}}', primaryRepo);
  result = result.replaceAll('{{PRIMARY_REPO}}', primaryRepo);
  // Reference repos — derive path from slot repo parent + local_name
  if (projectVars?.projectJson.reference_repos) {
    const repoParent = path.dirname(slotVars.repo);
    for (const [key, ref] of Object.entries(projectVars.projectJson.reference_repos)) {
      const refPath = path.join(repoParent, ref.local_name);
      const placeholder = `${key}_repo`;
      result = result.replaceAll(`{{${placeholder}}}`, refPath);
      result = result.replaceAll(`{{${placeholder.toUpperCase()}}}`, refPath);
    }
  }
  if (includeProjectTemplateVars && projectVars?.projectJson.vars) {
    for (const [key, rawValue] of Object.entries(projectVars.projectJson.vars)) {
      const value = expandTemplateInternal(String(rawValue), slotVars, projectVars, false);
      result = result.replaceAll(`{{${key}}}`, value);
      result = result.replaceAll(`{{${key.toUpperCase()}}}`, value);
    }
  }
  return result;
}

// ─── expandHook ───
// Reads hooks.<hookName> from project.json, substitutes slot variables.
// Returns empty string if hook not defined.

export function expandHook(
  hookName: string,
  projectJson: RawProjectJson,
  slotVars: SlotVars,
  projectVars?: ProjectVars,
): string {
  const cmd = projectJson.hooks?.[hookName];
  if (!cmd || typeof cmd !== 'string') return '';
  return expandTemplate(cmd, slotVars, projectVars);
}

// ─── expandPlatformField ───
// Reads platforms.<platform>.<field> from project.json, substitutes vars.

export function expandPlatformField(
  field: string,
  projectJson: RawProjectJson,
  slotVars: SlotVars,
  projectVars?: ProjectVars,
): string {
  const platform = slotVars.platform;
  const value = projectJson.platforms?.[platform]?.[field];
  if (!value) return '';
  return expandTemplate(value, slotVars, projectVars);
}

export interface DispatchCommandContext {
  runner?: string;
  model?: string;
  taskFile?: string;
  taskPrompt?: string;
  effort?: string;
  /**
   * Runner safety-tier flags (ADR-023). When the pool's dispatch_cmd template
   * contains `{safety_flags}`, that placeholder is replaced with this string.
   * When the template omits the placeholder, the value is ignored — legacy
   * templates with hardcoded flags keep working unchanged.
   */
  safetyFlags?: string;
}

function resolveRunnerPath(slotVars: SlotVars, runner?: string): string {
  const normalized = normalizeRunner(runner);
  switch (normalized) {
    case 'codex':
      return slotVars.codexPath || '';
    case 'opencode':
      return slotVars.opencodePath || slotVars.codexPath || '';
    case 'cursor':
      return slotVars.cursorPath || '';
    case 'grok':
      return slotVars.grokPath || '';
    case 'claude':
      return slotVars.claudePath;
    default:
      return '';
  }
}

// ─── expandDispatchCmd ───
// Expands runner-aware placeholders in dispatch_cmd.

/**
 * Tracks dispatch_cmd templates that carry a hardcoded --dangerously-* flag
 * but no `{safety_flags}` placeholder, so the operator-migration warning is
 * emitted exactly once per template per gateway process.
 */
const warnedLegacyDispatchTemplates = new Set<string>();
const HARDCODED_DANGEROUS_FLAG = /--dangerously-[a-z-]+/;

export function expandDispatchCmd(
  slotVars: SlotVars,
  context: DispatchCommandContext = {},
): string {
  const template = slotVars.dispatchCmd;
  if (!template) return '';
  let cmd = template;
  const runner = normalizeRunner(context.runner);
  const runnerPath = resolveRunnerPath(slotVars, runner);
  cmd = cmd.replaceAll('{repo}', slotVars.remoteRepo);
  cmd = cmd.replaceAll('{runner}', runner);
  cmd = cmd.replaceAll('{runner_path}', runnerPath);
  cmd = cmd.replaceAll('{model}', context.model ?? '');
  cmd = cmd.replaceAll('{task_file}', context.taskFile ?? '');
  cmd = cmd.replaceAll('{task_prompt}', context.taskPrompt ?? '');
  cmd = cmd.replaceAll('{effort}', context.effort ?? '');
  cmd = cmd.replaceAll('{safety_flags}', context.safetyFlags ?? '');
  cmd = cmd.replaceAll('{claude_path}', slotVars.claudePath);
  cmd = cmd.replaceAll('{codex_path}', slotVars.codexPath);
  cmd = cmd.replaceAll('{opencode_path}', slotVars.opencodePath);
  cmd = cmd.replaceAll('{cursor_path}', slotVars.cursorPath);
  cmd = cmd.replaceAll('{grok_path}', slotVars.grokPath);
  cmd = cmd.replaceAll('{adb_serial}', slotVars.resourceVars.adb_serial ?? '');

  // Empty placeholders (e.g. `{safety_flags}` for runners with no extra flags)
  // leave behind double spaces. Collapse runs of spaces and tabs so the final
  // command stays readable in logs and tmux. Newlines are preserved.
  cmd = cmd.replace(/[ \t]{2,}/g, ' ').replace(/[ \t]+$/gm, '');

  // Operator-migration nudge: hardcoded --dangerously-* flags in a template
  // without {safety_flags} means runtime tier overrides can't remove the flag.
  // Warn once per template so migrations happen, but don't break the dispatch.
  if (
    HARDCODED_DANGEROUS_FLAG.test(template) &&
    !template.includes('{safety_flags}') &&
    !warnedLegacyDispatchTemplates.has(template)
  ) {
    warnedLegacyDispatchTemplates.add(template);
    console.warn(
      `[dispatch] pool template for ${slotVars.machine} hardcodes a --dangerously-* flag ` +
        `but omits the {safety_flags} placeholder; runtime safety-tier overrides will not apply. ` +
        `Replace the hardcoded flag with {safety_flags} to opt in.`,
    );
  }

  return cmd;
}

// ─── expandRecycleCmd ───

export function expandRecycleCmd(slotVars: SlotVars): string {
  let cmd = slotVars.recycleCmd;
  if (!cmd) return '';
  cmd = cmd.replaceAll('{repo}', slotVars.remoteRepo);
  cmd = cmd.replaceAll('{adb_serial}', slotVars.resourceVars.adb_serial ?? '');
  return cmd;
}

// ─── renderFixtureTemplate ───
// Reads a fixture template file, substitutes all slot variables, returns rendered content.

export async function renderFixtureTemplate(
  srcPath: string,
  slotVars: SlotVars,
  projectVars?: ProjectVars,
): Promise<string> {
  const content = await readFile(srcPath, 'utf-8');
  return expandTemplate(content, slotVars, projectVars);
}
