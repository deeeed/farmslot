import { createHash } from 'node:crypto';

import {
  DEFAULT_UNTRUSTED_RECIPE_BLOCKED_CAPABILITIES,
  normalizeRecipeFlowRef,
  OFFICIAL_RECIPE_ACTIONS,
  officialRecipeActionCapabilities,
  type RecipeActionCatalogEntry,
  type RecipeActionManifestDocument,
  type RecipeExecutionCapability,
  type RecipeExecutionPlan,
  type RecipePlanNode,
  type RecipeSourceProvenance,
} from '@farmslot/protocol';

import type { InlineFlow } from './flows.js';
import type { WorkflowGraph } from './graph.js';
import { invalidRecipeSource, RecipeTrustError } from './trust-error.js';
import type {
  ActionAdapter,
  PreconditionChecker,
  RecipeHudOptions,
  RecipeRunRequest,
} from './types.js';

const officialActions = new Set<string>(OFFICIAL_RECIPE_ACTIONS);
const bundledSource: RecipeSourceProvenance = {
  kind: 'bundled',
  trust: 'trusted',
  name: '@farmslot/recipe-harness',
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
  source,
  graph,
  flows,
  adapters,
  preconditions,
  actionManifest,
  projectRoot,
  artifactsDir,
  env,
  hud,
  recordVideo,
}: {
  recipe: unknown;
  source: RecipeSourceProvenance;
  graph: WorkflowGraph;
  flows: ReadonlyMap<string, InlineFlow>;
  adapters: ReadonlyMap<string, ActionAdapter>;
  preconditions: ReadonlyMap<string, PreconditionChecker>;
  actionManifest: RecipeActionManifestDocument;
  projectRoot: string;
  artifactsDir: string;
  env: Record<string, string | undefined>;
  hud?: RecipeHudOptions | false;
  recordVideo?: RecipeRunRequest['recordVideo'];
}): RecipeExecutionPlan {
  const nodes: RecipePlanNode[] = [];
  const digestNodes: Array<{ plan: RecipePlanNode; node: Record<string, unknown> }> = [];
  const visitedFlows = new Set<string>();

  const addNode = (
    nodeId: string,
    node: Record<string, unknown>,
    origin: RecipeSourceProvenance,
    invocationOrigin?: RecipeSourceProvenance,
  ): void => {
    if (typeof node.action !== 'string' || !node.action.trim()) return;
    const adapter = adapters.get(node.action);
    const adapterOrigin = adapterSource(node.action, adapter);
    const capabilities = actionCapabilities(
      node.action,
      adapter,
      adapterOrigin,
      declaredActionCapabilities(actionManifest, node.action),
    );
    const planNode: RecipePlanNode = {
      nodeId,
      action: node.action,
      capabilities,
      origin,
      ...(invocationOrigin ? { invocationOrigin } : {}),
      ...(adapterOrigin ? { adapterOrigin } : {}),
    };
    nodes.push(planNode);
    digestNodes.push({ plan: planNode, node });
    if (node.action === 'call' && typeof node.ref === 'string') {
      visitFlow(
        normalizeRecipeFlowRef(node.ref),
        effectiveInvocationOrigin(origin, invocationOrigin),
      );
    }
  };

  const visitFlow = (ref: string, invocationOrigin: RecipeSourceProvenance): void => {
    const visitKey = `${ref}:${digestValue(invocationOrigin)}`;
    if (visitedFlows.has(visitKey)) return;
    visitedFlows.add(visitKey);
    const flow = flows.get(ref);
    if (!flow) return;
    const origin = flow.origin ?? source;
    for (const [nodeId, node] of Object.entries(flow.nodes)) {
      addNode(`${ref}/${nodeId}`, node, origin, invocationOrigin);
    }
  };

  for (const [nodeId, node] of Object.entries(graph.nodes)) addNode(nodeId, node, source);
  for (const gate of graph.preconditions) {
    const checker = preconditions.get(gate.id);
    const origin = checker
      ? (checker.source ?? {
          kind: 'custom-adapter' as const,
          trust: 'unknown' as const,
          name: `precondition:${gate.id}`,
        })
      : bundledSource;
    const capabilities = checker ? (checker.capabilities ?? ['arbitrary-code']) : [];
    const planNode: RecipePlanNode = {
      nodeId: `pre_conditions:${gate.id}`,
      action: `precondition:${gate.id}`,
      capabilities,
      origin: source,
      adapterOrigin: origin,
    };
    nodes.push(planNode);
    digestNodes.push({ plan: planNode, node: { ...gate } });
  }

  if (hud !== false && hud?.enabled !== false && adapters.has('app.hud')) {
    addNode('run:hud', { action: 'app.hud', automatic: true, options: hud ?? {} }, source);
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

  const executionContextDigest = digestValue({ projectRoot, artifactsDir, env });
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
  if (request.approval?.planDigest === plan.digest) return;
  const publicBlocked = blocked.map(redactPlanNodeProvenance);
  if (request.approval) {
    throw new RecipeTrustError({
      code: 'RECIPE_APPROVAL_MISMATCH',
      message: 'Recipe approval does not match the resolved execution plan.',
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
  executable: Pick<ActionAdapter | PreconditionChecker, 'source' | 'resolveSourceDigest'>,
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
): RecipeExecutionCapability[] {
  const declared = adapter?.capabilities;
  const official = officialActions.has(action)
    ? officialRecipeActionCapabilities(
        action as Parameters<typeof officialRecipeActionCapabilities>[0],
      )
    : [];
  const base: RecipeExecutionCapability[] = officialActions.has(action)
    ? [...new Set([...official, ...manifestCapabilities, ...(declared ?? [])])]
    : declared
      ? [...new Set([...manifestCapabilities, ...declared])]
      : action === 'call'
        ? []
        : [...new Set<RecipeExecutionCapability>(['arbitrary-code', ...manifestCapabilities])];
  if (adapterOrigin?.trust === 'trusted' || base.includes('arbitrary-code')) return [...base];
  return [...base, 'arbitrary-code'];
}

function declaredActionCapabilities(
  manifest: RecipeActionManifestDocument,
  action: string,
): RecipeExecutionCapability[] {
  const metadata = (
    manifest.action_metadata as Record<string, RecipeActionCatalogEntry> | undefined
  )?.[action];
  const custom = manifest.custom_actions?.find((entry) => entry.name === action);
  return [...(metadata?.execution_capabilities ?? []), ...(custom?.execution_capabilities ?? [])];
}

function adapterSource(
  action: string,
  adapter: ActionAdapter | undefined,
): RecipeSourceProvenance | undefined {
  if (action === 'call') return bundledSource;
  if (adapter?.source) return adapter.source;
  return {
    kind: 'custom-adapter',
    trust: 'unknown',
    name: action,
  };
}

function digestValue(value: unknown): string {
  return `sha256:${createHash('sha256').update(canonicalRecipeJson(value)).digest('hex')}`;
}

export function canonicalRecipeJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalRecipeJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalRecipeJson(entry)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}
