import {
  digestRecipeDocument,
  isRecord,
  type RecipeArtifactManifestEntry,
  type RecipeClaimDeclaration,
  type RecipeResolutionDocument,
  type RecipeValidationFinding,
  type RecipeValidationResult,
  type RecordedEvidencePackageInput,
  validateAcceptanceStatusLedger,
  validateRecipeArtifactPackage,
  validateRecipeRecordingTimelineBinding,
} from '@farmslot/protocol';

import type { ProofDocument, ProofTraceEntry } from './assertions.js';
import { deriveRecipeClaims } from './claims.js';
import { planRecipeEvidence } from './plan.js';

/** Validate actual package identities before consumers derive a moment or publish evidence. */
export function validateRecordedEvidencePackage(
  input: RecordedEvidencePackageInput,
): RecipeValidationResult {
  const base = validateRecipeArtifactPackage(input);
  const findings: RecipeValidationFinding[] = [...base.findings];
  const issue = (path: string, message: string, severity: 'error' | 'warning' = 'error') =>
    findings.push({ severity, code: 'recorded_evidence.invalid', path, message });
  const indexed =
    isRecord(input.manifest) && Array.isArray(input.manifest.artifacts)
      ? input.manifest.artifacts.filter(isRecord)
      : [];
  const recipeRunId =
    isRecord(input.summary) && typeof input.summary.recipeRunId === 'string'
      ? input.summary.recipeRunId
      : undefined;
  if (input.claims) {
    if (!input.recipe)
      issue('recipe.json', 'The retained root recipe must be supplied for claim derivation.');
    if (!recipeRunId)
      issue('summary.json.recipeRunId', 'Recorded package has no retained execution identity.');
    if (input.recipeRunId && input.recipeRunId !== recipeRunId)
      issue('recipeRunId', 'Retained execution differs from the requested execution.');
    if (!isRecord(input.invocation) || input.invocation.recipeRunId !== recipeRunId)
      issue('recipe-invocation.json.recipeRunId', 'Invocation belongs to another execution.');
  } else if (
    indexed.some((artifact) => artifact.path === 'acceptance-status.json') ||
    recipeRunId
  ) {
    issue('acceptance-status.json', 'The retained claim package must be supplied for validation.');
  } else {
    issue(
      'acceptance-status.json',
      'Legacy package has no automatic claim identity; media remains explicitly untimed.',
      'warning',
    );
  }
  if (input.claims && validateAcceptanceStatusLedger(input.claims).length === 0) {
    if (input.claims.recipeRunId !== recipeRunId)
      issue('acceptance-status.json', 'Claims belong to another execution.');
    for (const claim of input.claims.criteria) {
      for (const moment of claim.moments) {
        const segment = input.claims.recording.segments.find(
          (entry) => entry.videoDigest === moment.videoDigest,
        );
        if (
          !segment ||
          input.artifactDigests[segment.videoPath]?.replace(/^sha256:/u, '') !==
            moment.videoDigest.slice(7)
        )
          issue(`claims.${claim.id}.moments`, 'Moment does not reference retained video bytes.');
        const timeline = segment?.timelinePath ? input.timelines[segment.timelinePath] : undefined;
        if (timeline && !timeline.markers.some((marker) => marker.traceIndex === moment.traceIndex))
          issue(`claims.${claim.id}.moments`, 'Moment does not reference a retained occurrence.');
      }
    }
    if (base.status === 'valid' && input.recipe && isRecord(input.manifest)) {
      try {
        const resolution = input.recipeResolution as RecipeResolutionDocument;
        const documents = new Map(
          resolution.dependencies.map((dependency) => [
            dependency.ref,
            input.resolvedRecipes![dependency.digest] as ProofDocument,
          ]),
        );
        const registered =
          isRecord(input.invocation) && Array.isArray(input.invocation.claims)
            ? (input.invocation.claims as RecipeClaimDeclaration[])
            : undefined;
        if (
          input.invocation &&
          (!isRecord(input.summary) ||
            input.summary.invocationDigest !== digestRecipeDocument(input.invocation))
        )
          issue(
            'recipe-invocation.json',
            'Claim registration does not match the retained execution inputs.',
          );
        const plan = planRecipeEvidence(input.recipe as ProofDocument, documents, registered);
        const trace = Array.isArray(input.trace)
          ? input.trace
          : isRecord(input.trace) && Array.isArray(input.trace.entries)
            ? input.trace.entries
            : [];
        const derived = deriveRecipeClaims({
          recipeRunId: recipeRunId ?? input.claims.recipeRunId,
          ...plan,
          trace: trace as ProofTraceEntry[],
          artifacts: input.manifest.artifacts as RecipeArtifactManifestEntry[],
          segments: input.claims.recording.segments,
          judgments: input.claims.judgments,
          timelines: new Map(
            Object.values(input.timelines).map((timeline) => [timeline.videoDigest, timeline]),
          ),
        });
        for (const actual of derived) {
          if (!input.claims.criteria.some((claim) => claim.id === actual.id))
            issue(`claims.${actual.id}`, 'Registered claim is missing from the stored ledger.');
        }
        for (const claim of input.claims.criteria) {
          const actual = derived.find((entry) => entry.id === claim.id);
          if (!actual || actual.verdict !== claim.verdict)
            issue(
              `claims.${claim.id}.verdict`,
              'Stored verdict does not match the executed expectations.',
            );
          if (
            actual &&
            (digestRecipeDocument(actual.assertionIndices) !==
              digestRecipeDocument(claim.assertionIndices) ||
              digestRecipeDocument(actual.moments) !== digestRecipeDocument(claim.moments))
          )
            issue(
              `claims.${claim.id}.moments`,
              'Stored assertion/moment references do not match execution.',
            );
        }
      } catch (error) {
        issue(
          'acceptance-status.json',
          `Cannot bind claim evidence: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  } else if (input.claims) {
    for (const message of validateAcceptanceStatusLedger(input.claims))
      issue('acceptance-status.json', message);
  }
  const artifacts =
    isRecord(input.manifest) && Array.isArray(input.manifest.artifacts)
      ? input.manifest.artifacts.filter(isRecord)
      : [];
  for (const artifact of artifacts) {
    if (artifact.type !== 'video' || typeof artifact.path !== 'string') continue;
    const actual = input.artifactDigests[artifact.path];
    if (!actual) {
      issue(artifact.path, 'Video bytes were not hashed by the package reader.');
      continue;
    }
    const digest = actual.startsWith('sha256:') ? actual : `sha256:${actual}`;
    if (
      typeof artifact.sha256 === 'string' &&
      artifact.sha256.replace(/^sha256:/u, '') !== digest.slice(7)
    )
      issue(artifact.path, 'Artifact index belongs to different video bytes.');
    if (typeof artifact.timelinePath !== 'string') {
      issue(
        artifact.path,
        'Recording moment is untimed: no measured timeline is retained.',
        'warning',
      );
      continue;
    }
    const timeline = input.timelines[artifact.timelinePath];
    if (!timeline) {
      issue(artifact.timelinePath, 'Declared recording timeline is missing.');
      continue;
    }
    findings.push(
      ...validateRecipeRecordingTimelineBinding(timeline, {
        videoPath: artifact.path,
        videoDigest: digest,
        trace: input.trace,
      }).findings,
    );
  }
  const errors = findings.filter((finding) => finding.severity === 'error').length;
  return {
    status: errors ? 'invalid' : 'valid',
    findings,
    summary: {
      errors,
      warnings: findings.filter((finding) => finding.severity === 'warning').length,
    },
  };
}
