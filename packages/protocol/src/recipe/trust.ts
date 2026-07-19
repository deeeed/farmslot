import type { OfficialActionName, RecipeActionName } from './common.js';

export const RECIPE_EXECUTION_CAPABILITIES = [
  'host-exec',
  'host-read-export',
  'app-mutation',
  'external-mutation',
  'arbitrary-code',
] as const;

export type RecipeExecutionCapability = (typeof RECIPE_EXECUTION_CAPABILITIES)[number];
export type RecipeSourceTrust = 'trusted' | 'untrusted' | 'unknown';
export type RecipeSourceKind =
  | 'bundled'
  | 'operator'
  | 'task'
  | 'recipe-file'
  | 'uses-catalog'
  | 'library'
  | 'custom-adapter';

export interface RecipeSourceProvenance {
  kind: RecipeSourceKind;
  trust: RecipeSourceTrust;
  name?: string;
  path?: string;
  digest?: string;
}

export interface RecipePlanNode {
  nodeId: string;
  action: RecipeActionName;
  capabilities: RecipeExecutionCapability[];
  /** Where the node definition came from. */
  origin: RecipeSourceProvenance;
  /** Trust carried by the recipe/flow call chain that reached this node. */
  invocationOrigin?: RecipeSourceProvenance;
  adapterOrigin?: RecipeSourceProvenance;
}

export interface RecipeExecutionPlan {
  schemaVersion: 1;
  digest: string;
  /** Binds approval to the project, artifact destination, and effective run environment without exposing their values. */
  executionContextDigest: string;
  source: RecipeSourceProvenance;
  nodes: RecipePlanNode[];
}

export interface RecipeExecutionApproval {
  planDigest: string;
}

export interface RecipeTrustFailure {
  code: 'RECIPE_TRUST_REQUIRED' | 'RECIPE_APPROVAL_MISMATCH' | 'RECIPE_SOURCE_INVALID';
  message: string;
  userAction: string;
  reason: 'blocked-capability' | 'approval-mismatch' | 'invalid-source';
  recipeDigest?: string;
  trust?: RecipeSourceTrust;
  blocked?: RecipePlanNode[];
}

export const DEFAULT_UNTRUSTED_RECIPE_BLOCKED_CAPABILITIES = [
  'host-exec',
  'host-read-export',
  'app-mutation',
  'external-mutation',
  'arbitrary-code',
] as const satisfies readonly RecipeExecutionCapability[];

const HOST_READ_EXPORT_ACTIONS = new Set<OfficialActionName>([
  'assert_file',
  'assert_json',
  'state_read',
  'watch_logs',
  'ui.screenshot',
  'ui.wait_for',
  'app.status',
  'app.trace',
  'cdp.target',
  'cdp.storage',
  'cdp.network',
  'cdp.metrics',
  'cdp.trace',
]);

const APP_MUTATION_ACTIONS = new Set<OfficialActionName>([
  'ui.navigate',
  'ui.press',
  'ui.key_press',
  'ui.set_input',
  'ui.scroll',
  'ui.gesture',
  'app.lifecycle',
  'app.hud',
  'cdp.storage',
  'cdp.network',
  'cdp.emulation',
]);

const EXTERNAL_MUTATION_ACTIONS = new Set<OfficialActionName>([
  'ui.press',
  'ui.key_press',
  'ui.gesture',
  'cdp.network',
]);

export function officialRecipeActionCapabilities(
  action: OfficialActionName,
): RecipeExecutionCapability[] {
  if (action === 'command') return ['host-exec'];
  if (action === 'index_artifacts') return ['host-read-export'];
  const capabilities: RecipeExecutionCapability[] = [];
  if (HOST_READ_EXPORT_ACTIONS.has(action)) capabilities.push('host-read-export');
  if (APP_MUTATION_ACTIONS.has(action)) capabilities.push('app-mutation');
  if (EXTERNAL_MUTATION_ACTIONS.has(action)) capabilities.push('external-mutation');
  return capabilities;
}
