import {
  normalizeRecipeRef,
  type RecipeActionManifestDocument,
  type RecipeFailureCause,
  validateResolvedRecipeActionNode,
} from '@farmslot/protocol';

import { RecipeExecutionError, recipeFailureCause } from './failure.js';
import { extractWorkflowGraph, resolveNextNode } from './graph.js';
import { isRecord } from './json.js';
import type { ResolvedLibraryRecipe } from './library.js';
import { resolveRecipeParams, resolveRecipeValue } from './parameters.js';
import {
  type DefaultObserverRefs,
  finalizeNodeObservations,
  resolveObserveRefs,
  runPassiveObservers,
} from './passive-observations.js';
import { RecipeResolutionError } from './resolution-error.js';
import { recordSyntheticFailure, traceNodeMetadata } from './trace.js';
import { verifyExecutableSource } from './trust.js';
import type {
  ActionAdapter,
  ActionExecutionContext,
  ActionResult,
  RecipeCallTrace,
  RecipeLogger,
  RecipeRunStatus,
  TraceWriter,
} from './types.js';

export const DEFAULT_MAX_RECIPE_CALL_DEPTH = 8;

type HudPublisher = (
  status: 'running' | 'pass' | 'fail',
  event: {
    nodeId: string;
    action: string;
    node: Record<string, unknown>;
    recipe: unknown;
    index: number;
    total: number;
    context: ActionExecutionContext;
    error?: string;
  },
) => Promise<boolean>;

export interface ExecuteRecipeOptions {
  ref: string;
  adapter?: string;
  recipe: Record<string, unknown>;
  params: Record<string, unknown>;
  prefix?: string;
  callStack?: readonly string[];
  maxCallDepth?: number;
  recipes: ReadonlyMap<string, ResolvedLibraryRecipe>;
  actionManifest: RecipeActionManifestDocument;
  adapters: ReadonlyMap<string, ActionAdapter>;
  traceWriter: TraceWriter;
  logger: RecipeLogger;
  defaultObserverRefs: DefaultObserverRefs;
  createContext(
    nodeId: string,
    recipe: unknown,
    outputs: ReadonlyMap<string, unknown>,
    getOutput: (nodeId: string) => unknown,
  ): ActionExecutionContext;
  registerArtifacts(artifacts: NonNullable<ActionResult['artifacts']>): void;
  publishHudProgress?: HudPublisher;
}

export interface ExecuteRecipeResult {
  status: RecipeRunStatus;
  failureCause?: RecipeFailureCause;
  output: Record<string, unknown>;
  outputs: ReadonlyMap<string, unknown>;
}

export async function executeRecipe(options: ExecuteRecipeOptions): Promise<ExecuteRecipeResult> {
  const callStack = options.callStack ?? [];
  const maxCallDepth = options.maxCallDepth ?? DEFAULT_MAX_RECIPE_CALL_DEPTH;
  if (callStack.includes(options.ref)) {
    throw new RecipeResolutionError(
      'RECIPE_CALL_CYCLE',
      `Recipe call cycle detected: ${[...callStack, options.ref].join(' -> ')}.`,
      'remove one call edge so the recipe dependency graph is acyclic',
    );
  }
  if (callStack.length >= maxCallDepth) {
    throw new RecipeResolutionError(
      'RECIPE_CALL_DEPTH_EXCEEDED',
      `Recipe call depth exceeded maximum ${maxCallDepth}.`,
      `reduce nested recipe calls below ${maxCallDepth}`,
    );
  }

  const params = resolveRecipeParams(options.ref, options.recipe, options.params);
  const graph = extractWorkflowGraph(options.recipe);
  const prefix = options.prefix ?? '';
  const outputs = new Map<string, unknown>();
  const localOutputs: Record<string, unknown> = {};
  const getOutput = (nodeId: string): unknown => {
    if (outputs.has(nodeId)) return outputs.get(nodeId);
    throw new Error(`No output recorded for node ${nodeId}.`);
  };
  const nextCallStack = [...callStack, options.ref];
  let failureCause: RecipeFailureCause | undefined;

  const runGraph = async (entry: string, nodeCount: number): Promise<RecipeRunStatus> => {
    let currentNodeId: string | undefined = entry;
    let transitionCount = 0;
    const maxTransitions = Math.max(1, nodeCount);

    while (currentNodeId) {
      const localNodeId = currentNodeId;
      const namespacedNodeId = `${prefix}${localNodeId}`;
      transitionCount += 1;
      if (transitionCount > maxTransitions) {
        recordSyntheticFailure(
          options.traceWriter,
          namespacedNodeId,
          new Error(`Recipe ${options.ref} exceeded its acyclic graph size.`),
          'unknown',
          'harness',
        );
        failureCause ??= 'harness';
        return 'fail';
      }

      const rawNode = graph.nodes[localNodeId];
      if (!rawNode) {
        recordSyntheticFailure(
          options.traceWriter,
          namespacedNodeId,
          new Error(`Recipe ${options.ref} node ${localNodeId} does not exist.`),
          'unknown',
          'harness',
        );
        failureCause ??= 'harness';
        return 'fail';
      }
      let resolvedNode: unknown;
      try {
        resolvedNode = resolveRecipeValue(rawNode, params, outputs);
      } catch (error) {
        recordSyntheticFailure(
          options.traceWriter,
          namespacedNodeId,
          error instanceof Error ? error : new Error(String(error)),
          typeof rawNode.action === 'string' ? rawNode.action : undefined,
          'harness',
        );
        failureCause ??= 'harness';
        return 'fail';
      }
      if (!isRecord(resolvedNode)) {
        recordSyntheticFailure(
          options.traceWriter,
          namespacedNodeId,
          new Error(`Recipe ${options.ref} node ${localNodeId} did not resolve to an object.`),
          'unknown',
          'harness',
        );
        failureCause ??= 'harness';
        return 'fail';
      }

      const node = resolvedNode;
      const action = String(node.action);
      const startedAt = new Date();
      if (action === 'end') {
        const status = terminalStatus(node.status);
        const failed = status === 'fail';
        options.traceWriter.record({
          nodeId: namespacedNodeId,
          action,
          startedAt: startedAt.toISOString(),
          endedAt: new Date().toISOString(),
          durationMs: Date.now() - startedAt.getTime(),
          ok: !failed,
          ...(failed ? { cause_class: 'subject' as const } : {}),
          status,
        });
        if (failed) failureCause ??= 'subject';
        return status;
      }

      const adapter = action === 'call' ? undefined : options.adapters.get(action);
      if (action !== 'call' && !adapter) {
        recordSyntheticFailure(
          options.traceWriter,
          namespacedNodeId,
          new Error(`No adapter registered for action ${action}.`),
          action,
          'harness',
        );
        failureCause ??= 'harness';
        return 'fail';
      }

      const context = options.createContext(namespacedNodeId, options.recipe, outputs, getOutput);
      try {
        const resolvedValidation = validateResolvedRecipeActionNode(node, options.actionManifest, {
          adapter: options.adapter,
        });
        if (resolvedValidation.status === 'invalid') {
          const resolutionError = new RecipeResolutionError(
            'RECIPE_PARAMS_INVALID',
            `Resolved parameters for ${action} are invalid: ${resolvedValidation.findings
              .map((finding) => `${finding.code} ${finding.path}: ${finding.message}`)
              .join('; ')}`,
            `inspect ${action} with actions --action ${action}`,
          );
          throw new RecipeExecutionError('harness', resolutionError.message, {
            cause: resolutionError,
          });
        }
        if (options.publishHudProgress) {
          const ok = await options.publishHudProgress('running', {
            nodeId: namespacedNodeId,
            action,
            node,
            recipe: options.recipe,
            index: transitionCount,
            total: nodeCount,
            context,
          });
          if (!ok) {
            throw new RecipeExecutionError(
              'harness',
              `app.hud running update failed for ${namespacedNodeId}.`,
            );
          }
        }

        const result =
          action === 'call'
            ? await executeRecipeCall({
                ...options,
                node,
                callNodeId: namespacedNodeId,
                callStack: nextCallStack,
              })
            : await executeAction(adapter!, action, node, context);
        const observeRefs = resolveObserveRefs(action, options.defaultObserverRefs);
        const observationResult =
          action === 'call'
            ? {}
            : await runPassiveObservers({
                action,
                node,
                adapter: adapter!,
                context,
                logger: options.logger,
                refs: observeRefs,
              });
        if (result.output !== undefined) {
          localOutputs[localNodeId] = result.output;
          outputs.set(localNodeId, result.output);
        }
        if (result.artifacts?.length) options.registerArtifacts(result.artifacts);
        const next = resolveNextNode(node, result);
        if (!next) {
          throw new RecipeExecutionError(
            'harness',
            `Recipe node ${localNodeId} has no next target.`,
          );
        }
        const { observations, observationWarnings } = finalizeNodeObservations({
          result,
          observationResult,
          observeRefs,
        });
        options.traceWriter.record({
          nodeId: namespacedNodeId,
          action,
          ...(action === 'call' ? { recipe: recipeCallTrace(node, options.recipes) } : {}),
          ...traceNodeMetadata(node, result),
          startedAt: startedAt.toISOString(),
          endedAt: new Date().toISOString(),
          durationMs: Date.now() - startedAt.getTime(),
          ok: true,
          next,
          case: result.case,
          output: result.output,
          ...(result.phases?.length ? { phases: result.phases } : {}),
          ...(observations ? { observations } : {}),
          ...(observationWarnings.length ? { observationWarnings } : {}),
        });
        if (options.publishHudProgress) {
          const ok = await options.publishHudProgress('pass', {
            nodeId: namespacedNodeId,
            action,
            node,
            recipe: options.recipe,
            index: transitionCount,
            total: nodeCount,
            context,
          });
          if (!ok) {
            throw new RecipeExecutionError(
              'harness',
              `app.hud completion update failed for ${namespacedNodeId}.`,
            );
          }
        }
        currentNodeId = next;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const causeClass = recipeFailureCause(error);
        failureCause ??= causeClass;
        if (options.publishHudProgress) {
          try {
            await options.publishHudProgress('fail', {
              nodeId: namespacedNodeId,
              action,
              node,
              recipe: options.recipe,
              index: transitionCount,
              total: nodeCount,
              context,
              error: message,
            });
          } catch (hudError) {
            options.logger.warn(
              `app.hud failure update failed for ${namespacedNodeId}: ${hudError instanceof Error ? hudError.message : String(hudError)}`,
            );
          }
        }
        options.traceWriter.record({
          nodeId: namespacedNodeId,
          action,
          ...(action === 'call' ? { recipe: recipeCallTrace(node, options.recipes) } : {}),
          ...traceNodeMetadata(node),
          startedAt: startedAt.toISOString(),
          endedAt: new Date().toISOString(),
          durationMs: Date.now() - startedAt.getTime(),
          ok: false,
          cause_class: causeClass,
          error: message,
        });
        return 'fail';
      }
    }
    return 'fail';
  };

  const mainStatus = await runGraph(graph.entry, graph.mainNodeCount);
  const teardownStatus = graph.teardownEntry
    ? await runGraph(graph.teardownEntry, graph.teardownNodeCount)
    : 'pass';
  const status = combineStatuses(mainStatus, teardownStatus);
  return {
    status,
    ...(status === 'fail' ? { failureCause: failureCause ?? 'unknown' } : {}),
    output: recipeOutput(options.ref, status, localOutputs),
    outputs,
  };
}

async function executeRecipeCall(
  options: ExecuteRecipeOptions & {
    node: Record<string, unknown>;
    callNodeId: string;
    callStack: readonly string[];
  },
): Promise<ActionResult> {
  const ref = typeof options.node.ref === 'string' ? normalizeRecipeRef(options.node.ref) : '';
  if (!ref) throw new RecipeExecutionError('harness', 'call.ref must be a non-empty recipe id.');
  const resolved = options.recipes.get(ref);
  if (!resolved) {
    throw new RecipeExecutionError(
      'harness',
      `Recipe ${ref} is not available from the configured libraries.`,
    );
  }
  const result = await executeRecipe({
    ...options,
    ref,
    recipe: resolved.document,
    params: isRecord(options.node.params) ? options.node.params : {},
    prefix: `${options.callNodeId}/`,
    callStack: options.callStack,
  });
  if (result.status !== 'pass') {
    throw new RecipeExecutionError(
      result.failureCause ?? 'unknown',
      `Recipe ${ref} finished with status ${result.status}.`,
    );
  }
  return { output: result.output };
}

function recipeCallTrace(
  node: Record<string, unknown>,
  recipes: ReadonlyMap<string, ResolvedLibraryRecipe>,
): RecipeCallTrace | undefined {
  const ref = typeof node.ref === 'string' ? normalizeRecipeRef(node.ref) : '';
  const resolved = ref ? recipes.get(ref) : undefined;
  const digest = resolved?.provenance.digest;
  if (!resolved || !digest) return undefined;
  return {
    ref,
    digest,
    source: resolved.source,
    file: resolved.file,
    ...(resolved.adapter ? { adapter: resolved.adapter } : {}),
  };
}

async function executeAction(
  adapter: ActionAdapter,
  action: string,
  node: Record<string, unknown>,
  context: ActionExecutionContext,
): Promise<ActionResult> {
  await verifyExecutableSource(adapter, `Action ${action}`);
  return adapter.execute(node, context);
}

function terminalStatus(value: unknown): RecipeRunStatus {
  if (value === 'pass' || value === 'fail' || value === 'unknown') return value;
  throw new Error('end.status must be pass, fail, or unknown.');
}

function combineStatuses(
  mainStatus: RecipeRunStatus,
  teardownStatus: RecipeRunStatus,
): RecipeRunStatus {
  if (mainStatus === 'fail' || teardownStatus === 'fail') return 'fail';
  if (mainStatus === 'unknown' || teardownStatus === 'unknown') return 'unknown';
  return 'pass';
}

function recipeOutput(
  ref: string,
  status: RecipeRunStatus,
  outputs: Record<string, unknown>,
): Record<string, unknown> {
  return { ref, status, outputs };
}
