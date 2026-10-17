import {
  isRecipeRepairScope,
  isRecord,
  type RecipeClaimDeclaration,
  type RecipeEvidenceCaptureBinding,
  type RecordedEvidencePackageInput,
  type ReviewDiffSnapshot,
} from '@farmslot/protocol';

export interface RecipeComparisonCapture {
  path: string;
  originalPath: string;
  root: string;
  label: string;
  type: 'screenshot' | 'video';
  capture?: RecipeEvidenceCaptureBinding;
  source: RecordedEvidencePackageInput;
  eligible: boolean;
  reasonCode?: 'comparison-source-unavailable' | 'comparison-source-mismatch';
  reason?: string;
}
export interface RecipeComparisonCaptureRow {
  id: string;
  before: RecipeComparisonCapture[];
  after: RecipeComparisonCapture[];
  review: RecipeComparisonCapture[];
}

/** Shared binding/source grouping for the sole writer and both review clients. */
export function groupRecipeCaptureComparisons(
  input: RecordedEvidencePackageInput,
  claims: readonly Pick<RecipeClaimDeclaration, 'id'>[],
  snapshot?: Pick<ReviewDiffSnapshot, 'baseSha' | 'headSha'>,
) {
  const rows = claims.map(
    (claim): RecipeComparisonCaptureRow => ({ id: claim.id, before: [], after: [], review: [] }),
  );
  const byId = new Map(rows.map((row) => [row.id, row]));
  const unassigned: RecipeComparisonCapture[] = [];
  const media: RecipeComparisonCapture[] = [];
  const visit = (
    source: RecordedEvidencePackageInput,
    root: string,
    depth: number,
    revision = snapshot,
    claimIds?: ReadonlySet<string>,
  ) => {
    if (depth > 16) return; // Canonical validation refuses deeper or cyclic declarations.
    const entries =
      isRecord(source.manifest) && Array.isArray(source.manifest.artifacts)
        ? source.manifest.artifacts
        : [];
    for (const entry of entries) {
      if (
        !isRecord(entry) ||
        typeof entry.path !== 'string' ||
        (entry.type !== 'screenshot' && entry.type !== 'video')
      )
        continue;
      const capture = readCaptureBinding(entry.capture);
      const mediaEntry: RecipeComparisonCapture = {
        path: `${root}${entry.path}`,
        originalPath: entry.path,
        root,
        label: typeof entry.label === 'string' ? entry.label : entry.path,
        type: entry.type,
        capture,
        source,
        eligible: false,
      };
      const row =
        capture?.ac && (!claimIds || claimIds.has(capture.ac)) ? byId.get(capture.ac) : undefined;
      if (capture?.role && row) {
        const expected = capture.role === 'before' ? revision?.baseSha : revision?.headSha;
        if (capture.role === 'review') mediaEntry.eligible = true;
        else if (
          capture.sourceDirty ||
          (capture.sourceCommit && expected && capture.sourceCommit !== expected)
        ) {
          mediaEntry.reasonCode = 'comparison-source-mismatch';
          mediaEntry.reason = capture.sourceDirty
            ? 'Capture source has tracked changes'
            : 'Capture source differs from the frozen review revision';
        } else if (!capture.sourceCommit || capture.sourceDirty !== false || !expected) {
          mediaEntry.reasonCode = 'comparison-source-unavailable';
          mediaEntry.reason = !expected
            ? 'Frozen review revision unavailable'
            : 'Unknown capture source';
        } else mediaEntry.eligible = true;
        row[capture.role].push(mediaEntry);
      } else unassigned.push(mediaEntry);
      media.push(mediaEntry);
    }
    // Each repair, however nested, binds its retained originals to the head they were recorded
    // at and to the claims it kept from them; an outer repair narrows that set further.
    const retained = retainedRepairSources(source);
    for (const child of source.comparisonDependencies ?? []) {
      const original = retained.get(child.input.claims?.recipeRunId ?? '');
      const kept =
        original && claimIds
          ? new Set([...original.claimIds].filter((id) => claimIds.has(id)))
          : (original?.claimIds ?? claimIds);
      visit(
        child.input,
        `${root}${child.artifactRoot}/`,
        depth + 1,
        original ? revision && { baseSha: revision.baseSha, headSha: original.headSha } : revision,
        kept,
      );
    }
  };
  visit(input, '', 0);
  return { rows, unassigned, media };
}

function readCaptureBinding(value: unknown): RecipeEvidenceCaptureBinding | undefined {
  if (
    !isRecord(value) ||
    typeof value.recipeRunId !== 'string' ||
    typeof value.nodeId !== 'string' ||
    typeof value.traceIndex !== 'number'
  )
    return undefined;
  return {
    recipeRunId: value.recipeRunId,
    nodeId: value.nodeId,
    traceIndex: value.traceIndex,
    ...(typeof value.ac === 'string' ? { ac: value.ac } : {}),
    ...(value.role === 'before' || value.role === 'after' || value.role === 'review'
      ? { role: value.role }
      : {}),
    ...(typeof value.sourceCommit === 'string' ? { sourceCommit: value.sourceCommit } : {}),
    ...(typeof value.sourceDirty === 'boolean' ? { sourceDirty: value.sourceDirty } : {}),
  };
}

/** Retained sources of a repair package, by execution; malformed repairs retain nothing. */
function retainedRepairSources(input: RecordedEvidencePackageInput) {
  const sources = new Map<string, { headSha: string; claimIds: Set<string> }>();
  const scope = input.repair?.scope;
  const selection = input.repair?.selection;
  if (!isRecipeRepairScope(scope) || !isRecord(selection) || !Array.isArray(selection.claims))
    return sources;
  for (const source of scope.sources) {
    const claimIds = new Set<string>();
    for (const row of selection.claims)
      if (
        isRecord(row) &&
        row.source === 'retained' &&
        row.recipeRunId === source.recipeRunId &&
        typeof row.claimId === 'string'
      )
        claimIds.add(row.claimId);
    sources.set(source.recipeRunId, { headSha: source.headSha, claimIds });
  }
  return sources;
}
