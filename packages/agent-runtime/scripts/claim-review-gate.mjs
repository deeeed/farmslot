import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import { readRecordedEvidencePackage } from '@farmslot/adapter-sdk';
import {
  selectedRecipeClaims,
  validateRecordedEvidencePackage,
} from '@farmslot/adapter-sdk/evidence';

import ledgerModule from './acceptance-ledger.cjs';
import attemptSelection from './retained-recipe-attempt.cjs';

const BOUND_CLAIM_KEYS = [
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
];

/**
 * The existing reader verifies bytes; this only binds the task transport to the
 * selected execution, and each QA case row to the case package that recorded it.
 */
export async function pendingClaimReviewIssues(taskDir, ledger) {
  const pointer = attemptSelection.readRecipeAttemptSelection(taskDir);
  if (!pointer) return ['Human evidence review requires a selected successful recipe attempt.'];
  const packages = new Map();
  const readPackage = async (root) => {
    if (!packages.has(root)) {
      const { input, checks } = await readRecordedEvidencePackage(root);
      const errors = checks
        .filter((check) => check.status === 'fail')
        .map((check) => check.message);
      errors.push(
        ...validateRecordedEvidencePackage(input)
          .findings.filter((finding) => finding.severity === 'error')
          .map((finding) => finding.message),
      );
      packages.set(root, { input, errors });
    }
    return packages.get(root);
  };
  const root = path.join(taskDir, 'artifacts', pointer.relativeArtifactRoot);
  const selected = await readPackage(root);
  if (selected.errors.length) return selected.errors;
  if (!selected.input.claims || selected.input.claims.recipeRunId !== ledger.recipeRunId)
    return ['Task verdicts belong to another recipe execution.'];
  const errors = [];
  for (const row of ledger.criteria) {
    const execution = ledgerModule.acceptanceRowExecution(ledger, row);
    const source =
      execution === ledger.recipeRunId ? root : ledgerModule.rowPackageDir(taskDir, row, execution);
    if (!source) {
      errors.push(`Task claim ${row.id} has no retained package for its execution.`);
      continue;
    }
    const { input, errors: packageErrors } = await readPackage(source);
    if (packageErrors.length) {
      errors.push(...packageErrors);
      continue;
    }
    // A repair transports the engine selection: retained rows keep their original execution.
    const claim =
      input.claims?.recipeRunId === execution
        ? selectedRecipeClaims(input).find(({ id }) => id === row.id)
        : undefined;
    if (!claim || BOUND_CLAIM_KEYS.some((key) => !isDeepStrictEqual(row[key], claim[key])))
      errors.push(`Task claim ${row.id} differs from its selected engine claim.`);
  }
  return [...new Set(errors)];
}
