import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import {
  normalizeRecipeFlowRef,
  type RecipeSourceProvenance,
  type UiObserverRef,
} from '@farmslot/protocol';

import { JsonTraceWriter } from '../node/writers.js';

import { resolveNextNode } from './graph.js';
import { isRecord, normalizeRelativePath, readJsonFile } from './json.js';
import {
  type DefaultObserverRefs,
  finalizeNodeObservations,
  resolveObserveRefs,
  runPassiveObservers,
} from './passive-observations.js';
import { evaluateNodeGate, evaluatePredicate, getPathValue } from './predicates.js';
import { traceNodeMetadata } from './trace.js';
import { invalidRecipeSource } from './trust-error.js';
import type { ActionAdapter, ActionResult, RecipeLogger } from './types.js';

type FlowHudPublisher = (
  status: 'running' | 'pass' | 'fail',
  event: {
    nodeId: string;
    action: string;
    node: Record<string, unknown>;
    index: number;
    total: number;
    context: Parameters<ActionAdapter['execute']>[1];
    error?: string;
  },
) => Promise<boolean>;

export interface InlineFlow {
  entry: string;
  nodes: Record<string, Record<string, unknown>>;
  paramsSchema?: unknown;
  postcondition?: unknown;
  origin?: RecipeSourceProvenance;
}

export async function collectFlows(
  recipe: unknown,
  options: {
    projectRoot: string;
    recipeDir: string;
    recipeSource?: RecipeSourceProvenance;
  },
): Promise<ReadonlyMap<string, InlineFlow>> {
  const flows = new Map<string, InlineFlow>();
  if (!isRecord(recipe)) return flows;

  for (const catalogPath of collectUsePaths(recipe.uses)) {
    const resolvedPath = await resolveUsePath(catalogPath, options);
    const catalog = await readJsonFile(resolvedPath);
    addCatalogFlows(flows, catalog, catalogPath, {
      kind: 'uses-catalog',
      trust: options.recipeSource?.trust ?? 'unknown',
      path: resolvedPath,
    });
  }

  if (isRecord(recipe.flows)) {
    addCatalogFlows(flows, { flows: recipe.flows }, 'recipe.flows', options.recipeSource);
  }
  return flows;
}

function collectUsePaths(value: unknown): string[] {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new Error('uses must be an array of flow catalog paths.');
  return value.map((entry, index) => {
    if (typeof entry !== 'string' || !entry.trim()) {
      throw new Error(`uses[${index}] must be a non-empty flow catalog path.`);
    }
    return entry;
  });
}

async function resolveUsePath(
  catalogPath: string,
  options: { projectRoot: string; recipeDir: string },
): Promise<string> {
  const normalized = normalizeRelativePath(catalogPath);
  const fromRecipe = path.join(options.recipeDir, normalized);
  if (path.isAbsolute(catalogPath)) {
    throw invalidRecipeSource(
      `uses entry ${catalogPath} must be relative.`,
      'reference a catalog within the project root using a relative path',
    );
  }
  const candidate = isWithin(options.projectRoot, fromRecipe)
    ? fromRecipe
    : path.join(options.projectRoot, normalized);
  const [projectReal, candidateReal] = await Promise.all([
    realpath(options.projectRoot),
    realpath(candidate),
  ]);
  if (!isWithin(projectReal, candidateReal)) {
    throw invalidRecipeSource(
      `uses entry ${catalogPath} resolves outside project root.`,
      'move the catalog inside the project root or remove the escaping symlink',
    );
  }
  return candidateReal;
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
  );
}

function addCatalogFlows(
  flows: Map<string, InlineFlow>,
  catalog: unknown,
  source: string,
  origin?: RecipeSourceProvenance,
): void {
  for (const entry of readCatalogFlows(catalog, source)) {
    if (flows.has(entry.ref)) throw new Error(`Flow ${entry.ref} is declared more than once.`);
    flows.set(entry.ref, { ...entry.flow, ...(origin ? { origin } : {}) });
  }
}

export interface CatalogFlowEntry {
  ref: string;
  flow: InlineFlow;
  raw: Record<string, unknown>;
}

export function readCatalogFlows(catalog: unknown, source: string): CatalogFlowEntry[] {
  if (!isRecord(catalog) || !isRecord(catalog.flows)) {
    throw new Error(`Flow catalog ${source} must contain a flows object.`);
  }
  return Object.entries(catalog.flows).map(([ref, flow]) => {
    const normalizedRef = normalizeRecipeFlowRef(ref);
    if (!normalizedRef) throw new Error(`Flow id in ${source} must not be empty.`);
    if (!isRecord(flow)) throw new Error(`Flow ${ref} in ${source} must be an object.`);
    return { ref: normalizedRef, flow: normalizeFlow(normalizedRef, flow, source), raw: flow };
  });
}

function normalizeFlow(ref: string, flow: unknown, source: string): InlineFlow {
  if (!isRecord(flow)) throw new Error(`Flow ${ref} in ${source} must be an object.`);
  const workflow = isRecord(flow.workflow) ? flow.workflow : flow;
  if (typeof workflow.entry !== 'string' || !workflow.entry.trim() || !isRecord(workflow.nodes)) {
    throw new Error(`Flow ${ref} in ${source} must include workflow.entry and workflow.nodes.`);
  }
  const nodes: Record<string, Record<string, unknown>> = Object.create(null) as Record<
    string,
    Record<string, unknown>
  >;
  for (const [nodeId, node] of Object.entries(workflow.nodes)) {
    if (isRecord(node)) nodes[nodeId] = node;
  }
  return {
    entry: workflow.entry,
    nodes,
    paramsSchema: flow.paramsSchema,
    postcondition: flow.postcondition,
  };
}

export async function executeInlineFlowCall({
  callNodeId,
  node,
  context,
  flowCatalog,
  adapters,
  traceWriter,
  callStack,
  maxCallDepth,
  logger,
  defaultObserverRefs,
  declaredObserverRefs,
  publishHudProgress,
}: {
  callNodeId: string;
  node: Record<string, unknown>;
  context: Parameters<ActionAdapter['execute']>[1];
  flowCatalog: ReadonlyMap<string, InlineFlow>;
  adapters: ReadonlyMap<string, ActionAdapter>;
  traceWriter: JsonTraceWriter;
  callStack: readonly string[];
  maxCallDepth: number;
  logger: RecipeLogger;
  defaultObserverRefs: DefaultObserverRefs;
  declaredObserverRefs: readonly UiObserverRef[];
  publishHudProgress?: FlowHudPublisher;
}): Promise<ActionResult> {
  const ref = typeof node.ref === 'string' ? normalizeRecipeFlowRef(node.ref) : '';
  if (!ref) throw new Error('call.ref must be a non-empty flow id.');
  if (callStack.includes(ref)) {
    throw new Error(`Flow call cycle detected: ${[...callStack, ref].join(' -> ')}.`);
  }
  if (callStack.length >= maxCallDepth) {
    throw new Error(`Flow call depth exceeded maximum ${maxCallDepth}.`);
  }
  const flow = flowCatalog.get(ref);
  if (!flow) throw new Error(`Flow ${ref} is not available from recipe uses or inline flows.`);
  const params = isRecord(node.params) ? node.params : {};
  validateParamsSchema(params, flow.paramsSchema, ref);
  const nextCallStack = [...callStack, ref];
  const output = await executeInlineFlow({
    callNodeId,
    flowRef: ref,
    flow,
    params,
    context,
    flowCatalog,
    adapters,
    traceWriter,
    callStack: nextCallStack,
    maxCallDepth,
    logger,
    defaultObserverRefs,
    declaredObserverRefs,
    publishHudProgress,
  });
  if (flow.postcondition != null && !evaluatePredicate(output, flow.postcondition)) {
    throw new Error(`Flow ${ref} failed its postcondition.`);
  }
  return { output };
}

async function executeInlineFlow({
  callNodeId,
  flowRef,
  flow,
  params,
  context,
  flowCatalog,
  adapters,
  traceWriter,
  callStack,
  maxCallDepth,
  logger,
  defaultObserverRefs,
  declaredObserverRefs,
  publishHudProgress,
}: {
  callNodeId: string;
  flowRef: string;
  flow: InlineFlow;
  params: Record<string, unknown>;
  context: Parameters<ActionAdapter['execute']>[1];
  flowCatalog: ReadonlyMap<string, InlineFlow>;
  adapters: ReadonlyMap<string, ActionAdapter>;
  traceWriter: JsonTraceWriter;
  callStack: readonly string[];
  maxCallDepth: number;
  logger: RecipeLogger;
  defaultObserverRefs: DefaultObserverRefs;
  declaredObserverRefs: readonly UiObserverRef[];
  publishHudProgress?: FlowHudPublisher;
}): Promise<Record<string, unknown>> {
  let currentNodeId: string | undefined = flow.entry;
  let transitionCount = 0;
  const maxTransitions = Object.keys(flow.nodes).length * 3;
  const flowOutputs: Record<string, unknown> = {};
  const flowOutputMap = new Map<string, unknown>();
  flowOutputMap.set('params', params);
  flowOutputMap.set(`${callNodeId}/params`, params);
  while (currentNodeId) {
    transitionCount += 1;
    if (transitionCount > maxTransitions) {
      throw new Error(`Flow ${flowRef} exceeded its maximum transition count.`);
    }
    const localNodeId = currentNodeId;
    const rawFlowNode = flow.nodes[localNodeId];
    if (!rawFlowNode) throw new Error(`Flow ${flowRef} node ${localNodeId} does not exist.`);
    const flowNode = resolveParams(rawFlowNode, params);
    const action = String(flowNode.action);
    const adapter = action === 'call' ? undefined : adapters.get(action);
    if (action !== 'call' && !adapter)
      throw new Error(`No adapter registered for flow action ${action}.`);
    const startedAt = new Date();
    const namespacedNodeId = `${callNodeId}/${localNodeId}`;
    try {
      const mergedOutputs = new Map([...context.outputs, ...flowOutputMap]);
      const gate = evaluateNodeGate(flowNode, mergedOutputs);
      if (!gate.run) {
        const next = resolveNextNode(flowNode, {});
        traceWriter.record({
          nodeId: namespacedNodeId,
          action,
          ...traceNodeMetadata(flowNode),
          startedAt: startedAt.toISOString(),
          endedAt: new Date().toISOString(),
          durationMs: Date.now() - startedAt.getTime(),
          ok: true,
          next,
          output: { skipped: true, reason: gate.reason },
        });
        currentNodeId = next;
        continue;
      }
      const childContext = {
        ...context,
        nodeId: namespacedNodeId,
        outputs: mergedOutputs,
        getOutput(nodeId: string) {
          if (flowOutputMap.has(nodeId)) return flowOutputMap.get(nodeId);
          const namespacedLookup = `${callNodeId}/${nodeId}`;
          if (flowOutputMap.has(namespacedLookup)) return flowOutputMap.get(namespacedLookup);
          return context.getOutput(nodeId);
        },
      };
      if (publishHudProgress) {
        const hudStarted = await publishHudProgress('running', {
          nodeId: namespacedNodeId,
          action,
          node: flowNode,
          index: transitionCount,
          total: Object.keys(flow.nodes).length,
          context: childContext,
        });
        if (!hudStarted) throw new Error(`app.hud running update failed for ${namespacedNodeId}.`);
      }
      const result =
        action === 'call'
          ? await executeInlineFlowCall({
              callNodeId: namespacedNodeId,
              node: flowNode,
              context: childContext,
              flowCatalog,
              adapters,
              traceWriter,
              callStack,
              maxCallDepth,
              logger,
              defaultObserverRefs,
              declaredObserverRefs,
              publishHudProgress,
            })
          : await adapter!.execute(flowNode, childContext);
      const observeRefs = resolveObserveRefs(
        action,
        flowNode,
        defaultObserverRefs,
        declaredObserverRefs,
      );
      const observationResult =
        action !== 'call' && (result.status == null || result.status === 'pass')
          ? await runPassiveObservers({
              action,
              node: flowNode,
              adapter: adapter!,
              context: childContext,
              logger,
              refs: observeRefs,
            })
          : {};
      if (result.output !== undefined) {
        flowOutputs[localNodeId] = result.output as Record<string, unknown>;
        flowOutputMap.set(localNodeId, result.output);
        flowOutputMap.set(namespacedNodeId, result.output);
      }
      const { observations, observationWarnings } = finalizeNodeObservations({
        nodeId: namespacedNodeId,
        node: flowNode,
        result,
        observationResult,
        observeRefs,
      });
      traceWriter.record({
        nodeId: namespacedNodeId,
        action,
        ...traceNodeMetadata(flowNode, result),
        startedAt: startedAt.toISOString(),
        endedAt: new Date().toISOString(),
        durationMs: Date.now() - startedAt.getTime(),
        ok: true,
        next: resolveNextNode(flowNode, result),
        status: result.status,
        case: result.case,
        output: result.output,
        ...(observations ? { observations } : {}),
        ...(observationWarnings.length ? { observationWarnings } : {}),
      });
      if (publishHudProgress) {
        const hudCompleted = await publishHudProgress(result.status === 'fail' ? 'fail' : 'pass', {
          nodeId: namespacedNodeId,
          action,
          node: flowNode,
          index: transitionCount,
          total: Object.keys(flow.nodes).length,
          context: childContext,
        });
        if (!hudCompleted)
          throw new Error(`app.hud completion update failed for ${namespacedNodeId}.`);
      }
      if (result.status) {
        if (result.status === 'fail') throw new Error(`Flow ${flowRef} failed at ${localNodeId}.`);
        return { ref: flowRef, status: result.status, outputs: flowOutputs };
      }
      currentNodeId = resolveNextNode(flowNode, result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const mergedOutputs = new Map([...context.outputs, ...flowOutputMap]);
      const childContext = {
        ...context,
        nodeId: namespacedNodeId,
        outputs: mergedOutputs,
        getOutput(nodeId: string) {
          if (flowOutputMap.has(nodeId)) return flowOutputMap.get(nodeId);
          const namespacedLookup = `${callNodeId}/${nodeId}`;
          if (flowOutputMap.has(namespacedLookup)) return flowOutputMap.get(namespacedLookup);
          return context.getOutput(nodeId);
        },
      };
      if (publishHudProgress) {
        await publishHudProgress('fail', {
          nodeId: namespacedNodeId,
          action,
          node: flowNode,
          index: transitionCount,
          total: Object.keys(flow.nodes).length,
          context: childContext,
          error: message,
        });
      }
      traceWriter.record({
        nodeId: namespacedNodeId,
        action,
        ...traceNodeMetadata(flowNode),
        startedAt: startedAt.toISOString(),
        endedAt: new Date().toISOString(),
        durationMs: Date.now() - startedAt.getTime(),
        ok: false,
        error: message,
      });
      throw error;
    }
  }
  return { ref: flowRef, status: 'unknown', outputs: flowOutputs };
}

function validateParamsSchema(
  params: Record<string, unknown>,
  schema: unknown,
  flowRef: string,
): void {
  if (schema == null) return;
  if (!isRecord(schema)) throw new Error(`Flow ${flowRef} paramsSchema must be an object.`);
  if (schema.type != null && schema.type !== 'object') {
    throw new Error(`Flow ${flowRef} paramsSchema.type must be object.`);
  }
  if (Array.isArray(schema.required)) {
    for (const key of schema.required) {
      if (typeof key !== 'string') continue;
      if (!Object.prototype.hasOwnProperty.call(params, key)) {
        throw new Error(`Flow ${flowRef} params missing required field ${key}.`);
      }
    }
  }
  if (!isRecord(schema.properties)) return;
  for (const [key, propertySchema] of Object.entries(schema.properties)) {
    if (!Object.prototype.hasOwnProperty.call(params, key)) continue;
    validateParamValue(params[key], propertySchema, `Flow ${flowRef} params.${key}`);
  }
}

function validateParamValue(value: unknown, schema: unknown, label: string): void {
  if (!isRecord(schema)) return;
  if (Array.isArray(schema.enum) && !schema.enum.some((entry) => isDeepStrictEqual(entry, value))) {
    throw new Error(`${label} must be one of ${JSON.stringify(schema.enum)}.`);
  }
  if (schema.type == null) return;
  const actualType = Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value;
  if (actualType !== schema.type) {
    throw new Error(`${label} must be ${String(schema.type)}, received ${actualType}.`);
  }
}

function resolveParams(
  node: Record<string, unknown>,
  params: Record<string, unknown>,
): Record<string, unknown> {
  return resolveParamValue(node, params) as Record<string, unknown>;
}

function resolveParamValue(value: unknown, params: Record<string, unknown>): unknown {
  if (typeof value === 'string') {
    const fullMatch = /^\{\{params\.([A-Za-z0-9_.-]+)\}\}$/.exec(value);
    if (fullMatch) return getPathValue(params, fullMatch[1]!);
    return value.replace(/\{\{params\.([A-Za-z0-9_.-]+)\}\}/g, (_match, key: string) =>
      String(getPathValue(params, key) ?? ''),
    );
  }
  if (Array.isArray(value)) return value.map((entry) => resolveParamValue(entry, params));
  if (!isRecord(value)) return value;
  const resolved: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    resolved[key] = resolveParamValue(entry, params);
  }
  return resolved;
}
