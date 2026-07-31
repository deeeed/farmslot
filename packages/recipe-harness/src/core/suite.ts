import { mkdir, readFile } from 'node:fs/promises';

import {
  digestRecipeDocument,
  digestRecipeSuiteScope,
  RECIPE_SUITE_RESULT_SCHEMA_URL,
  type RecipeSuiteNonExecutionResolution,
  type RecipeSuiteResultDocument,
  type RecipeSuiteScopeDocument,
  type RecipeValidationFinding,
  validateRecipeSuitePackage,
  validateRecipeSuiteScopeDocument,
} from '@farmslot/protocol';

import { writeFileWithinRoot } from './path.js';
import type { RecipeRunResult } from './types.js';

export interface RecipeSuiteScopeSnapshot {
  readonly scope: RecipeSuiteScopeDocument;
  readonly digest: string;
}

export interface RecipeSuiteVerdictInput {
  id: string;
  kind: 'verdict';
  result: RecipeRunResult;
}

export type RecipeSuiteResolutionInput =
  | RecipeSuiteVerdictInput
  | RecipeSuiteNonExecutionResolution;

export interface FinalizeRecipeSuiteRequest {
  scope: RecipeSuiteScopeSnapshot;
  resolutions: readonly RecipeSuiteResolutionInput[];
  outputDir: string;
}

export interface RecipeSuiteFinalizeResult {
  scopePath: string;
  resultPath: string;
  result: RecipeSuiteResultDocument;
}

export function freezeRecipeSuiteScope(scope: unknown): RecipeSuiteScopeSnapshot {
  const validation = validateRecipeSuiteScopeDocument(scope);
  if (validation.status === 'invalid') {
    throw new Error(
      formatSuiteValidationFailure('Recipe suite scope is invalid', validation.findings),
    );
  }
  const retained = structuredClone(scope) as RecipeSuiteScopeDocument;
  deepFreeze(retained);
  return Object.freeze({ scope: retained, digest: digestRecipeSuiteScope(retained) });
}

export async function finalizeRecipeSuite(
  request: FinalizeRecipeSuiteRequest,
): Promise<RecipeSuiteFinalizeResult> {
  if (digestRecipeSuiteScope(request.scope.scope) !== request.scope.digest) {
    throw new Error('Recipe suite scope changed after it was frozen.');
  }
  const summaries: Record<string, unknown> = {};
  const summaryFiles: Array<{ path: string; content: string }> = [];
  const resolutions: RecipeSuiteResultDocument['resolutions'] = [];
  let summaryIndex = 0;

  for (const input of request.resolutions) {
    if (input.kind === 'not_executed') {
      resolutions.push(structuredClone(input));
      continue;
    }
    const summary: unknown = JSON.parse(await readFile(input.result.summaryPath, 'utf8'));
    const summaryPath = `summaries/${String(++summaryIndex).padStart(4, '0')}.json`;
    summaries[summaryPath] = summary;
    summaryFiles.push({ path: summaryPath, content: `${JSON.stringify(summary, null, 2)}\n` });
    resolutions.push({
      id: input.id,
      kind: 'verdict',
      status: input.result.status,
      summary_path: summaryPath,
      summary_digest: digestRecipeDocument(summary),
    });
  }

  const result: RecipeSuiteResultDocument = {
    $schema: RECIPE_SUITE_RESULT_SCHEMA_URL,
    suite_id: request.scope.scope.suite_id,
    scope_digest: request.scope.digest,
    totals: {
      declared: request.scope.scope.cases.length,
      executed: resolutions.filter((entry) => entry.kind === 'verdict').length,
      not_executed: resolutions.filter((entry) => entry.kind === 'not_executed').length,
    },
    resolutions,
  };
  const validation = validateRecipeSuitePackage({
    scope: request.scope.scope,
    result,
    summaries,
  });
  if (validation.status === 'invalid') {
    throw new Error(
      formatSuiteValidationFailure('Recipe suite result is invalid', validation.findings),
    );
  }

  await mkdir(request.outputDir, { recursive: true, mode: 0o700 });
  for (const file of summaryFiles) {
    await writeFileWithinRoot(request.outputDir, file.path, file.content);
  }
  const scopePath = await writeFileWithinRoot(
    request.outputDir,
    'suite-scope.json',
    `${JSON.stringify(request.scope.scope, null, 2)}\n`,
  );
  const resultPath = await writeFileWithinRoot(
    request.outputDir,
    'suite-result.json',
    `${JSON.stringify(result, null, 2)}\n`,
  );
  return { scopePath, resultPath, result };
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function formatSuiteValidationFailure(
  prefix: string,
  findings: readonly RecipeValidationFinding[],
): string {
  return `${prefix}: ${findings.map((finding) => `${finding.code} ${finding.path}`).join(', ')}.`;
}
