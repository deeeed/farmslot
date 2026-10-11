import path from 'node:path';

import {
  DEFAULT_UNTRUSTED_RECIPE_BLOCKED_CAPABILITIES,
  digestRecipeDocument,
  normalizeRecipeRef,
  OFFICIAL_RECIPE_ACTIONS,
  officialRecipeActionCapabilities,
  type RecipeActionManifestDocument,
  type RecipeExecutionCapability,
  type RecipeExecutionPlan,
  type RecipePlanNode,
  type RecipeSourceProvenance,
} from '@farmslot/protocol';

import { extractWorkflowGraph } from './graph.js';
import { isRecord } from './json.js';
import type { ResolvedLibraryRecipe } from './library.js';
import { resolveRecipeParams, resolveRecipeValue } from './parameters.js';
import type { DefaultObserverRefs } from './passive-observations.js';
import { RecipeResolutionError } from './resolution-error.js';
import { invalidRecipeSource, RecipeTrustError } from './trust-error.js';
import type { ActionAdapter, RecipeHudOptions, RecipeRunRequest } from './types.js';

const officialActions = new Set<string>(OFFICIAL_RECIPE_ACTIONS);
const bundledSource: RecipeSourceProvenance = {
  kind: 'bundled',
  trust: 'trusted',
  name: '@farmslot/recipe-runner',
};

export function recipeSourceForRequest(
  request: RecipeRunRequest,
  recipe: unknown,
  sourceRecipePath?: string,
  defaultSource?: RecipeSourceProvenance,
): RecipeSourceProvenance {
  const digest = digestValue(recipe);
  const claimedDigest = request.source?.digest ?? defaultSource?.digest;
  if (claimedDigest && claimedDigest !== digest) {
    throw invalidRecipeSource(
      `Recipe source digest ${claimedDigest} does not match the loaded document.`,
      `use the loaded recipe digest ${digest} or omit the caller digest`,
    );
  }
  const fallback: RecipeSourceProvenance = {
    kind: request.recipeDocument == null ? 'recipe-file' : 'operator',
    trust: 'unknown',
  };
  return {
    ...fallback,
    ...defaultSource,
    ...request.source,
    ...(sourceRecipePath ? { path: sourceRecipePath } : {}),
    digest,
  };
}

export function buildRecipeExecutionPlan({
  recipe,
  params,
  source,
  recipes,
  adapters,
  actionManifest,
  defaultObserverRefs,
  projectRoot,
  artifactsDir,
  env,
  hud,
  recordVideo,
}: {
  recipe: Record<string, unknown>;
  params: Record<string, unknown>;
  source: RecipeSourceProvenance;
  recipes: ReadonlyMap<string, ResolvedLibraryRecipe>;
  adapters: ReadonlyMap<string, ActionAdapter>;
  actionManifest: RecipeActionManifestDocument;
  defaultObserverRefs: DefaultObserverRefs;
  projectRoot: string;
  artifactsDir: string;
  env: Record<string, string | undefined>;
  hud?: RecipeHudOptions | false;
  recordVideo?: RecipeRunRequest['recordVideo'];
}): RecipeExecutionPlan {
  const nodes: RecipePlanNode[] = [];
  const digestNodes: Array<{ plan: RecipePlanNode; node: Record<string, unknown> }> = [];

  const addNode = (
    nodeId: string,
    node: Record<string, unknown>,
    origin: RecipeSourceProvenance,
    invocationOrigin?: RecipeSourceProvenance,
  ): void => {
    if (typeof node.action !== 'string' || !node.action.trim()) return;
    const adapter = adapters.get(node.action);
    const adapterOrigin = adapterSource(node.action, adapter);
    const observerRefs = [...(defaultObserverRefs.get(node.action) ?? [])];
    const capabilities = actionCapabilities(
      node.action,
      adapter,
      adapterOrigin,
      declaredActionCapabilities(actionManifest, node.action),
      observerRefs.length > 0,
    );
    const planNode: RecipePlanNode = {
      nodeId,
      action: node.action,
      capabilities,
      origin,
      ...(observerRefs.length > 0 ? { observerRefs } : {}),
      ...(containsRecipeOutputTemplate(node) ? { runtimeOutputDependent: true } : {}),
      ...(invocationOrigin ? { invocationOrigin } : {}),
      ...(adapterOrigin ? { adapterOrigin } : {}),
    };
    nodes.push(planNode);
    digestNodes.push({ plan: planNode, node });
  };

  const visitRecipe = (
    activeRecipe: Record<string, unknown>,
    activeParams: Record<string, unknown>,
    origin: RecipeSourceProvenance,
    invocationOrigin: RecipeSourceProvenance | undefined,
    prefix: string,
  ): void => {
    const activeGraph = extractWorkflowGraph(activeRecipe);
    for (const [nodeId, rawNode] of Object.entries(activeGraph.nodes)) {
      const resolvedNode = resolveRecipeValue(rawNode, activeParams, undefined, {
        nodeId: `${prefix}${nodeId}`,
      });
      if (!isRecord(resolvedNode)) {
        throw new RecipeResolutionError(
          'RECIPE_PARAMS_INVALID',
          `Recipe node ${prefix}${nodeId} did not resolve to an object.`,
          `inspect parameter templates used by ${prefix}${nodeId}`,
        );
      }
      const planNodeId = `${prefix}${nodeId}`;
      addNode(planNodeId, resolvedNode, origin, invocationOrigin);
      if (resolvedNode.action !== 'call' || typeof resolvedNode.ref !== 'string') continue;
      const ref = normalizeRecipeRef(resolvedNode.ref);
      const dependency = recipes.get(ref);
      if (!dependency) {
        throw new RecipeResolutionError(
          'RECIPE_REFERENCE_NOT_FOUND',
          `Recipe ${ref} is not available from configured libraries.`,
          `add ${ref} to a configured recipe library or correct call.ref`,
        );
      }
      const childInput = isRecord(resolvedNode.params) ? resolvedNode.params : {};
      const childParams = resolveRecipeParams(ref, dependency.document, childInput, {
        allowTemplates: true,
      });
      visitRecipe(
        dependency.document,
        childParams,
        dependency.provenance,
        effectiveInvocationOrigin(origin, invocationOrigin),
        `${planNodeId}/`,
      );
    }
  };

  visitRecipe(recipe, params, source, undefined, '');

  // The automatic HUD is the runner's own node: its options come from the run's HUD policy and a
  // recipe cannot declare it (`run:hud` is not a valid node id), so it carries the runner's origin
  // and needs no approval of its own. It stays in the digest: an approval covers one HUD policy.
  // Its implementation's origin still applies, so an untrusted HUD adapter stays restricted.
  if (hud !== false && hud?.enabled !== false && adapters.has('app.hud')) {
    addNode('run:hud', { action: 'app.hud', automatic: true, options: hud ?? {} }, bundledSource);
  }

  if (recordVideo && recordVideo !== 'off') {
    const planNode: RecipePlanNode = {
      nodeId: 'run:recording',
      action: 'recording',
      capabilities: ['host-read-export'],
      origin: source,
      adapterOrigin: bundledSource,
    };
    nodes.push(planNode);
    digestNodes.push({ plan: planNode, node: { recordVideo } });
  }

  const executionContextDigest = digestValue({
    projectRoot,
    artifactsDir,
    env: planEnvironment(env),
    params,
  });
  const planBody = { schemaVersion: 1 as const, executionContextDigest, source, nodes };
  return {
    ...planBody,
    digest: digestValue({ recipe, source, executionContextDigest, nodes: digestNodes }),
  };
}

export function enforceRecipeExecutionPlan(
  plan: RecipeExecutionPlan,
  request: Pick<RecipeRunRequest, 'approval'>,
  blockedCapabilities: readonly RecipeExecutionCapability[] = DEFAULT_UNTRUSTED_RECIPE_BLOCKED_CAPABILITIES,
): void {
  for (const node of plan.nodes) {
    if (
      node.capabilities.includes('arbitrary-code') &&
      node.adapterOrigin?.trust !== 'trusted' &&
      !node.adapterOrigin?.digest
    ) {
      throw invalidRecipeSource(
        `Custom implementation ${node.action} has no content digest.`,
        'register a trusted adapter or supply provenance with a digest before approval',
      );
    }
  }
  const blockedSet = new Set(blockedCapabilities);
  const blocked = plan.nodes.filter((node) => {
    const untrustedRecipe = node.origin.trust !== 'trusted';
    const untrustedInvocation =
      node.invocationOrigin != null && node.invocationOrigin.trust !== 'trusted';
    const untrustedAdapter = node.adapterOrigin?.trust !== 'trusted';
    return node.capabilities.some(
      (capability) =>
        blockedSet.has(capability) && (untrustedRecipe || untrustedInvocation || untrustedAdapter),
    );
  });
  if (blocked.length === 0) return;
  const runtimeDependent = blocked.filter((node) => node.runtimeOutputDependent);
  if (runtimeDependent.length > 0) {
    throw new RecipeTrustError({
      code: 'RECIPE_TRUST_REQUIRED',
      message:
        'Untrusted restricted recipe nodes cannot derive executable values from runtime outputs.',
      userAction:
        'replace {{outputs.*}} executable values with reviewed recipe parameters, or move the behavior into a trusted recipe',
      reason: 'blocked-capability',
      recipeDigest: plan.digest,
      trust: plan.source.trust,
      blocked: runtimeDependent.map(redactPlanNodeProvenance),
    });
  }
  if (request.approval?.planDigest === plan.digest) return;
  const publicBlocked = blocked.map(redactPlanNodeProvenance);
  if (request.approval) {
    throw new RecipeTrustError({
      code: 'RECIPE_APPROVAL_MISMATCH',
      message:
        "Recipe approval does not match the resolved execution plan. The plan includes the run's HUD and video settings, so an approval made with another --hud or --record-video setting does not cover this run.",
      userAction: approvalUserAction(plan.digest),
      reason: 'approval-mismatch',
      recipeDigest: plan.digest,
      trust: plan.source.trust,
      blocked: publicBlocked,
    });
  }
  throw new RecipeTrustError({
    code: 'RECIPE_TRUST_REQUIRED',
    message: 'Untrusted recipe sources cannot execute restricted capabilities.',
    userAction: approvalUserAction(plan.digest),
    reason: 'blocked-capability',
    recipeDigest: plan.digest,
    trust: plan.source.trust,
    blocked: publicBlocked,
  });
}

export async function verifyExecutableSource(
  executable: Pick<ActionAdapter, 'source' | 'resolveSourceDigest'>,
  label: string,
): Promise<void> {
  if (!executable.resolveSourceDigest) return;
  if (!executable.source?.digest) {
    throw invalidRecipeSource(
      `${label} has an integrity verifier but no approved source digest.`,
      'resolve the implementation again and review its content digest before execution',
    );
  }
  const actualDigest = await executable.resolveSourceDigest();
  if (actualDigest !== executable.source.digest) {
    throw invalidRecipeSource(
      `${label} changed after the execution plan was resolved.`,
      'resolve and review a new execution plan for the current implementation bytes',
    );
  }
}

function approvalUserAction(planDigest: string): string {
  return (
    `review the resolved plan, then approve ${planDigest} through the trusted caller ` +
    `(direct CLI: --approve-plan ${planDigest}; managed run: ` +
    `FARMSLOT_RECIPE_APPROVE_PLAN=${planDigest})`
  );
}

function effectiveInvocationOrigin(
  definitionOrigin: RecipeSourceProvenance,
  invocationOrigin?: RecipeSourceProvenance,
): RecipeSourceProvenance {
  if (invocationOrigin && invocationOrigin.trust !== 'trusted') return invocationOrigin;
  if (definitionOrigin.trust !== 'trusted') return definitionOrigin;
  return invocationOrigin ?? definitionOrigin;
}

function redactPlanNodeProvenance(node: RecipePlanNode): RecipePlanNode {
  return {
    ...node,
    origin: redactSourceDetails(node.origin),
    ...(node.invocationOrigin
      ? { invocationOrigin: redactSourceDetails(node.invocationOrigin) }
      : {}),
    ...(node.adapterOrigin ? { adapterOrigin: redactSourceDetails(node.adapterOrigin) } : {}),
  };
}

function redactSourceDetails(source: RecipeSourceProvenance): RecipeSourceProvenance {
  const { name: _name, path: _path, ...publicSource } = source;
  return publicSource;
}

function actionCapabilities(
  action: string,
  adapter: ActionAdapter | undefined,
  adapterOrigin: RecipeSourceProvenance | undefined,
  manifestCapabilities: readonly RecipeExecutionCapability[],
  observes: boolean,
): RecipeExecutionCapability[] {
  const declared = adapter?.capabilities;
  const official = officialActions.has(action)
    ? officialRecipeActionCapabilities(
        action as Parameters<typeof officialRecipeActionCapabilities>[0],
      )
    : [];
  const observerCapabilities: RecipeExecutionCapability[] = observes ? ['host-read-export'] : [];
  const base: RecipeExecutionCapability[] = officialActions.has(action)
    ? [
        ...new Set([
          ...official,
          ...manifestCapabilities,
          ...(declared ?? []),
          ...observerCapabilities,
        ]),
      ]
    : declared
      ? [...new Set([...manifestCapabilities, ...declared, ...observerCapabilities])]
      : action === 'call'
        ? observerCapabilities
        : [
            ...new Set<RecipeExecutionCapability>([
              'arbitrary-code',
              ...manifestCapabilities,
              ...observerCapabilities,
            ]),
          ];
  if (adapterOrigin?.trust === 'trusted' || base.includes('arbitrary-code')) return [...base];
  return [...base, 'arbitrary-code'];
}

function declaredActionCapabilities(
  manifest: RecipeActionManifestDocument,
  action: string,
): RecipeExecutionCapability[] {
  return manifest.actions[action]?.execution_capabilities ?? [];
}

function adapterSource(
  action: string,
  adapter: ActionAdapter | undefined,
): RecipeSourceProvenance | undefined {
  if (action === 'call' || action === 'end') return bundledSource;
  if (adapter?.source) return adapter.source;
  return {
    kind: 'custom-adapter',
    trust: 'unknown',
    name: action,
  };
}

/**
 * Values Yarn (via Corepack) sets on every `yarn <script>` that say nothing about what the run does:
 * the per-invocation shim paths, and package metadata. Everything else, including user-set
 * `npm_config_*` and `COREPACK_*` settings such as a registry, stays bound to the approval.
 */
const VOLATILE_PACKAGE_MANAGER_ENV = new Set([
  'BERRY_BIN_FOLDER',
  'npm_execpath',
  'npm_node_execpath',
  'npm_config_user_agent',
  'INIT_CWD',
  'PROJECT_CWD',
  'COREPACK_ROOT',
  'COREPACK_ENABLE_DOWNLOAD_PROMPT',
]);
const RUN_OWNER_ENV = 'RECIPE_RUN_OWNER_PID';
const PACKAGE_METADATA_ENV = /^npm_package_/u;

/**
 * Approval binds substantive environment inputs, excluding package-manager invocation metadata
 * and the lifecycle owner PID. The provider validates ownership separately from plan approval.
 */
export function planEnvironment(
  env: Readonly<Record<string, string | undefined>>,
): Record<string, string | undefined> {
  const shims = env.BERRY_BIN_FOLDER;
  return Object.fromEntries(
    Object.entries(env)
      .filter(
        ([key]) =>
          key !== RUN_OWNER_ENV &&
          !VOLATILE_PACKAGE_MANAGER_ENV.has(key) &&
          !PACKAGE_METADATA_ENV.test(key),
      )
      .map(([key, value]) => {
        if (key !== 'PATH' || !shims || !value) return [key, value];
        const [first, ...rest] = value.split(path.delimiter);
        // Only Yarn's own shim entry at the front of PATH is volatile.
        return [key, first === shims ? rest.join(path.delimiter) : value];
      }),
  );
}

function digestValue(value: unknown): string {
  return digestRecipeDocument(value);
}

function containsRecipeOutputTemplate(value: unknown): boolean {
  if (typeof value === 'string') return value.includes('{{outputs.');
  if (Array.isArray(value)) return value.some(containsRecipeOutputTemplate);
  if (!isRecord(value)) return false;
  return Object.values(value).some(containsRecipeOutputTemplate);
}
