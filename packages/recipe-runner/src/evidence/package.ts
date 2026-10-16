import {
  digestRecipeDocument,
  isRecord,
  normalizeRecipeClaimId,
  type QualifiedRecipeVisualJudgment,
  type RecipeArtifactManifestEntry,
  type RecipeClaimDeclaration,
  type RecipeClaimEvidence,
  type RecipeRepairScope,
  recipeRepairScopeDigest,
  type RecipeRepairSelection,
  type RecipeResolutionDocument,
  recipeTraceEntries,
  type RecipeValidationFinding,
  type RecipeValidationResult,
  type RecipeVisualJudgment,
  type RecipeVisualReviewAuthority,
  recordedEvidenceClosureIdentity,
  type RecordedEvidencePackageInput,
  recordedVisualJudgments,
  type ReviewDiffSnapshot,
  validateAcceptanceStatusLedger,
  validateRecipeArtifactPackage,
  validateRecipeRecordingTimelineBinding,
  validateRecipeRepairScope,
  validateRecipeRepairSelection,
} from '@farmslot/protocol';

import type { ProofDocument, ProofTraceEntry } from './assertions.js';
import { groupRecipeCaptureComparisons } from './capture-comparisons.js';
import { deriveRecipeClaims } from './claims.js';
import { indexRecordingTimelines } from './moments.js';
import { planRecipeEvidence } from './plan.js';

/** The same engine derivation serves stored validation and authenticated review. */
function deriveClaimsFromInput(
  input: RecordedEvidencePackageInput,
  judgments: readonly RecipeVisualJudgment[] = [],
  qualifiedJudgments: readonly QualifiedRecipeVisualJudgment[] = [],
): RecipeClaimEvidence[] {
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
  const plan = planRecipeEvidence(input.recipe as ProofDocument, documents, registered);
  const trace = Array.isArray(input.trace)
    ? input.trace
    : isRecord(input.trace) && Array.isArray(input.trace.entries)
      ? input.trace.entries
      : [];
  return deriveRecipeClaims(
    {
      recipeRunId: input.claims!.recipeRunId,
      ...plan,
      trace: trace as ProofTraceEntry[],
      artifacts: (isRecord(input.manifest)
        ? input.manifest.artifacts
        : []) as RecipeArtifactManifestEntry[],
      segments: input.claims!.recording.segments,
      judgments,
      timelines: indexRecordingTimelines(Object.values(input.timelines)),
    },
    qualifiedJudgments,
  );
}

/** A claim's engine-selected recorded source; fresh claims come from the package itself. */
export interface RecordedClaimSource {
  claimId: string;
  input: RecordedEvidencePackageInput;
  /** Root of a retained original inside the fresh package; absent for fresh proof. */
  artifactRoot?: string;
}

interface CheckedRepair {
  scope: RecipeRepairScope;
  selection: RecipeRepairSelection;
}

/** Callers validate the package first; the selection then names one source per claim. */
export function recordedClaimSources(input: RecordedEvidencePackageInput): RecordedClaimSource[] {
  if (!input.repair)
    return (input.claims?.criteria ?? []).map((claim) => ({ claimId: claim.id, input }));
  const { selection } = input.repair as CheckedRepair;
  return selection.claims.map((row) => {
    if (row.source === 'fresh') return { claimId: row.claimId, input };
    const dependency = input.comparisonDependencies!.find(
      (entry) => entry.input.claims?.recipeRunId === row.recipeRunId,
    )!;
    return { claimId: row.claimId, input: dependency.input, artifactRoot: dependency.artifactRoot };
  });
}

/** Retained media stays in its original package; display paths resolve from the fresh root. */
function selectedRow(row: RecipeClaimEvidence, artifactRoot?: string): RecipeClaimEvidence {
  return artifactRoot
    ? { ...row, evidence: row.evidence.map((file) => `${artifactRoot}/${file}`) }
    : row;
}

/** Engine-selected raw claim rows; a repair never fabricates a combined execution. */
export function selectedRecipeClaims(input: RecordedEvidencePackageInput): RecipeClaimEvidence[] {
  if (!input.repair) return input.claims?.criteria ?? [];
  return recordedClaimSources(input).map((source) =>
    selectedRow(
      source.input.claims!.criteria.find(({ id }) => id === source.claimId)!,
      source.artifactRoot,
    ),
  );
}

/** Current human review is a projection; original package bytes and facts remain intact. */
export function deriveReviewedRecipeClaims(
  input: RecordedEvidencePackageInput,
  authority?: RecipeVisualReviewAuthority,
): RecipeClaimEvidence[] {
  const validation = validateRecordedEvidencePackage(input);
  if (validation.status !== 'valid' || !input.claims)
    throw new TypeError('Visual review requires a valid retained engine claim package.');
  const reviewed = new Map<RecordedEvidencePackageInput, RecipeClaimEvidence[]>();
  const rows = (source: RecordedEvidencePackageInput) => {
    let derived = reviewed.get(source);
    if (!derived) {
      // Each source keeps the receipts qualified for its own execution and closure.
      const scoped = authority && {
        ...authority,
        recipeRunId: source.claims!.recipeRunId,
        closureIdentity: recordedEvidenceClosureIdentity(source),
      };
      derived = deriveClaimsFromInput(
        source,
        [],
        scoped ? recordedVisualJudgments(source, scoped) : [],
      );
      reviewed.set(source, derived);
    }
    return derived;
  };
  if (!input.repair) return rows(input);
  return recordedClaimSources(input).map((source) =>
    selectedRow(rows(source.input).find(({ id }) => id === source.claimId)!, source.artifactRoot),
  );
}

/** A retained source supplies only its own fresh claims, with the registered text. */
function repairFindings(
  input: RecordedEvidencePackageInput,
  references: readonly unknown[],
): Array<[string, string]> {
  const findings: Array<[string, string]> = [];
  const invocationRepair = isRecord(input.invocation) ? input.invocation.repair : undefined;
  if (!input.repair)
    return [['repair-selection.json', 'Repair execution has no retained selection.']];
  const scopeCheck = validateRecipeRepairScope(input.repair.scope);
  if (scopeCheck.status !== 'valid')
    return scopeCheck.findings.map((finding) => [
      `repair-scope.json.${finding.path}`,
      finding.message,
    ]);
  const scope = input.repair.scope as RecipeRepairScope;
  if (
    !isRecord(invocationRepair) ||
    invocationRepair.repairId !== scope.repairId ||
    invocationRepair.scopeDigest !== recipeRepairScopeDigest(scope)
  )
    findings.push(['recipe-invocation.json.repair', 'Execution does not bind this repair scope.']);
  if (
    !isRecord(input.invocation) ||
    digestRecipeDocument(input.invocation.claims) !== digestRecipeDocument(scope.claims)
  )
    findings.push(['recipe-invocation.json.claims', 'Repair changed the task registration.']);
  if (isRecord(input.summary) && input.summary.stopAfterNode !== undefined)
    findings.push(['summary.json.stopAfterNode', 'A repair must run its complete graph.']);
  if (!input.claims) return findings;
  const selectionCheck = validateRecipeRepairSelection(input.repair.selection, scope, {
    recipeRunId: input.claims.recipeRunId,
    criteria: input.claims.criteria,
  });
  findings.push(
    ...selectionCheck.findings.map((finding): [string, string] => [
      `repair-selection.json.${finding.path}`,
      finding.message,
    ]),
  );
  for (const source of scope.sources) {
    if (
      !references.some(
        (ref) =>
          isRecord(ref) &&
          ref.recipeRunId === source.recipeRunId &&
          ref.closureIdentity === source.closureIdentity,
      )
    )
      findings.push([
        `repair-scope.json.sources.${source.recipeRunId}`,
        'A retained source is not an engine-retained closure.',
      ]);
  }
  if (selectionCheck.status !== 'valid') return findings;
  for (const row of (input.repair.selection as RecipeRepairSelection).claims) {
    if (row.source !== 'retained') continue;
    const dependency = input.comparisonDependencies?.find(
      (entry) => entry.input.claims?.recipeRunId === row.recipeRunId,
    )?.input;
    const claim = dependency?.claims?.criteria.find(({ id }) => id === row.claimId);
    const registered = scope.claims.find(({ id }) => normalizeRecipeClaimId(id) === row.claimId);
    const nested = dependency?.repair?.selection;
    const ownSelection =
      isRecord(nested) && Array.isArray(nested.claims)
        ? nested.claims.find((entry) => isRecord(entry) && entry.claimId === row.claimId)
        : undefined;
    if (
      !dependency ||
      !claim ||
      claim.text !== registered?.claim ||
      (dependency.repair && (!isRecord(ownSelection) || ownSelection.source !== 'fresh'))
    )
      findings.push([
        `repair-selection.json.claims.${row.claimId}`,
        "Retained proof must be its source execution's own claim with the registered text.",
      ]);
  }
  return findings;
}

/** Validate actual package identities before consumers derive a moment or publish evidence. */
export function validateRecordedEvidencePackage(
  input: RecordedEvidencePackageInput,
  snapshot?: Pick<ReviewDiffSnapshot, 'baseSha' | 'headSha'>,
): RecipeValidationResult {
  return validatePackage(input, new Set(), snapshot);
}

function validatePackage(
  input: RecordedEvidencePackageInput,
  ancestors: ReadonlySet<string>,
  snapshot?: Pick<ReviewDiffSnapshot, 'baseSha' | 'headSha'>,
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
  const trace = recipeTraceEntries(input.trace) ?? [];
  for (const artifact of indexed) {
    if (artifact.capture === undefined) continue;
    const capture = artifact.capture;
    const occurrence =
      isRecord(capture) && Number.isInteger(capture.traceIndex)
        ? trace[Number(capture.traceIndex)]
        : undefined;
    if (
      !isRecord(capture) ||
      capture.recipeRunId !== recipeRunId ||
      !isRecord(occurrence) ||
      occurrence.nodeId !== capture.nodeId ||
      (capture.ac !== undefined &&
        (typeof capture.ac !== 'string' ||
          !input.claims?.criteria.some((claim) => claim.id === capture.ac))) ||
      (capture.role !== undefined &&
        !['before', 'after', 'review'].includes(String(capture.role))) ||
      (capture.sourceCommit !== undefined &&
        (typeof capture.sourceCommit !== 'string' ||
          !/^[a-f0-9]{40,64}$/u.test(capture.sourceCommit))) ||
      (capture.sourceDirty !== undefined && typeof capture.sourceDirty !== 'boolean')
    )
      issue(
        `artifacts.${String(artifact.path)}.capture`,
        'Capture binding does not match the retained claim, source or occurrence.',
      );
  }
  const dependencies =
    isRecord(input.manifest) && Array.isArray(input.manifest.comparisonDependencies)
      ? input.manifest.comparisonDependencies
      : [];
  if (
    isRecord(input.invocation) &&
    JSON.stringify(input.invocation.comparisonDependencies ?? []) !== JSON.stringify(dependencies)
  )
    issue('comparisonDependencies', 'Comparison dependencies differ from the retained invocation.');
  if (
    input.comparisonDependencies?.length !== dependencies.length &&
    dependencies.length + (input.comparisonDependencies?.length ?? 0) > 0
  )
    issue('comparisonDependencies', 'Every declared comparison closure must be supplied.');
  const nextAncestors = new Set([...ancestors, recipeRunId ?? '']);
  const seenRoots = new Set<string>();
  for (const ref of dependencies) {
    if (
      !isRecord(ref) ||
      typeof ref.recipeRunId !== 'string' ||
      !/^[A-Za-z0-9._-]+$/u.test(ref.recipeRunId) ||
      ['.', '..'].includes(ref.recipeRunId) ||
      ref.artifactRoot !== `comparison-dependencies/${ref.recipeRunId}` ||
      nextAncestors.has(ref.recipeRunId) ||
      ancestors.size >= 16 ||
      seenRoots.has(String(ref.artifactRoot))
    ) {
      issue('comparisonDependencies', 'Invalid, duplicate or cyclic comparison dependency.');
      continue;
    }
    seenRoots.add(String(ref.artifactRoot));
    const child = input.comparisonDependencies?.find(
      (entry) => entry.artifactRoot === ref.artifactRoot,
    )?.input;
    if (!child) {
      issue('comparisonDependencies', 'A retained comparison package is missing.');
      continue;
    }
    try {
      if (
        child.claims?.recipeRunId !== ref.recipeRunId ||
        recordedEvidenceClosureIdentity(child) !== ref.closureIdentity
      )
        issue(String(ref.artifactRoot), 'Comparison dependency has changed execution or bytes.');
    } catch (error) {
      issue(String(ref.artifactRoot), error instanceof Error ? error.message : String(error));
    }
    const validation = validatePackage(child, nextAncestors, snapshot);
    findings.push(
      ...validation.findings.map((finding) => ({
        ...finding,
        path: `${String(ref.artifactRoot)}/${finding.path}`,
      })),
    );
    for (const claim of child.claims?.criteria ?? []) {
      const current = input.claims?.criteria.find((entry) => entry.id === claim.id);
      if (current && current.text !== claim.text)
        issue(
          String(ref.artifactRoot),
          `Comparison claim ${claim.id} differs from the selected claim text.`,
        );
    }
  }
  if (input.repair || (isRecord(input.invocation) && input.invocation.repair !== undefined))
    for (const [path, message] of repairFindings(input, dependencies)) issue(path, message);
  if (input.claims?.schemaVersion === 2) {
    const captures = groupRecipeCaptureComparisons(input, input.claims.criteria, snapshot);
    for (const media of captures.media) {
      if (
        media.root &&
        media.capture?.ac &&
        !input.claims.criteria.some((claim) => claim.id === media.capture?.ac)
      )
        issue(media.path, 'Comparison capture names a claim outside the selected registration.');
      if (snapshot && media.reasonCode === 'comparison-source-mismatch')
        findings.push({
          severity: 'error',
          code: 'comparison-source-mismatch',
          path: media.path,
          message: media.reason!,
        });
    }
  }
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
  if (input.claims && input.claims.schemaVersion !== 2) {
    issue(
      'acceptance-status.json.schemaVersion',
      'Recipe claim packages require schema 2; a task acceptance ledger is not a recipe claim package.',
    );
  } else if (input.claims && validateAcceptanceStatusLedger(input.claims).length === 0) {
    if (input.claims.recipeRunId !== recipeRunId)
      issue('acceptance-status.json', 'Claims belong to another execution.');
    for (const claim of input.claims.criteria) {
      for (const moment of claim.moments) {
        const matching = input.claims.recording.segments.filter(
          (entry) => entry.videoDigest === moment.videoDigest,
        );
        if (
          !matching.some(
            (segment) =>
              input.artifactDigests[segment.videoPath]?.replace(/^sha256:/u, '') ===
              moment.videoDigest.slice(7),
          )
        )
          issue(`claims.${claim.id}.moments`, 'Moment does not reference retained video bytes.');
        if (
          !matching.some((segment) => {
            const timeline = segment.timelinePath
              ? input.timelines[segment.timelinePath]
              : undefined;
            return (
              !timeline ||
              timeline.markers.some((marker) => marker.traceIndex === moment.traceIndex)
            );
          })
        )
          issue(`claims.${claim.id}.moments`, 'Moment does not reference a retained occurrence.');
      }
    }
    if (base.status === 'valid' && input.recipe && isRecord(input.manifest)) {
      try {
        if (
          input.invocation &&
          (!isRecord(input.summary) ||
            input.summary.invocationDigest !== digestRecipeDocument(input.invocation))
        )
          issue(
            'recipe-invocation.json',
            'Claim registration does not match the retained execution inputs.',
          );
        const derived = deriveClaimsFromInput(input, input.claims.judgments);
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
