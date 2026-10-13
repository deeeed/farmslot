import path from 'node:path';

import {
  normalizeRecipeRef,
  type RecipeResolutionDocument,
  type RecipeResolutionEdge,
  type RecipeSourceProvenance,
  resolvedRecipeArtifactPath,
  validateRecipeActionRelationships,
  validateResolvedRecipeActionNode,
} from '@farmslot/protocol';

import { DEFAULT_MAX_RECIPE_CALL_DEPTH } from './execution.js';
import { extractWorkflowGraph } from './graph.js';
import { isRecord, normalizeRelativePath } from './json.js';
import type { ResolvedLibraryRecipe } from './library.js';
import { resolveRecipeParams, resolveRecipeValue } from './parameters.js';
import { RecipeResolutionError } from './resolution-error.js';

export interface ResolvedRecipeDependencies {
  recipes: ReadonlyMap<string, ResolvedLibraryRecipe>;
  edges: RecipeResolutionEdge[];
  document: RecipeResolutionDocument;
}

export function rootResolutionRef(digest: string): string {
  return `$root:${digest}`;
}

/** Validate static invocations and return their run-scoped log paths before effects. */
export function validateRecipeDependencyParams(options: {
  root: Record<string, unknown>;
  params: Record<string, unknown>;
  recipes: ReadonlyMap<string, ResolvedLibraryRecipe>;
  actionManifest?: unknown;
}): Set<string> {
  const runLogPaths = new Set<string>();
  const visit = (document: Record<string, unknown>, params: Record<string, unknown>): void => {
    for (const [nodeId, rawNode] of Object.entries(extractWorkflowGraph(document).nodes)) {
      const node = resolveRecipeValue(rawNode, params, undefined, { nodeId });
      if (!isRecord(node)) continue;
      const validation =
        node.action === 'ui.wait_for' && node.enabled !== undefined
          ? validateRecipeActionRelationships(node)
          : node.action === 'watch_logs' && options.actionManifest
            ? validateResolvedRecipeActionNode(node, options.actionManifest, {
                allowTemplates: true,
              })
            : undefined;
      if (validation?.status === 'invalid') {
        throw new RecipeResolutionError(
          'RECIPE_PARAMS_INVALID',
          `Recipe node ${nodeId}: ${validation.findings.map((finding) => finding.message).join('; ')}`,
          'correct the observation parameters before running the recipe',
        );
      }
      if (
        node.action === 'watch_logs' &&
        options.actionManifest &&
        node.scope !== 'file' &&
        typeof node.path === 'string'
      ) {
        runLogPaths.add(normalizeRelativePath(node.path).split(path.sep).join('/'));
      }
      if (node.action !== 'call' || typeof node.ref !== 'string') continue;
      const ref = normalizeRecipeRef(node.ref);
      const dependency = options.recipes.get(ref);
      if (!dependency) continue;
      const childParams = resolveRecipeParams(
        ref,
        dependency.document,
        isRecord(node.params) ? node.params : {},
        { allowTemplates: true },
      );
      visit(dependency.document, childParams);
    }
  };
  visit(options.root, options.params);
  return runLogPaths;
}

/** Resolve the exact static recipe call DAG before any side effect. */
export function resolveRecipeDependencies(options: {
  rootRef: string;
  root: Record<string, unknown>;
  rootSource: RecipeSourceProvenance;
  recipes: ReadonlyMap<string, ResolvedLibraryRecipe>;
  maxDepth?: number;
}): ResolvedRecipeDependencies {
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_RECIPE_CALL_DEPTH;
  const resolved = new Map<string, ResolvedLibraryRecipe>();
  const edges: RecipeResolutionEdge[] = [];
  const visiting: string[] = [];
  const visited = new Set<string>();

  const visit = (from: string, document: Record<string, unknown>, depth: number): void => {
    if (depth >= maxDepth) {
      throw new RecipeResolutionError(
        'RECIPE_CALL_DEPTH_EXCEEDED',
        `Recipe call depth exceeded maximum ${maxDepth}.`,
        `reduce nested recipe calls below ${maxDepth}`,
      );
    }
    for (const ref of callRefs(document)) {
      edges.push({ from, to: ref });
      const cycleStart = visiting.indexOf(ref);
      if (cycleStart >= 0 || ref === options.rootRef) {
        const cycle = [...visiting.slice(Math.max(cycleStart, 0)), ref];
        throw new RecipeResolutionError(
          'RECIPE_CALL_CYCLE',
          `Recipe call cycle detected: ${cycle.join(' -> ')}.`,
          'remove one call edge so the recipe dependency graph is acyclic',
        );
      }
      const dependency = options.recipes.get(ref);
      if (!dependency) {
        throw new RecipeResolutionError(
          'RECIPE_REFERENCE_NOT_FOUND',
          `Recipe ${ref} is not available from configured libraries.`,
          `add ${ref} to a configured recipe library or correct call.ref`,
        );
      }
      resolved.set(ref, dependency);
      if (visited.has(ref)) continue;
      visiting.push(ref);
      visit(ref, dependency.document, depth + 1);
      visiting.pop();
      visited.add(ref);
    }
  };

  visiting.push(options.rootRef);
  visit(options.rootRef, options.root, 0);
  visiting.pop();

  const rootDigest = options.rootSource.digest;
  if (!rootDigest) {
    throw new RecipeResolutionError(
      'RECIPE_RESOLUTION_DIGEST_MISSING',
      'Resolved root recipe source is missing its content digest.',
      'reload the root recipe through the runner so its digest is computed',
    );
  }
  const dependencies = [...resolved.values()]
    .sort((left, right) => compareStrings(left.ref, right.ref))
    .map((recipe) => {
      const digest = recipe.provenance.digest;
      if (!digest) {
        throw new RecipeResolutionError(
          'RECIPE_RESOLUTION_DIGEST_MISSING',
          `Resolved recipe ${recipe.ref} is missing its content digest.`,
          `reload ${recipe.ref} through the library resolver so its digest is computed`,
        );
      }
      return {
        ref: recipe.ref,
        source: recipe.source,
        file: recipe.file,
        digest,
        artifact: resolvedRecipeArtifactPath(digest)!,
        ...(recipe.adapter ? { adapter: recipe.adapter } : {}),
      };
    });
  return {
    recipes: resolved,
    edges,
    document: {
      schema_version: 1,
      root: { ref: options.rootRef, digest: rootDigest },
      dependencies,
      edges: [...edges].sort((left, right) =>
        compareStrings(`${left.from}:${left.to}`, `${right.from}:${right.to}`),
      ),
    },
  };
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function callRefs(recipe: Record<string, unknown>): string[] {
  const refs: string[] = [];
  for (const node of Object.values(extractWorkflowGraph(recipe).nodes)) {
    if (node.action === 'call' && typeof node.ref === 'string' && node.ref.trim()) {
      refs.push(normalizeRecipeRef(node.ref));
    }
  }
  return refs;
}
