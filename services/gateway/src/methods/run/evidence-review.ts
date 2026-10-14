import { existsSync } from 'node:fs';
import path from 'node:path';

import { readRecordedEvidencePackage } from '@farmslot/adapter-sdk';
import { validateRecordedEvidencePackage } from '@farmslot/adapter-sdk/evidence';
import {
  type RecipeRunArtifactGroup,
  type RecordedEvidencePackageInput,
  RecordedEvidenceReadError,
  type Run,
  type RunRecordedEvidenceReview,
  TERMINAL_RUN_STATUSES,
} from '@farmslot/protocol';

import { loadSlotVars } from '../../core/config.js';
import { getNode } from '../../fleet/machine-registry.js';
import { getSlotLocality, sendNodeRequest } from '../../fleet/node-rpc.js';
import { scanSlotArtifactRootDetailed } from '../../live-recipe/context.js';
import { claimOverrideAuthority } from '../../run-engine/claim-overrides.js';
import { readVisualReviewPolicy, visualReviewAuthority } from '../../run-engine/claim-reviews.js';
import {
  readFrozenRecordedEvidenceSources,
  readGateRecordedEvidenceSources,
  readVisualReviewSource,
  recordedEvidenceInventoryMismatch,
  visualReviewSnapshotIdentity,
} from '../../run-engine/recorded-evidence-sources.js';
import {
  resolveRemoteRecipeArtifactRoot,
  shouldServeRecipeArtifactFromLocalCache,
} from '../filesystem.js';

/** A display snapshot, never publication/approval authority. Read the same source as its media route. */
export async function readRunRecordedEvidence(
  run: Run,
  group: RecipeRunArtifactGroup | undefined,
  frozen?: { decisionId: string; packageHash?: string },
  recordedRecipeRunId?: string,
): Promise<RunRecordedEvidenceReview> {
  const artifactPrefix = 'artifacts/';
  const contractVersion = run.recordedEvidenceContractVersion ?? 0;
  const rootParts = group?.artifactRoot?.split(path.sep) ?? [];
  const artifactsIndex = rootParts.lastIndexOf('artifacts');
  const packagePath =
    artifactsIndex >= 0 ? rootParts.slice(artifactsIndex + 1).join('/') || '.' : undefined;
  if (contractVersion !== 0 && contractVersion !== 1)
    return {
      artifactPrefix,
      packagePath,
      contractVersion,
      failureCode: 'evidence-contract-unsupported',
      errors: ['The recorded run evidence contract is unsupported.'],
    };
  if (!frozen && !recordedRecipeRunId && !group?.artifactRoot)
    return contractVersion === 1 && TERMINAL_RUN_STATUSES.includes(run.status)
      ? {
          artifactPrefix,
          contractVersion,
          failureCode: 'evidence-selection-missing',
          errors: ['No retained recipe execution is available. Re-run the recipe.'],
        }
      : { artifactPrefix, contractVersion, errors: [] };
  try {
    if (frozen || recordedRecipeRunId) {
      const captured = recordedRecipeRunId
        ? await readVisualReviewSource(run, frozen?.decisionId)
        : undefined;
      const decisionId = frozen?.decisionId ?? captured?.decisionId;
      const decision = run.decisions.find(({ id }) => id === decisionId);
      const payload = decision?.payload;
      let sources;
      if (payload?.kind === 'ready' && payload.prPackage) {
        if (frozen && (!frozen.packageHash || payload.prPackage.packageHash !== frozen.packageHash))
          throw new Error('The displayed gate package changed. Refresh the decision.');
        sources =
          captured?.sources ?? (await readGateRecordedEvidenceSources(run, payload.prPackage));
      } else if (run.output && (payload?.kind === 'output-review' || (captured && !frozen))) {
        if (
          (payload?.kind === 'output-review' &&
            (run.output.manifestDigest !== payload.manifestDigest ||
              run.output.reportPath !== payload.reportPath)) ||
          (frozen && frozen.packageHash !== run.output.manifestDigest)
        )
          throw new Error('The displayed QA output snapshot changed. Refresh the decision.');
        sources =
          captured?.sources ??
          (await readFrozenRecordedEvidenceSources(run, run.output.artifactManifest));
      } else throw new Error('The gate has no frozen recipe evidence package.');
      const retainedRunId =
        recordedRecipeRunId ??
        (payload?.kind === 'ready' && payload.acceptanceStatus?.schemaVersion === 2
          ? payload.acceptanceStatus.recipeRunId
          : group?.recipeRunId);
      const prefix =
        group?.artifactRoot && run.taskFile
          ? `${path.relative(path.dirname(run.taskFile), group.artifactRoot).split(path.sep).join('/')}/`
          : undefined;
      const source =
        (payload?.kind === 'ready' &&
        sources.length === 1 &&
        (!retainedRunId || sources[0]?.input.claims?.recipeRunId === retainedRunId)
          ? sources[0]
          : undefined) ??
        sources.find(({ input, artifactPrefix }) =>
          recordedRecipeRunId ||
          (payload?.kind === 'ready' && payload.acceptanceStatus?.schemaVersion === 2)
            ? input.claims?.recipeRunId === retainedRunId
            : prefix
              ? artifactPrefix === prefix
              : input.claims?.recipeRunId === retainedRunId,
        ) ??
        (!retainedRunId && sources.length === 1 ? sources[0] : undefined);
      if (!source) throw new Error('Select a retained recipe execution from the gate package.');
      return {
        ...source,
        contractVersion,
        ...(payload?.kind === 'ready' && payload.prPackage?.reviewSnapshot
          ? { comparisonSnapshot: payload.prPackage.reviewSnapshot }
          : payload?.kind === 'output-review' && run.qaSource
            ? { comparisonSnapshot: run.qaSource }
            : {}),
        ...(source.input.claims
          ? {
              claimOverrideAuthority: claimOverrideAuthority(run, source.input),
              visualReviewAuthority: visualReviewAuthority(
                run,
                source.input,
                !frozen
                  ? undefined
                  : payload?.kind === 'ready'
                    ? (payload.prPackage?.visualJudgmentReceiptIds ?? [])
                    : payload?.kind === 'output-review'
                      ? (payload.visualJudgmentReceiptIds ?? [])
                      : [],
                await readVisualReviewPolicy(run),
              ),
              // This hint fences a future write. Only the writer qualifies QA
              // registration; missing registration must not hide readable history.
              visualReviewContext: {
                snapshotIdentity:
                  captured?.snapshotIdentity ?? visualReviewSnapshotIdentity(run, decisionId),
                decisionId,
              },
            }
          : {}),
        packagePath: source.artifactPrefix.replace(/^artifacts\//u, '').replace(/\/$/u, '') || '.',
        errors: reviewValidationErrors(source.input),
      };
    }
    if (!group?.artifactRoot) return { artifactPrefix, contractVersion, errors: [] };
    const locality = run.slotId ? await getSlotLocality(run.slotId) : null;
    const useLocal =
      !locality ||
      (shouldServeRecipeArtifactFromLocalCache(run, group.artifactRoot, locality.isLocal) &&
        existsSync(group.artifactRoot));
    let result;
    if (useLocal) {
      result = await readRecordedEvidencePackage(group.artifactRoot);
    } else {
      const root = await resolveRemoteRecipeArtifactRoot(run, group.artifactRoot);
      if (!root || !run.slotId) throw new Error('The retained recipe source is unavailable.');
      const vars = await loadSlotVars(run.slotId);
      const node = getNode(vars.machine);
      if (!node) throw new Error('The retained recipe node is disconnected.');
      const scan = await scanSlotArtifactRootDetailed(root, run, { excludeTopLevel: [] });
      if (scan.unavailable) throw new Error('The retained recipe source is unavailable.');
      const digests = new Map(
        scan.refs.map((ref) => [ref.path.slice('artifacts/'.length), ref.sha256]),
      );
      result = await readRecordedEvidencePackage(root, {
        listPaths: async () => [...digests.keys()],
        readJson: async (relPath) => {
          const response = (await sendNodeRequest(node, 'fs.read', { root, relPath })) as {
            content: string;
          };
          return JSON.parse(response.content);
        },
        digestFile: async (relPath) => {
          const digest = digests.get(relPath);
          if (!digest) throw new Error(`Retained file has no byte digest: ${relPath}`);
          return `sha256:${digest}`;
        },
      });
    }
    const errors = result.checks
      .filter((check) => check.status === 'fail')
      .map((check) => check.message);
    errors.push(...reviewValidationErrors(result.input));
    return {
      input: result.input,
      contractVersion,
      ...(errors.length === 0
        ? { comparisonSnapshot: retainedComparisonSnapshot(run, result.input, packagePath) }
        : {}),
      artifactPrefix,
      packagePath,
      errors,
      ...(errors.length ? { failureCode: 'evidence-package-unverifiable' as const } : {}),
      ...(errors.length === 0 && result.input.claims
        ? {
            claimOverrideAuthority: claimOverrideAuthority(run, result.input),
            visualReviewAuthority: visualReviewAuthority(
              run,
              result.input,
              undefined,
              await readVisualReviewPolicy(run),
            ),
          }
        : {}),
    };
  } catch (error) {
    // An unavailable/corrupt retained package stays visible; it never becomes timed proof.
    return {
      artifactPrefix,
      contractVersion,
      packagePath,
      failureCode:
        error instanceof RecordedEvidenceReadError ? error.code : 'evidence-package-unverifiable',
      errors: [error instanceof Error ? error.message : String(error)],
    };
  }
}

function reviewValidationErrors(input: RecordedEvidencePackageInput): string[] {
  return validateRecordedEvidencePackage(input)
    .findings.filter((finding) => finding.severity === 'error')
    .map((finding) => finding.message);
}

/** A historical viewer can compare only the exact execution retained by a ready package. */
export function retainedComparisonSnapshot(
  run: Run,
  input: RecordedEvidencePackageInput,
  packagePath: string | undefined,
): RunRecordedEvidenceReview['comparisonSnapshot'] {
  const recipeRunId = input.claims?.recipeRunId;
  const summaryDigest = input.artifactDigests['summary.json']?.replace(/^sha256:/u, '');
  if (!recipeRunId || !summaryDigest || !packagePath) return undefined;
  for (const decision of [...run.decisions].reverse()) {
    const payload = decision.payload;
    if (
      payload?.kind !== 'ready' ||
      payload.acceptanceStatus?.schemaVersion !== 2 ||
      payload.acceptanceStatus.recipeRunId !== recipeRunId
    )
      continue;
    const inventory = new Map(
      (payload.prPackage?.evidenceManifest ?? []).flatMap((artifact) =>
        artifact.sha256 ? [[artifact.path, artifact.sha256] as const] : [],
      ),
    );
    const root = `artifacts/${packagePath === '.' ? '' : packagePath}`;
    if (
      inventory.get(`${root.replace(/\/$/u, '')}/summary.json`)?.replace(/^sha256:/u, '') ===
        summaryDigest &&
      !recordedEvidenceInventoryMismatch(input, root, inventory)
    )
      return payload.prPackage?.reviewSnapshot;
  }
  return undefined;
}
