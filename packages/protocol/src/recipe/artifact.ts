import {
  addFinding,
  ARTIFACT_TYPES,
  createContext,
  finishResult,
  isNonEmptyString,
  isRecord,
  isRelativeArtifactPath,
  type RecipeArtifactPackageInput,
  type RecipeResolutionDocument,
  type RecipeValidationResult,
  TERMINAL_STATUSES,
} from './common.js';
import { digestRecipeDocument, resolvedRecipeArtifactPath } from './digest.js';
import { validateRecipeDocument } from './document.js';
import {
  getRecipeCallRefs,
  getRecipeWorkflowActionEntries,
  getRecipeWorkflowNodeIds,
  normalizeRecipeRef,
} from './workflow.js';

export function validateArtifactManifestDocument(
  manifest: unknown,
  options: { recipe?: unknown; artifactPaths?: readonly string[] } = {},
): RecipeValidationResult {
  const ctx = createContext();
  if (!isRecord(manifest)) {
    addFinding(
      ctx,
      'error',
      'artifact_manifest.invalid_document',
      '$',
      'artifact-manifest.json must be a JSON object.',
    );
    return finishResult(ctx);
  }

  if (manifest.version !== 1) {
    addFinding(
      ctx,
      'error',
      'artifact_manifest.invalid_version',
      'version',
      'artifact-manifest.json version must equal 1.',
    );
  }

  if (
    manifest.runStatus != null &&
    (typeof manifest.runStatus !== 'string' || !TERMINAL_STATUSES.has(manifest.runStatus))
  ) {
    addFinding(
      ctx,
      'error',
      'artifact_manifest.invalid_run_status',
      'runStatus',
      'runStatus must be pass, fail, or unknown when present.',
    );
  }

  if (manifest.provenance != null) {
    if (!isRecord(manifest.provenance)) {
      addFinding(
        ctx,
        'error',
        'artifact_manifest.invalid_provenance',
        'provenance',
        'provenance must be an object when present.',
      );
    } else if (manifest.provenance.runner != null) {
      if (!isRecord(manifest.provenance.runner)) {
        addFinding(
          ctx,
          'error',
          'artifact_manifest.invalid_runner_provenance',
          'provenance.runner',
          'provenance.runner must be an object when present.',
        );
      } else {
        const runner = manifest.provenance.runner;
        for (const requiredField of ['source', 'git_ref']) {
          if (!isNonEmptyString(runner[requiredField])) {
            addFinding(
              ctx,
              'error',
              'artifact_manifest.invalid_runner_provenance_field',
              `provenance.runner.${requiredField}`,
              `provenance.runner.${requiredField} must be a non-empty string.`,
            );
          }
        }
        for (const optionalField of ['name', 'version']) {
          const value = runner[optionalField];
          if (value != null && typeof value !== 'string') {
            addFinding(
              ctx,
              'error',
              'artifact_manifest.invalid_runner_provenance_field',
              `provenance.runner.${optionalField}`,
              `provenance.runner.${optionalField} must be a string when present.`,
            );
          }
        }
      }
    }
  }

  const artifacts = manifest.artifacts;
  if (!Array.isArray(artifacts)) {
    addFinding(
      ctx,
      'error',
      'artifact_manifest.invalid_artifacts',
      'artifacts',
      'artifact-manifest.json must include an artifacts array.',
    );
    return finishResult(ctx);
  }

  const nodeIds = new Set(getRecipeWorkflowNodeIds(options.recipe));
  const artifactPathSet = options.artifactPaths ? new Set(options.artifactPaths) : null;

  artifacts.forEach((artifact, index) => {
    const path = `artifacts[${index}]`;
    if (!isRecord(artifact)) {
      addFinding(
        ctx,
        'error',
        'artifact_manifest.invalid_artifact',
        path,
        'Artifact entries must be objects.',
      );
      return;
    }

    if (!isNonEmptyString(artifact.path)) {
      addFinding(
        ctx,
        'error',
        'artifact_manifest.invalid_path',
        `${path}.path`,
        'Artifact path must be a non-empty string.',
      );
    } else {
      if (!isRelativeArtifactPath(artifact.path)) {
        addFinding(
          ctx,
          'error',
          'artifact_manifest.unsafe_path',
          `${path}.path`,
          'Artifact path must be relative and must not contain .. segments.',
        );
      }
      if (artifactPathSet && !artifactPathSet.has(artifact.path)) {
        addFinding(
          ctx,
          'error',
          'artifact_manifest.missing_file',
          `${path}.path`,
          `Artifact file ${artifact.path} was not found in the provided artifact path list.`,
        );
      }
    }

    if (!isNonEmptyString(artifact.type)) {
      addFinding(
        ctx,
        'error',
        'artifact_manifest.invalid_type',
        `${path}.type`,
        'Artifact type must be a non-empty string.',
      );
    } else if (!ARTIFACT_TYPES.has(artifact.type)) {
      addFinding(
        ctx,
        'warning',
        'artifact_manifest.unknown_type',
        `${path}.type`,
        `Artifact type ${artifact.type} is not in the v1 core type vocabulary.`,
      );
    }

    for (const optionalField of ['label', 'nodeId', 'mimeType', 'category', 'proofTarget']) {
      const value = artifact[optionalField];
      if (value != null && typeof value !== 'string') {
        addFinding(
          ctx,
          'error',
          'artifact_manifest.invalid_optional_field',
          `${path}.${optionalField}`,
          `${optionalField} must be a string when present.`,
        );
      }
    }

    if (artifact.covers != null) {
      if (
        !Array.isArray(artifact.covers) ||
        artifact.covers.some((cover) => !isNonEmptyString(cover))
      ) {
        addFinding(
          ctx,
          'error',
          'artifact_manifest.invalid_covers',
          `${path}.covers`,
          'covers must be an array of non-empty strings when present.',
        );
      }
    }

    if (artifact.record != null) {
      if (typeof artifact.record !== 'string') {
        addFinding(
          ctx,
          'error',
          'artifact_manifest.invalid_record',
          `${path}.record`,
          'record must be a string when present.',
        );
      } else if (artifact.record !== 'full_run') {
        addFinding(
          ctx,
          'error',
          'artifact_manifest.invalid_record',
          `${path}.record`,
          'record must be full_run when present; focused proof-window recording is reserved.',
        );
      }
    }

    if (
      artifact.maxFps != null &&
      (typeof artifact.maxFps !== 'number' ||
        !Number.isFinite(artifact.maxFps) ||
        artifact.maxFps <= 0)
    ) {
      addFinding(
        ctx,
        'error',
        'artifact_manifest.invalid_max_fps',
        `${path}.maxFps`,
        'maxFps must be a positive number when present.',
      );
    }

    if (artifact.recorder != null) {
      if (!isRecord(artifact.recorder)) {
        addFinding(
          ctx,
          'error',
          'artifact_manifest.invalid_recorder',
          `${path}.recorder`,
          'recorder must be an object when present.',
        );
      } else {
        for (const recorderField of ['name', 'version', 'platform']) {
          const value = artifact.recorder[recorderField];
          if (value != null && typeof value !== 'string') {
            addFinding(
              ctx,
              'error',
              'artifact_manifest.invalid_recorder_field',
              `${path}.recorder.${recorderField}`,
              `${recorderField} must be a string when present.`,
            );
          }
        }
        if (artifact.recorder.target != null) {
          if (!isRecord(artifact.recorder.target)) {
            addFinding(
              ctx,
              'error',
              'artifact_manifest.invalid_recorder_target',
              `${path}.recorder.target`,
              'recorder.target must be an object when present.',
            );
          } else {
            for (const targetField of ['selector', 'value']) {
              if (!isNonEmptyString(artifact.recorder.target[targetField])) {
                addFinding(
                  ctx,
                  'error',
                  'artifact_manifest.invalid_recorder_target_field',
                  `${path}.recorder.target.${targetField}`,
                  `recorder.target.${targetField} must be a non-empty string when present.`,
                );
              }
            }
          }
        }
      }
    }

    if (typeof artifact.nodeId === 'string' && nodeIds.size > 0 && !nodeIds.has(artifact.nodeId)) {
      addFinding(
        ctx,
        'warning',
        'artifact_manifest.unknown_node',
        `${path}.nodeId`,
        `Artifact references nodeId ${artifact.nodeId}, which is not present in the recipe graph.`,
      );
    }
  });

  return finishResult(ctx);
}

export function validateRecipeArtifactPackage(
  input: RecipeArtifactPackageInput,
): RecipeValidationResult {
  const ctx = createContext();
  const artifactPaths = new Set(input.artifactPaths ?? []);

  if (input.artifactPaths != null) {
    const requiredPaths = ['summary.json', 'trace.json'];
    if (input.manifest != null) requiredPaths.push('artifact-manifest.json');
    if (input.recipe != null) requiredPaths.push('recipe.json', 'recipe-resolution.json');
    for (const requiredPath of requiredPaths) {
      if (!artifactPaths.has(requiredPath)) {
        addFinding(
          ctx,
          'error',
          'artifact_package.missing_required_file',
          requiredPath,
          `Recipe artifact package must include ${requiredPath}.`,
        );
      }
    }
  }

  if (input.manifest == null) {
    addFinding(
      ctx,
      'error',
      'artifact_package.missing_manifest',
      'artifact-manifest.json',
      'Recipe artifact package must include artifact-manifest.json.',
    );
  } else {
    const manifestResult = validateArtifactManifestDocument(input.manifest, {
      recipe: input.recipe,
      artifactPaths: input.artifactPaths,
    });
    ctx.findings.push(...manifestResult.findings);
  }

  const resolution =
    input.recipe != null ? parseRecipeResolution(ctx, input.recipeResolution) : undefined;
  const resolvedRecipes = input.resolvedRecipes ?? {};
  const externalRecipeIds = new Set(resolution?.dependencies.map((entry) => entry.ref) ?? []);

  if (input.recipe != null) {
    const recipeResult = validateRecipeDocument(input.recipe, {
      externalRecipeIds,
    });
    ctx.findings.push(...recipeResult.findings);
  }

  const documents = new Map<string, unknown>();
  if (resolution && input.recipe != null) {
    const rootDigest = digestRecipeDocument(input.recipe);
    if (resolution.root.digest !== rootDigest) {
      addFinding(
        ctx,
        'error',
        'artifact_package.root_digest_mismatch',
        'recipe-resolution.json.root.digest',
        'Root recipe digest does not match recipe.json.',
      );
    }
    const expectedDigests = new Set(resolution.dependencies.map((entry) => entry.digest));
    for (const digest of Object.keys(resolvedRecipes)) {
      if (!expectedDigests.has(digest)) {
        addFinding(
          ctx,
          'error',
          'artifact_package.unexpected_resolved_recipe',
          `resolvedRecipes.${digest}`,
          'Resolved recipe documents must exactly match recipe-resolution.json dependencies.',
        );
      }
    }
    for (const dependency of resolution.dependencies) {
      const document = resolvedRecipes[dependency.digest];
      if (document == null) {
        addFinding(
          ctx,
          'error',
          'artifact_package.missing_resolved_recipe',
          dependency.artifact,
          `Missing resolved recipe document for ${dependency.ref}.`,
        );
        continue;
      }
      documents.set(dependency.ref, document);
      if (digestRecipeDocument(document) !== dependency.digest) {
        addFinding(
          ctx,
          'error',
          'artifact_package.resolved_recipe_digest_mismatch',
          dependency.artifact,
          `Resolved recipe ${dependency.ref} does not match its recorded digest.`,
        );
      }
      if (input.artifactPaths != null && !artifactPaths.has(dependency.artifact)) {
        addFinding(
          ctx,
          'error',
          'artifact_package.missing_resolved_recipe_file',
          dependency.artifact,
          `Recipe artifact package must include ${dependency.artifact}.`,
        );
      }
      const result = validateRecipeDocument(document, {
        externalRecipeIds,
      });
      ctx.findings.push(...result.findings);
    }
    validateResolutionEdges(ctx, input.recipe, resolution, documents);
  }

  if (input.recipe != null) {
    validateTraceConsistency(ctx, input.trace, input.recipe, documents, input.manifest);
  }

  return finishResult(ctx);
}

interface ExpectedTraceNode {
  action: string;
  intent?: string;
}

function validateTraceConsistency(
  ctx: ReturnType<typeof createContext>,
  trace: unknown,
  rootRecipe: unknown,
  documents: ReadonlyMap<string, unknown>,
  manifest: unknown,
): void {
  const entries = traceEntries(trace);
  if (!entries) {
    addFinding(
      ctx,
      'error',
      'artifact_package.invalid_trace',
      'trace.json',
      'trace.json must be an array or an object with entries[].',
    );
    return;
  }

  const expected = new Map<string, ExpectedTraceNode>();
  collectExpectedTraceNodes(rootRecipe, '', documents, expected, new Set());
  const manifestArtifacts =
    isRecord(manifest) && Array.isArray(manifest.artifacts)
      ? manifest.artifacts.filter(isRecord)
      : [];
  const manifestByPath = new Map(
    manifestArtifacts
      .filter((artifact) => isNonEmptyString(artifact.path))
      .map((artifact) => [String(artifact.path), artifact]),
  );
  const seen = new Set<string>();

  for (const [index, value] of entries.entries()) {
    const path = `trace.json${Array.isArray(trace) ? '' : '.entries'}[${index}]`;
    if (!isRecord(value)) {
      addFinding(
        ctx,
        'error',
        'artifact_package.invalid_trace_entry',
        path,
        'Trace entries must be objects.',
      );
      continue;
    }
    const nodeId = isNonEmptyString(value.nodeId)
      ? value.nodeId
      : isNonEmptyString(value.id)
        ? value.id
        : undefined;
    if (!nodeId) {
      addFinding(
        ctx,
        'error',
        'artifact_package.invalid_trace_node',
        path,
        'Trace entries require nodeId (or id in retained fixture traces).',
      );
      continue;
    }
    const expectedNode =
      expected.get(nodeId) ?? expectedLifecycleTraceNode(nodeId, value.action, expected);
    if (!expectedNode) {
      addFinding(
        ctx,
        'error',
        'artifact_package.unknown_trace_node',
        `${path}.${isNonEmptyString(value.nodeId) ? 'nodeId' : 'id'}`,
        `Trace node ${nodeId} is not present in the retained recipe graph.`,
      );
      continue;
    }
    if (seen.has(nodeId)) {
      addFinding(
        ctx,
        'error',
        'artifact_package.duplicate_trace_node',
        path,
        `Trace node ${nodeId} appears more than once.`,
      );
    }
    seen.add(nodeId);
    if (value.action !== expectedNode.action) {
      addFinding(
        ctx,
        'error',
        'artifact_package.trace_action_mismatch',
        `${path}.action`,
        `Trace action must match recipe node ${nodeId} (${expectedNode.action}).`,
      );
    }
    if (
      expectedNode.intent !== undefined &&
      (value.intent !== undefined || value.ok !== false) &&
      value.intent !== expectedNode.intent
    ) {
      addFinding(
        ctx,
        'error',
        'artifact_package.trace_intent_mismatch',
        `${path}.intent`,
        `Trace intent must match recipe node ${nodeId}.`,
      );
    }
    if (!Array.isArray(value.artifacts)) continue;
    for (const [artifactIndex, traceArtifact] of value.artifacts.entries()) {
      const artifactPath = isNonEmptyString(traceArtifact)
        ? traceArtifact
        : isRecord(traceArtifact) && isNonEmptyString(traceArtifact.path)
          ? traceArtifact.path
          : undefined;
      if (!artifactPath) {
        addFinding(
          ctx,
          'error',
          'artifact_package.invalid_trace_artifact',
          `${path}.artifacts[${artifactIndex}]`,
          'Trace artifacts must be relative paths or artifact objects with a path.',
        );
        continue;
      }
      const manifestArtifact = manifestByPath.get(artifactPath);
      if (!manifestArtifact) {
        addFinding(
          ctx,
          'error',
          'artifact_package.trace_artifact_missing_manifest',
          `${path}.artifacts[${artifactIndex}]`,
          `Trace artifact ${artifactPath} is missing from artifact-manifest.json.`,
        );
        continue;
      }
      if (isNonEmptyString(manifestArtifact.nodeId) && manifestArtifact.nodeId !== nodeId) {
        addFinding(
          ctx,
          'error',
          'artifact_package.trace_artifact_node_mismatch',
          `${path}.artifacts[${artifactIndex}]`,
          `Trace artifact ${artifactPath} is attributed to ${manifestArtifact.nodeId} in artifact-manifest.json, not ${nodeId}.`,
        );
      }
      if (
        isRecord(traceArtifact) &&
        isNonEmptyString(traceArtifact.nodeId) &&
        traceArtifact.nodeId !== nodeId
      ) {
        addFinding(
          ctx,
          'error',
          'artifact_package.trace_artifact_node_mismatch',
          `${path}.artifacts[${artifactIndex}].nodeId`,
          `Trace artifact ${artifactPath} must be attributed to trace node ${nodeId}.`,
        );
      }
    }
  }
}

function traceEntries(trace: unknown): unknown[] | undefined {
  if (Array.isArray(trace)) return trace;
  return isRecord(trace) && Array.isArray(trace.entries) ? trace.entries : undefined;
}

function expectedLifecycleTraceNode(
  nodeId: string,
  action: unknown,
  recipeNodes: ReadonlyMap<string, ExpectedTraceNode>,
): ExpectedTraceNode | undefined {
  if (nodeId === 'recipe-run:video' && action === 'record.video') {
    return { action: 'record.video' };
  }
  if (nodeId === 'recipe-complete:hud' && action === 'app.hud') {
    return { action: 'app.hud' };
  }
  const hudMatch = /^(.*):hud:(?:running|pass|fail)$/u.exec(nodeId);
  return hudMatch && recipeNodes.has(hudMatch[1]) && action === 'app.hud'
    ? { action: 'app.hud' }
    : undefined;
}

function collectExpectedTraceNodes(
  recipe: unknown,
  prefix: string,
  documents: ReadonlyMap<string, unknown>,
  expected: Map<string, ExpectedTraceNode>,
  stack: ReadonlySet<string>,
): void {
  for (const { nodeId, action, node } of getRecipeWorkflowActionEntries(recipe)) {
    const traceNodeId = `${prefix}${nodeId}`;
    expected.set(traceNodeId, {
      action,
      ...(isNonEmptyString(node.intent) ? { intent: node.intent } : {}),
    });
    if (action !== 'call' || !isNonEmptyString(node.ref)) continue;
    const ref = normalizeRecipeRef(node.ref);
    const dependency = documents.get(ref);
    if (!dependency || stack.has(ref)) continue;
    collectExpectedTraceNodes(
      dependency,
      `${traceNodeId}/`,
      documents,
      expected,
      new Set(stack).add(ref),
    );
  }
}

function parseRecipeResolution(
  ctx: ReturnType<typeof createContext>,
  value: unknown,
): RecipeResolutionDocument | undefined {
  if (!isRecord(value)) {
    addFinding(
      ctx,
      'error',
      'artifact_package.missing_recipe_resolution',
      'recipe-resolution.json',
      'Recipe artifact package must include recipe-resolution.json.',
    );
    return undefined;
  }
  if (value.schema_version !== 1 || !isRecord(value.root)) {
    addFinding(
      ctx,
      'error',
      'artifact_package.invalid_recipe_resolution',
      'recipe-resolution.json',
      'recipe-resolution.json must declare schema_version 1 and a root object.',
    );
    return undefined;
  }
  if (!isNonEmptyString(value.root.ref) || !isDigest(value.root.digest)) {
    addFinding(
      ctx,
      'error',
      'artifact_package.invalid_recipe_resolution_root',
      'recipe-resolution.json.root',
      'Recipe resolution root requires a non-empty ref and sha256 digest.',
    );
    return undefined;
  }
  if (!Array.isArray(value.dependencies) || !Array.isArray(value.edges)) {
    addFinding(
      ctx,
      'error',
      'artifact_package.invalid_recipe_resolution_graph',
      'recipe-resolution.json',
      'Recipe resolution requires dependencies and edges arrays.',
    );
    return undefined;
  }
  const dependencies: RecipeResolutionDocument['dependencies'] = [];
  const seenRefs = new Set<string>();
  for (const [index, entry] of value.dependencies.entries()) {
    if (
      !isRecord(entry) ||
      !isNonEmptyString(entry.ref) ||
      !isNonEmptyString(entry.source) ||
      !isNonEmptyString(entry.file) ||
      !isRelativeArtifactPath(entry.file) ||
      !isDigest(entry.digest) ||
      !isRelativeArtifactPath(String(entry.artifact ?? '')) ||
      (entry.adapter != null && !isNonEmptyString(entry.adapter))
    ) {
      addFinding(
        ctx,
        'error',
        'artifact_package.invalid_recipe_resolution_dependency',
        `recipe-resolution.json.dependencies[${index}]`,
        'Each dependency requires a unique ref, source, relative file, sha256 digest, digest-keyed artifact, and optional adapter.',
      );
      continue;
    }
    if (seenRefs.has(entry.ref)) {
      addFinding(
        ctx,
        'error',
        'artifact_package.duplicate_recipe_resolution_ref',
        `recipe-resolution.json.dependencies[${index}].ref`,
        `Recipe ${entry.ref} appears more than once in the resolution.`,
      );
      continue;
    }
    seenRefs.add(entry.ref);
    const expectedArtifact = resolvedRecipeArtifactPath(entry.digest)!;
    if (entry.artifact !== expectedArtifact) {
      addFinding(
        ctx,
        'error',
        'artifact_package.invalid_recipe_resolution_artifact',
        `recipe-resolution.json.dependencies[${index}].artifact`,
        `Resolved recipe artifact must be ${expectedArtifact}.`,
      );
    }
    dependencies.push({
      ref: entry.ref,
      source: entry.source,
      file: entry.file,
      digest: entry.digest,
      artifact: String(entry.artifact),
      ...(typeof entry.adapter === 'string' ? { adapter: entry.adapter } : {}),
    });
  }
  const edges: RecipeResolutionDocument['edges'] = [];
  for (const [index, entry] of value.edges.entries()) {
    if (!isRecord(entry) || !isNonEmptyString(entry.from) || !isNonEmptyString(entry.to)) {
      addFinding(
        ctx,
        'error',
        'artifact_package.invalid_recipe_resolution_edge',
        `recipe-resolution.json.edges[${index}]`,
        'Each recipe resolution edge requires non-empty from and to refs.',
      );
      continue;
    }
    edges.push({ from: entry.from, to: entry.to });
  }
  return {
    schema_version: 1,
    root: { ref: value.root.ref, digest: value.root.digest },
    dependencies,
    edges,
  };
}

function validateResolutionEdges(
  ctx: ReturnType<typeof createContext>,
  root: unknown,
  resolution: RecipeResolutionDocument,
  documents: ReadonlyMap<string, unknown>,
): void {
  const actual = [
    ...getRecipeCallRefs(root).map((to) => ({ from: resolution.root.ref, to })),
    ...[...documents.entries()].flatMap(([from, document]) =>
      getRecipeCallRefs(document).map((to) => ({ from, to })),
    ),
  ];
  const expectedKeys = resolution.edges.map(edgeKey).sort();
  const actualKeys = actual.map(edgeKey).sort();
  if (JSON.stringify(expectedKeys) !== JSON.stringify(actualKeys)) {
    addFinding(
      ctx,
      'error',
      'artifact_package.recipe_resolution_edge_mismatch',
      'recipe-resolution.json.edges',
      'Recipe resolution edges do not match the call refs in the retained recipe documents.',
    );
  }
  const dependencyRefs = new Set(resolution.dependencies.map((entry) => entry.ref));
  if (dependencyRefs.has(resolution.root.ref)) {
    addFinding(
      ctx,
      'error',
      'artifact_package.recipe_resolution_root_collision',
      'recipe-resolution.json.root.ref',
      'Root recipe ref must not also appear as a dependency.',
    );
  }
  for (const edge of resolution.edges) {
    if (edge.from !== resolution.root.ref && !dependencyRefs.has(edge.from)) {
      addFinding(
        ctx,
        'error',
        'artifact_package.invalid_recipe_resolution_source',
        'recipe-resolution.json.edges',
        `Recipe resolution edge starts from missing recipe ${edge.from}.`,
      );
    }
    if (!dependencyRefs.has(edge.to)) {
      addFinding(
        ctx,
        'error',
        'artifact_package.unresolved_recipe_resolution_edge',
        'recipe-resolution.json.edges',
        `Recipe resolution edge targets missing dependency ${edge.to}.`,
      );
    }
  }
  const reachable = new Set<string>();
  const visit = (ref: string, stack: Set<string>): void => {
    if (stack.has(ref)) {
      addFinding(
        ctx,
        'error',
        'artifact_package.recipe_resolution_cycle',
        'recipe-resolution.json.edges',
        `Recipe resolution contains a cycle through ${ref}.`,
      );
      return;
    }
    if (reachable.has(ref)) return;
    reachable.add(ref);
    const nextStack = new Set(stack).add(ref);
    for (const edge of resolution.edges) {
      if (edge.from === ref) visit(edge.to, nextStack);
    }
  };
  visit(resolution.root.ref, new Set());
  for (const ref of dependencyRefs) {
    if (!reachable.has(ref)) {
      addFinding(
        ctx,
        'error',
        'artifact_package.unreachable_recipe_resolution_dependency',
        'recipe-resolution.json.dependencies',
        `Resolved recipe ${ref} is not reachable from the root recipe.`,
      );
    }
  }
}

function edgeKey(edge: { from: string; to: string }): string {
  return `${edge.from}\0${edge.to}`;
}

function isDigest(value: unknown): value is string {
  return typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value);
}

export function mergeRecipeValidationResults(
  results: readonly RecipeValidationResult[],
): RecipeValidationResult {
  const ctx = createContext();
  for (const result of results) {
    ctx.findings.push(...result.findings);
  }
  return finishResult(ctx);
}
