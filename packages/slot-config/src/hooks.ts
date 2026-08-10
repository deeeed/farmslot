// core/hooks.ts — Hook and template expansion
// TypeScript port of lib/slot-common.sh: expand_hook, expand_template, expand_platform_field, render_fixture_template

import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { normalizeRunner } from '@farmslot/protocol';

import { farmslotRoot, type ProjectVars, type RawProjectJson, type SlotVars } from './config.js';

const localHostname = os.hostname().replace(/\.local$/, '');

// ─── expandTemplate ───
// Substitutes all {{VAR}} placeholders in a string using resourceVars dynamically.

// Node deployment dir on remote machines (scripts + tools synced by deploy-node.sh)
const REMOTE_AGENT_DIR = '~/farmslot-node';

/** Explicit run/prepare domain overrides the slot's already-resolved slot/pool default. */
export function resolveEffectiveDomain(
  explicitDomain?: string | null,
  slotOrPoolDomain?: string | null,
): string | undefined {
  const explicit = explicitDomain?.trim();
  if (explicit) return explicit;
  const configured = slotOrPoolDomain?.trim();
  return configured || undefined;
}

export function expandTemplate(
  template: string,
  slotVars: SlotVars,
  projectVars?: ProjectVars,
  extraVars?: Record<string, string>,
): string {
  return expandTemplateInternal(template, slotVars, projectVars, true, extraVars);
}

/**
 * Fixture-path variant of expandTemplate: an unresolved `{{domain}}` is left
 * literal instead of collapsing to empty. Overlay fixture paths like
 * `domains/{{domain}}/domain.md` must skip quietly (with the original path in
 * the log) when no domain is selected, rather than resolving to a bogus
 * `domains//domain.md` that silently misses. Used only for fixture src/dst/
 * include path resolution; fixture *content* still renders via expandTemplate.
 */
export function expandFixturePath(
  template: string,
  slotVars: SlotVars,
  projectVars?: ProjectVars,
  extraVars?: Record<string, string>,
): string {
  return expandTemplateInternal(template, slotVars, projectVars, true, extraVars, true);
}

function expandTemplateInternal(
  template: string,
  slotVars: SlotVars,
  projectVars: ProjectVars | undefined,
  includeProjectTemplateVars: boolean,
  extraVars?: Record<string, string>,
  leaveUnresolvedDomain = false,
): string {
  if (
    /\{\{(?:metro_port|METRO_PORT)\}\}/u.test(template) &&
    !slotVars.resourceVars.metro_port?.trim()
  ) {
    throw new Error(missingMetroPortMessage(slotVars));
  }
  let result = template;
  // Runtime extras (e.g. --domain overlays) take precedence over project vars
  // and resource fields — apply them first so later passes see no placeholder.
  if (extraVars) {
    for (const [key, value] of Object.entries(extraVars)) {
      result = result.replaceAll(`{{${key}}}`, value);
      result = result.replaceAll(`{{${key.toUpperCase()}}}`, value);
    }
  }
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
    'vite_port',
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
  // REPO = slot checkout path as a shell-usable path: the bash implementation
  // substituted REMOTE_REPO (tilde-expanded for the slot's machine) because a
  // quoted '~/...' never expands in hooks. primary_repo = canonical project
  // tree (worktree sandboxes).
  const repoForShell = slotVars.remoteRepo || slotVars.repo;
  result = result.replaceAll('{{REPO}}', repoForShell);
  result = result.replaceAll('{{repo}}', repoForShell);
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
  // Per-call variables supplied by the caller (e.g. the prepare-requirement
  // check threading the run's target ref). Applied last so callers can inject
  // runtime values that are neither slot resources nor static project vars.
  // {{domain}} normally renders: extras (applied first, above) win, then the
  // project-vars pass may have consumed it, then the pool-level default, then
  // empty — matching the bash sed's unconditional ${DOMAIN:-} substitution.
  // Fixture-path expansion opts out of the empty fallback (leaveUnresolvedDomain)
  // so an unselected overlay path stays literal and skips quietly.
  if (!leaveUnresolvedDomain || slotVars.domain) {
    const domainValue = slotVars.domain ?? '';
    result = result.replaceAll('{{domain}}', domainValue);
    result = result.replaceAll('{{DOMAIN}}', domainValue);
  }

  return result;
}

export function missingMetroPortMessage(slotVars: SlotVars): string {
  if (!slotVars.resourceVars.port?.trim()) {
    return `Slot ${slotVars.slotId} is missing resources.dev-server required by Metro configuration; add the resource manually to the pool with distinct port and metro_port values.`;
  }
  return `Slot ${slotVars.slotId} is missing resources.dev-server.metro_port required by Metro configuration; run farmslot update to migrate the pool.`;
}

// ─── Template placeholder guard ───
// Sinks that render worker-facing text (task files, dispatch prompts) assert
// the raw template's placeholders against the known expansion set and fail
// hard at dispatch, instead of shipping literal {{...}} to an agent.
//
// Deliberately exempt: fixture rendering (renderFixtureTemplate /
// expandFixturePath — overlay paths legitimately keep an unresolved
// {{domain}} so unselected overlays skip quietly) and hook/recycle/dispatch
// command expansion (missing optional resources render empty by design).
// Free-text content values (ticket descriptions, review issue text, CI
// comments) may legitimately contain {{...}} and are inserted, never
// expanded; config-derived values (project vars, slot resources) are
// verified below because they ARE expanded or substituted verbatim.

const PLACEHOLDER_RE = /\{\{([A-Za-z_][A-Za-z0-9_]*)\}\}/g;
// Any double-brace token, valid identifier or not — a malformed name like
// {{foo-bar}} can never be substituted, so it must fail the guard rather
// than slip through an identifier-only scan.
const PLACEHOLDER_TOKEN_RE = /\{\{[^{}\n]+\}\}/g;

export function collectTemplatePlaceholders(text: string): Set<string> {
  const names = new Set<string>();
  for (const match of text.matchAll(PLACEHOLDER_RE)) {
    if (match[1]) names.add(match[1]);
  }
  return names;
}

/** Full {{...}} tokens present in the text, including malformed names. */
export function collectPlaceholderTokens(text: string): Set<string> {
  return new Set(Array.from(text.matchAll(PLACEHOLDER_TOKEN_RE), (match) => match[0]));
}

// Every placeholder name expandTemplate() can substitute for this slot/project.
// Keep in sync with expandTemplateInternal — hooks.test.ts locks the two
// together by expanding a template built from this set.
export function knownTemplatePlaceholders(
  slotVars: SlotVars,
  projectVars?: ProjectVars,
  extraVars?: Record<string, string>,
): Set<string> {
  const addTo = (set: Set<string>, name: string) => {
    set.add(name);
    set.add(name.toUpperCase());
  };
  // A resource value is substituted verbatim, never expanded — one that
  // itself contains {{...}} would smuggle raw tokens to a worker, so its
  // key must not count as known (neither directly nor via the optional-
  // empty pass, which skips keys the resource pass already consumed).
  const dirtyResourceKeys = new Set(
    Object.entries(slotVars.resourceVars)
      .filter(([, value]) => collectPlaceholderTokens(value).size > 0)
      .map(([key]) => key),
  );
  // Names the nested project-var value pass can resolve (it runs without
  // extras and without other project vars — see expandTemplateInternal).
  const nested = new Set<string>();
  for (const key of Object.keys(slotVars.resourceVars)) {
    if (!dirtyResourceKeys.has(key)) addTo(nested, key);
  }
  for (const key of [
    'port',
    'cdp_port',
    'vite_port',
    'simulator',
    'avd',
    'adb_serial',
    'headless',
    'snapshot',
  ]) {
    if (!dirtyResourceKeys.has(key)) addTo(nested, key);
  }
  for (const key of [
    'runtime_dir',
    'artifact_dir',
    'recipe_dir',
    'farmslot_dir',
    'watcher_port',
    'slot_id',
    'session',
    'repo',
    'primary_repo',
    'domain',
  ])
    addTo(nested, key);
  for (const key of Object.keys(projectVars?.projectJson.reference_repos ?? {}))
    addTo(nested, `${key}_repo`);

  const known = new Set(nested);
  // Extras are substituted verbatim — same smuggling rule as resources.
  for (const [key, value] of Object.entries(extraVars ?? {})) {
    if (collectPlaceholderTokens(value).size === 0) addTo(known, key);
  }
  // A project var only counts as known when its value fully resolves — run
  // the real nested pass rather than predicting it, so this cannot drift.
  // Otherwise expanding the var would smuggle raw {{...}} past the guard
  // through the value itself.
  for (const [key, rawValue] of Object.entries(projectVars?.projectJson.vars ?? {})) {
    const rendered = expandTemplateInternal(String(rawValue), slotVars, projectVars, false);
    if (collectPlaceholderTokens(rendered).size === 0) addTo(known, key);
  }
  return known;
}

/**
 * Render a template where `reserved` placeholders receive their values only
 * after the hooks pass: their content (reviewer/CI comment text) must never
 * be re-expanded, and a colliding project or resource var must not consume
 * the placeholder first. NUL sentinels are safe — templates are NUL-free text.
 */
export function expandTemplateWithReservedLast(
  template: string,
  slotVars: SlotVars,
  projectVars: ProjectVars | undefined,
  reserved: Record<string, string>,
): string {
  let masked = template;
  for (const key of Object.keys(reserved)) {
    masked = masked.replaceAll(`{{${key}}}`, `\u0000${key}\u0000`);
  }
  let expanded = expandTemplate(masked, slotVars, projectVars);
  for (const [key, value] of Object.entries(reserved)) {
    expanded = expanded.replaceAll(`\u0000${key}\u0000`, value);
  }
  return expanded;
}

export function assertNoUnknownPlaceholders(
  template: string,
  known: Iterable<string>,
  source: string,
): void {
  const knownSet = known instanceof Set ? known : new Set(known);
  const unknown = [...collectPlaceholderTokens(template)].filter((token) => {
    const name = token.slice(2, -2);
    return !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || !knownSet.has(name);
  });
  if (unknown.length > 0) {
    throw new Error(
      `${source} references placeholder(s) with no expansion value: ${unknown.join(', ')} — ` +
        `supply the variable or remove the placeholder from the template`,
    );
  }
}

// ─── expandHook ───
// Reads hooks.<hookName> from project.json, substitutes slot variables.
// Returns empty string if hook not defined.

export function expandHook(
  hookName: string,
  projectJson: RawProjectJson,
  slotVars: SlotVars,
  projectVars?: ProjectVars,
  extraVars?: Record<string, string>,
): string {
  const cmd = projectJson.hooks?.[hookName];
  if (!cmd || typeof cmd !== 'string') return '';
  return expandTemplate(cmd, slotVars, projectVars, extraVars);
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
  /**
   * Runtime-owned arguments that must follow the selected runner executable.
   * These are attached while expanding `{runner_path}` or the selected
   * runner-specific path placeholder, so trailing shell commands cannot
   * accidentally consume them.
   */
  runnerArgs?: string;
}

function resolveRunnerPath(slotVars: SlotVars, runner?: string, runnerArgs?: string): string {
  const normalized = normalizeRunner(runner);
  let runnerPath = '';
  switch (normalized) {
    case 'codex':
      runnerPath = slotVars.codexPath || '';
      break;
    case 'opencode':
      runnerPath = slotVars.opencodePath || slotVars.codexPath || '';
      break;
    case 'cursor':
      runnerPath = slotVars.cursorPath || '';
      break;
    case 'grok':
      runnerPath = slotVars.grokPath || '';
      break;
    case 'claude':
      runnerPath = slotVars.claudePath;
      break;
    default:
      return '';
  }
  return runnerPath && runnerArgs?.trim() ? `${runnerPath} ${runnerArgs.trim()}` : runnerPath;
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
  const runnerPath = resolveRunnerPath(slotVars, runner, context.runnerArgs);
  cmd = cmd.replaceAll('{repo}', slotVars.remoteRepo);
  cmd = cmd.replaceAll('{runner}', runner);
  cmd = cmd.replaceAll('{runner_path}', runnerPath);
  cmd = cmd.replaceAll('{model}', context.model ?? '');
  cmd = cmd.replaceAll('{task_file}', context.taskFile ?? '');
  cmd = cmd.replaceAll('{task_prompt}', context.taskPrompt ?? '');
  // An unset effort (operator `auto`, or a runner without a default) must drop
  // the whole flag, not leave a bare `--effort` pointing at the next argument.
  if (!context.effort) {
    cmd = cmd.replace(/ ?--effort +\{effort\}/g, '');
  }
  cmd = cmd.replaceAll('{effort}', context.effort ?? '');
  cmd = cmd.replaceAll('{safety_flags}', context.safetyFlags ?? '');
  cmd = cmd.replaceAll('{claude_path}', runner === 'claude' ? runnerPath : slotVars.claudePath);
  cmd = cmd.replaceAll('{codex_path}', runner === 'codex' ? runnerPath : slotVars.codexPath);
  cmd = cmd.replaceAll(
    '{opencode_path}',
    runner === 'opencode' ? runnerPath : slotVars.opencodePath,
  );
  cmd = cmd.replaceAll('{cursor_path}', runner === 'cursor' ? runnerPath : slotVars.cursorPath);
  cmd = cmd.replaceAll('{grok_path}', runner === 'grok' ? runnerPath : slotVars.grokPath);
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
  extraVars?: Record<string, string>,
): Promise<string> {
  const content = await readFile(srcPath, 'utf-8');
  return expandTemplate(content, slotVars, projectVars, extraVars);
}
