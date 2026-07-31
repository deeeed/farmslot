import { RECIPE_ARTIFACT_TYPES } from '../recipes/step-io.js';

import type { RecipeExecutionCapability } from './trust.js';

export const RECIPE_PROTOCOL_SCHEMA_VERSION = 1;
export const RECIPE_PROTOCOL_SCHEMA_URL = 'https://farmslot.io/schemas/recipe-v1.schema.json';
export const RECIPE_PROTOCOL_SCHEMA_URLS = {
  [RECIPE_PROTOCOL_SCHEMA_VERSION]: RECIPE_PROTOCOL_SCHEMA_URL,
} as const;
export const RECIPE_ACTION_MANIFEST_SCHEMA_URL =
  'https://farmslot.io/schemas/action-manifest-v1.schema.json';

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
export const BUILT_IN_UI_OBSERVERS = ['ui.screen', 'ui.visible'] as const;
export type BuiltInUiObserverRef = (typeof BUILT_IN_UI_OBSERVERS)[number];
export type UiObserverRef = BuiltInUiObserverRef | (string & {});
export const RECIPE_FAILURE_CAUSES = ['subject', 'harness', 'environment', 'unknown'] as const;
export type RecipeFailureCause = (typeof RECIPE_FAILURE_CAUSES)[number];

export interface RecipeActionCatalogEntry {
  description: string;
  schema?: Record<string, unknown>;
  /** Finite control cases this action may return. The recipe owns their destinations. */
  result_cases?: string[];
  examples: Record<string, unknown>[];
  /** Security-relevant effects. Discovery metadata only; runtime adapters may add but never remove capabilities. */
  execution_capabilities?: RecipeExecutionCapability[];
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

export interface RecipeObserverDeclaration {
  ref: UiObserverRef;
  default_for: RecipeActionName[];
}

export interface RecipeActionManifestDocument {
  $schema: typeof RECIPE_ACTION_MANIFEST_SCHEMA_URL;
  actions: Record<string, RecipeActionCatalogEntry>;
  observers?: RecipeObserverDeclaration[];
}

export const TERMINAL_STATUSES = new Set(['pass', 'fail', 'unknown']);
export const ARTIFACT_TYPES = new Set<string>(RECIPE_ARTIFACT_TYPES);
export const OFFICIAL_ACTION_SET = new Set<string>(OFFICIAL_RECIPE_ACTIONS);
export const BUILT_IN_UI_OBSERVER_SET = new Set<string>(BUILT_IN_UI_OBSERVERS);

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
  trace?: unknown;
  summary: unknown;
  artifactPaths?: readonly string[];
  recipe?: unknown;
  /** Exact reachable dependency documents keyed by their sha256 digest. */
  resolvedRecipes?: Record<string, unknown>;
  /** Static dependency graph and provenance emitted as recipe-resolution.json. */
  recipeResolution?: unknown;
}

export interface RecipeResolutionDependency {
  ref: string;
  source: string;
  file: string;
  digest: string;
  artifact: string;
  adapter?: string;
}

export interface RecipeResolutionEdge {
  from: string;
  to: string;
}

export interface RecipeResolutionDocument {
  schema_version: 1;
  root: { ref: string; digest: string };
  dependencies: RecipeResolutionDependency[];
  edges: RecipeResolutionEdge[];
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

export function recipeProtocolSchemaUrlForVersion(version: unknown): string | undefined {
  if (typeof version !== 'number') return undefined;
  return RECIPE_PROTOCOL_SCHEMA_URLS[version as keyof typeof RECIPE_PROTOCOL_SCHEMA_URLS];
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
  if (!hasOwn(document, field)) return;
  if (isNonEmptyString(document[field])) return;
  addFinding(ctx, 'error', `recipe.invalid_${field}`, path, `${path} must be a non-empty string.`);
}
