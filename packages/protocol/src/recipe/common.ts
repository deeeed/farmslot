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
  'ui.scroll_to',
  'ui.swipe',
  'ui.pan',
  'ui.drag',
  'ui.long_press',
  'ui.wait_for',
  'ui.screenshot',
  'ui.capture_surface',
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

/**
 * Canonical parameters for `ui.scroll_to`. Runner action manifests declare this schema so every
 * provider receives the same request: which surface moves, which semantic element must end up
 * reviewable, and which measurable element proves it when the target has no box of its own.
 */
export const UI_SCROLL_TO_PARAMS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['surface_test_id', 'target_test_id'],
  properties: {
    surface_test_id: {
      type: 'string',
      description: 'Test id of the scroll container whose offset moves.',
    },
    target_test_id: {
      type: 'string',
      description: 'Semantic proof target. It must be present when the node ends.',
    },
    visibility_anchor_test_id: {
      type: 'string',
      description:
        'Measurable element used for positioning and the visibility verdict when the target has no measurable box, such as a flattened Text node.',
    },
    align: {
      type: 'string',
      enum: ['start', 'center', 'end', 'nearest'],
      default: 'nearest',
      description:
        'Where the measured element rests inside the safe viewport after a move. An element already inside it is left where it is.',
    },
    viewport_policy: {
      type: 'string',
      enum: ['hud_safe', 'full'],
      default: 'hud_safe',
      description:
        'hud_safe removes HUD and overlay occlusion from the viewport before positioning and verifying; full uses the raw surface viewport.',
    },
    verify_visible: {
      type: 'boolean',
      default: true,
      description:
        'Fail with SCROLL_TARGET_NOT_VISIBLE when the settled element is outside the safe viewport.',
    },
    settle: {
      type: 'object',
      additionalProperties: false,
      description:
        'Geometry settlement after movement: consecutive identical measurements within a budget.',
      properties: {
        timeout_ms: {
          type: 'number',
          minimum: 0,
          description: 'Settlement budget in milliseconds.',
        },
        interval_ms: { type: 'number', minimum: 1, description: 'Delay between measurements.' },
        stable_samples: {
          type: 'integer',
          minimum: 1,
          description: 'Consecutive unchanged measurements required to call the layout settled.',
        },
      },
    },
  },
} as const;
export type RecipeActionName = OfficialActionName | (string & {});
export const BUILT_IN_UI_OBSERVERS = ['ui.screen', 'ui.visible'] as const;
export type BuiltInUiObserverRef = (typeof BUILT_IN_UI_OBSERVERS)[number];
export type UiObserverRef = BuiltInUiObserverRef | (string & {});
export const RECIPE_FAILURE_CAUSES = ['subject', 'harness', 'environment', 'unknown'] as const;
export type RecipeFailureCause = (typeof RECIPE_FAILURE_CAUSES)[number];

export interface RecipeActionCatalogEntry {
  description: string;
  schema?: Record<string, unknown>;
  /** Adapter names that implement this action. Omit when the action is adapter-independent. */
  adapters?: string[];
  /** Adapter-specific parameter refinements applied in addition to schema. */
  adapter_schemas?: Record<string, Record<string, unknown>>;
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
