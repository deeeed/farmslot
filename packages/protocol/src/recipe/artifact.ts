import {
  addFinding,
  ARTIFACT_TYPES,
  createContext,
  finishResult,
  isNonEmptyString,
  isRecord,
  isRelativeArtifactPath,
  type RecipeArtifactPackageInput,
  type RecipeValidationResult,
  TERMINAL_STATUSES,
} from './common.js';
import { getRecipeWorkflowNodeIds } from './workflow.js';

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

    if (artifact.record != null && typeof artifact.record !== 'string') {
      addFinding(
        ctx,
        'error',
        'artifact_manifest.invalid_record',
        `${path}.record`,
        'record must be a string when present.',
      );
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
    if (input.recipe != null) requiredPaths.push('recipe.json');
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

  return finishResult(ctx);
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
