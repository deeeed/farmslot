import { RECIPE_ARTIFACT_TYPES } from '../recipes/step-io.js';

export const RECIPE_PROTOCOL_SCHEMA_VERSION = 1;
export const RECIPE_PLAYBACK_SLOW_MS_MIN = 100;
export const RECIPE_PLAYBACK_SLOW_MS_MAX = 60_000;

export const OFFICIAL_RECIPE_ACTIONS = [
  'command',
  'wait',
  'assert_file',
  'assert_json',
  'assert_exit_code',
  'assert_output',
  'state_read',
  'watch_logs',
  'index_artifacts',
  'call',
  'switch',
  'manual',
  'end',
  'ui.navigate',
  'ui.press',
  'ui.key_press',
  'ui.set_input',
  'ui.scroll',
  'ui.gesture',
  'ui.wait_for',
  'ui.screenshot',
  'app.status',
  'app.lifecycle',
  'app.hud',
  'app.trace',
  'cdp.target',
  'cdp.storage',
  'cdp.network',
  'cdp.emulation',
  'cdp.metrics',
  'cdp.trace',
] as const;

export type OfficialActionName = (typeof OFFICIAL_RECIPE_ACTIONS)[number];
export type RecipeActionName = OfficialActionName | (string & {});

export interface RecipeActionCatalogExample {
  description?: string;
  node: Record<string, unknown>;
}

export interface RecipeActionCatalogEntry {
  description?: string;
  schema?: Record<string, unknown>;
  examples?: RecipeActionCatalogExample[];
  when_to_use?: string;
  avoid_when?: string;
  proof_effect?: string;
  safety_notes?: string;
}

export interface RecipeCustomActionDeclaration extends RecipeActionCatalogEntry {
  name: string;
  owner?: string;
}

export interface RecipeNamedDeclaration {
  name: string;
  description?: string;
  schema?: Record<string, unknown>;
}

export interface RecipeStateRefDeclaration {
  name: string;
  description?: string;
  schema?: Record<string, unknown>;
}

export interface RecipePreconditionDeclaration {
  id: string;
  description: string;
  failure_kind?: string;
}

export interface RecipeNativeBindingDeclaration {
  action: RecipeActionName;
  implementation: string;
}

export interface RecipeRuntimeCapabilityDeclaration {
  capability: string;
  status: 'supported' | 'unsupported' | 'partial' | 'planned';
  provider?: string;
  reason?: string;
  platforms?: string[];
  modes?: string[];
  artifactTypes?: string[];
}

export interface RecipeActionManifestDocument {
  runner_protocol_version: 1;
  action_registry_version: 1;
  supported_official_actions: OfficialActionName[];
  action_metadata?: Partial<Record<OfficialActionName, RecipeActionCatalogEntry>>;
  custom_actions?: RecipeCustomActionDeclaration[];
  custom_assertion_operators?: RecipeNamedDeclaration[];
  state_refs?: RecipeStateRefDeclaration[];
  pre_conditions?: RecipePreconditionDeclaration[];
  native_bindings?: RecipeNativeBindingDeclaration[];
  capabilities?: RecipeRuntimeCapabilityDeclaration[];
}

export const PLAYBACK_MODES = new Set(['off', 'auto', 'step']);
export const TERMINAL_STATUSES = new Set(['pass', 'fail', 'unknown']);
export const ARTIFACT_TYPES = new Set<string>(RECIPE_ARTIFACT_TYPES);
export const OFFICIAL_ACTION_SET = new Set<string>(OFFICIAL_RECIPE_ACTIONS);

export type RecipeValidationSeverity = 'error' | 'warning';
export type RecipeValidationStatus = 'valid' | 'invalid';

export interface RecipeValidationFinding {
  severity: RecipeValidationSeverity;
  code: string;
  path: string;
  message: string;
}

export interface RecipeValidationResult {
  status: RecipeValidationStatus;
  findings: RecipeValidationFinding[];
  summary: {
    errors: number;
    warnings: number;
  };
}

export interface RecipeArtifactPackageInput {
  manifest?: unknown;
  artifactPaths?: readonly string[];
  recipe?: unknown;
}

export interface MutableValidationContext {
  findings: RecipeValidationFinding[];
}

export function createContext(): MutableValidationContext {
  return { findings: [] };
}

export function addFinding(
  ctx: MutableValidationContext,
  severity: RecipeValidationSeverity,
  code: string,
  path: string,
  message: string,
): void {
  ctx.findings.push({ severity, code, path, message });
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

export function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

export function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export function isRelativeArtifactPath(value: string): boolean {
  if (value.startsWith('/') || value.startsWith('\\')) return false;
  if (/^[A-Za-z]:/.test(value)) return false;
  return !value.split(/[\\/]+/).some((segment) => segment === '..');
}

export function finishResult(ctx: MutableValidationContext): RecipeValidationResult {
  const errors = ctx.findings.filter((finding) => finding.severity === 'error').length;
  const warnings = ctx.findings.length - errors;
  const status: RecipeValidationStatus = errors ? 'invalid' : 'valid';
  return { status, findings: ctx.findings, summary: { errors, warnings } };
}

export function requireStringField(
  ctx: MutableValidationContext,
  document: Record<string, unknown>,
  field: string,
  path: string,
): void {
  if (isNonEmptyString(document[field])) return;
  if (!hasOwn(document, field)) {
    addFinding(ctx, 'error', `recipe.missing_${field}`, path, `Recipe requires ${path}.`);
    return;
  }
  addFinding(ctx, 'error', `recipe.invalid_${field}`, path, `${path} must be a non-empty string.`);
}

export function validateOptionalStringField(
  ctx: MutableValidationContext,
  document: Record<string, unknown>,
  field: string,
  path: string,
): void {
  if (!hasOwn(document, field) || document[field] == null) return;
  if (isNonEmptyString(document[field])) return;
  addFinding(ctx, 'error', `recipe.invalid_${field}`, path, `${path} must be a non-empty string.`);
}
