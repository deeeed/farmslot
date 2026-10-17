import {
  digestRecipeDocument,
  isRecord,
  type RecipeConformanceLiveEvidence,
  type RecipeValidationResult,
} from '@farmslot/protocol';
import {
  readRecordedEvidencePackage,
  type RecordedEvidencePackageReadResult,
  validateRecordedEvidencePackage,
} from '@farmslot/recipe-runner';
import { readRecipeCliJsonFile, resolveRecipeCliPath } from '@farmslot/recipe-runner/cli/support';

import { runnerRevision } from './artifact-files.js';
import { validateRuntimeProof } from './runtime-proof.js';

export interface RecipeArtifactsValidateOptions {
  recipe?: string;
  requireRunnerProvenance?: boolean;
  liveProof?: Pick<
    RecipeConformanceLiveEvidence,
    'smokeTarget' | 'teardownTarget' | 'captureRequired' | 'hudRequired'
  >;
}

export interface ArtifactValidationCheck {
  id: string;
  status: 'pass' | 'fail';
  message: string;
}

export interface ArtifactValidationResult {
  status: 'pass' | 'fail';
  artifactDir: string;
  checks: ArtifactValidationCheck[];
  recipe: RecipeValidationResult;
  liveEvidence?: RecipeConformanceLiveEvidence;
  warnings?: string[];
}

const TERMINAL_RECIPE_STATUSES = new Set(['pass', 'fail', 'unknown']);

function addArtifactCheck(
  checks: ArtifactValidationCheck[],
  id: string,
  status: ArtifactValidationCheck['status'],
  message: string,
): void {
  checks.push({ id, status, message });
}

function hasSummaryRunnerProvenance(summary: unknown): boolean {
  return readRunnerProvenance(summary, 'runner') !== null;
}

function hasTraceRunnerProvenance(trace: unknown): boolean {
  return isRecord(trace) && readRunnerProvenance(trace.metadata, 'runner') !== null;
}

function hasManifestRunnerProvenance(manifest: unknown): boolean {
  return isRecord(manifest) && readRunnerProvenance(manifest.provenance, 'runner') !== null;
}

function readRunnerProvenance(parent: unknown, field: string): Record<string, unknown> | null {
  if (!isRecord(parent)) return null;
  const runner = parent[field];
  if (!isRecord(runner)) return null;
  const source = runner.source;
  const ref = runnerRevision(runner);
  if (typeof source !== 'string' || source.trim() === '') return null;
  if (typeof ref !== 'string' || ref.trim() === '') return null;
  return runner;
}

function canonicalRunnerIdentity(runner: Record<string, unknown>): string | null {
  const source = runner.source;
  const ref = runnerRevision(runner);
  if (typeof source !== 'string' || source.trim() === '') return null;
  if (typeof ref !== 'string' || ref.trim() === '') return null;
  return JSON.stringify({ source: source.trim(), ref: ref.trim() });
}

function runnerProvenanceMatches(summary: unknown, trace: unknown, manifest: unknown): boolean {
  const summaryRunner = readRunnerProvenance(summary, 'runner');
  const traceRunner = isRecord(trace) ? readRunnerProvenance(trace.metadata, 'runner') : null;
  const manifestRunner = isRecord(manifest)
    ? readRunnerProvenance(manifest.provenance, 'runner')
    : null;
  if (!summaryRunner || !traceRunner || !manifestRunner) return false;
  const canonical = canonicalRunnerIdentity(summaryRunner);
  return (
    canonical !== null &&
    canonicalRunnerIdentity(traceRunner) === canonical &&
    canonicalRunnerIdentity(manifestRunner) === canonical
  );
}

export async function validateRecipeArtifactDirectory(
  artifactDirInput: string,
  opts: RecipeArtifactsValidateOptions,
): Promise<ArtifactValidationResult> {
  const artifactDir = resolveRecipeCliPath(artifactDirInput);
  return validateRecipeArtifactRead(
    artifactDir,
    opts,
    await readRecordedEvidencePackage(artifactDir),
  );
}

export async function validateRecipeArtifactRead(
  artifactDir: string,
  opts: RecipeArtifactsValidateOptions,
  loaded: RecordedEvidencePackageReadResult,
): Promise<ArtifactValidationResult> {
  const checks: ArtifactValidationCheck[] = loaded.checks;
  const retained = loaded.input;
  const { summary, trace, manifest, artifactDigests } = retained;
  const artifactPaths = retained.artifactPaths ?? [];
  // --recipe cross-checks the retained root; it cannot replace a recorded package's root.
  const recipe = opts.recipe ? await readRecipeCliJsonFile(opts.recipe) : retained.recipe;
  const bundle = { ...retained, recipe };
  if (opts.recipe && retained.recipe !== undefined) {
    addArtifactCheck(
      checks,
      'recipe.matches_retained',
      digestRecipeDocument(recipe) === digestRecipeDocument(retained.recipe) ? 'pass' : 'fail',
      'The supplied recipe must match the retained root recipe.',
    );
  }
  const recorded =
    (isRecord(summary) && typeof summary.recipeRunId === 'string') ||
    artifactPaths.includes('acceptance-status.json');
  const recipeValidation = validateRecordedEvidencePackage({
    ...bundle,
    recipe: recorded ? retained.recipe : recipe,
  });
  let captures: string[] = [];
  const warnings: string[] = [];
  if (opts.liveProof) {
    try {
      captures = validateRuntimeProof(
        bundle,
        opts.liveProof.smokeTarget,
        opts.liveProof.teardownTarget,
        { ...opts.liveProof, hudRequired: false },
      );
      addArtifactCheck(
        checks,
        'runtime.proof',
        'pass',
        'Runtime effect and authored teardown assertions passed.',
      );
      if (opts.liveProof.hudRequired) {
        // The same immutable bundle already passed state, capture and cleanup checks.
        // HUD observations are advisory; their absence cannot invalidate that proof.
        try {
          validateRuntimeProof(
            bundle,
            opts.liveProof.smokeTarget,
            opts.liveProof.teardownTarget,
            opts.liveProof,
          );
        } catch (error) {
          warnings.push(error instanceof Error ? error.message : String(error));
        }
      }
    } catch (error) {
      addArtifactCheck(
        checks,
        'runtime.proof',
        'fail',
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  const summaryStatus = isRecord(summary) ? summary.status : undefined;
  addArtifactCheck(
    checks,
    'summary.status',
    typeof summaryStatus === 'string' && TERMINAL_RECIPE_STATUSES.has(summaryStatus)
      ? 'pass'
      : 'fail',
    'summary.json must include terminal status pass, fail, or unknown.',
  );

  addArtifactCheck(
    checks,
    'trace.shape',
    Array.isArray(trace) || (isRecord(trace) && Array.isArray(trace.entries)) ? 'pass' : 'fail',
    'trace.json must be an array or an object with entries[].',
  );
  const manifestStatus = isRecord(manifest) ? manifest.runStatus : undefined;
  addArtifactCheck(
    checks,
    'manifest.status_matches_summary',
    typeof summaryStatus === 'string' && manifestStatus === summaryStatus ? 'pass' : 'fail',
    'artifact-manifest.json runStatus must match summary.json status.',
  );

  if (opts.requireRunnerProvenance) {
    addArtifactCheck(
      checks,
      'runner.provenance.summary',
      hasSummaryRunnerProvenance(summary) ? 'pass' : 'fail',
      'summary.json must include runner provenance at summary.runner.',
    );
    addArtifactCheck(
      checks,
      'runner.provenance.trace',
      hasTraceRunnerProvenance(trace) ? 'pass' : 'fail',
      'trace.json must include runner provenance at trace.metadata.runner.',
    );
    addArtifactCheck(
      checks,
      'runner.provenance.manifest',
      hasManifestRunnerProvenance(manifest) ? 'pass' : 'fail',
      'artifact-manifest.json must include runner provenance at provenance.runner.',
    );
    addArtifactCheck(
      checks,
      'runner.provenance.matches',
      runnerProvenanceMatches(summary, trace, manifest) ? 'pass' : 'fail',
      'Runner provenance must identify the same source/ref in summary, trace metadata, and artifact manifest.',
    );
  }

  const status =
    checks.some((check) => check.status === 'fail') || recipeValidation.status === 'invalid'
      ? 'fail'
      : 'pass';
  const liveEvidence =
    status === 'pass' && opts.liveProof
      ? {
          ...opts.liveProof,
          hudRequired: false,
          ...(opts.liveProof.captureRequired || opts.liveProof.hudRequired ? { captures } : {}),
          artifactDir,
          artifacts: await Promise.all(
            [...artifactPaths].sort().map(async (file) => ({
              path: file,
              digest: artifactDigests[file]!,
            })),
          ),
        }
      : undefined;
  return {
    status,
    artifactDir,
    checks,
    recipe: recipeValidation,
    ...(liveEvidence ? { liveEvidence } : {}),
    ...(warnings.length ? { warnings } : {}),
  };
}
