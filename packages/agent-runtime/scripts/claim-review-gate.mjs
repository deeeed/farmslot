import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import { readRecordedEvidencePackage } from '@farmslot/adapter-sdk';
import {
  selectedRecipeClaims,
  validateRecordedEvidencePackage,
} from '@farmslot/adapter-sdk/evidence';

import attemptSelection from './retained-recipe-attempt.cjs';

/** The existing reader verifies bytes; this only binds the task transport to that selected execution. */
export async function pendingClaimReviewIssues(taskDir, ledger) {
  const pointer = attemptSelection.readRecipeAttemptSelection(taskDir);
  if (!pointer) return ['Human evidence review requires a selected successful recipe attempt.'];
  const root = path.join(taskDir, 'artifacts', pointer.relativeArtifactRoot);
  const { input, checks } = await readRecordedEvidencePackage(root);
  const errors = checks.filter((check) => check.status === 'fail').map((check) => check.message);
  errors.push(
    ...validateRecordedEvidencePackage(input)
      .findings.filter((finding) => finding.severity === 'error')
      .map((finding) => finding.message),
  );
  if (errors.length) return errors;
  if (!input.claims || input.claims.recipeRunId !== ledger.recipeRunId)
    return ['Task verdicts belong to another recipe execution.'];
  // A repair transports the engine selection: retained rows keep their original execution.
  const selected = selectedRecipeClaims(input);
  for (const row of ledger.criteria) {
    const claim = selected.find(({ id }) => id === row.id);
    if (
      !claim ||
      [
        'id',
        'text',
        'kind',
        'parentId',
        'proofMode',
        'verdict',
        'recipeNodes',
        'assertionIndices',
        'moments',
        'retainedFrom',
      ].some((key) => !isDeepStrictEqual(row[key], claim[key]))
    )
      errors.push(`Task claim ${row.id} differs from its selected engine claim.`);
  }
  return errors;
}
