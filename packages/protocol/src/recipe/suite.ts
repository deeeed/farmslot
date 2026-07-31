import {
  addFinding,
  createContext,
  finishResult,
  isNonEmptyString,
  isRecord,
  isRelativeArtifactPath,
  type MutableValidationContext,
  type RecipeValidationResult,
  TERMINAL_STATUSES,
} from './common.js';
import { digestRecipeDocument } from './digest.js';

export const RECIPE_SUITE_SCOPE_SCHEMA_URL =
  'https://farmslot.io/schemas/recipe-suite-scope-v1.schema.json';
export const RECIPE_SUITE_RESULT_SCHEMA_URL =
  'https://farmslot.io/schemas/recipe-suite-result-v1.schema.json';

export const RECIPE_SUITE_NON_EXECUTION_REASONS = [
  'prerequisite_missing',
  'ordering_dependent',
  'needs_manual',
  'oversight',
] as const;

export type RecipeSuiteNonExecutionReason = (typeof RECIPE_SUITE_NON_EXECUTION_REASONS)[number];
export type RecipeSuiteVerdictStatus = 'pass' | 'fail' | 'unknown';

export interface RecipeSuiteScopeCase {
  id: string;
}

export interface RecipeSuiteScopeDocument {
  $schema: typeof RECIPE_SUITE_SCOPE_SCHEMA_URL;
  suite_id: string;
  cases: RecipeSuiteScopeCase[];
}

export interface RecipeSuiteVerdictResolution {
  id: string;
  kind: 'verdict';
  status: RecipeSuiteVerdictStatus;
  summary_path: string;
  summary_digest: string;
}

export interface RecipeSuiteNonExecutionResolution {
  id: string;
  kind: 'not_executed';
  reason_class: RecipeSuiteNonExecutionReason;
  detail: string;
  blocked_by?: string[];
}

export type RecipeSuiteResolution =
  | RecipeSuiteVerdictResolution
  | RecipeSuiteNonExecutionResolution;

export interface RecipeSuiteResultDocument {
  $schema: typeof RECIPE_SUITE_RESULT_SCHEMA_URL;
  suite_id: string;
  scope_digest: string;
  totals: {
    declared: number;
    executed: number;
    not_executed: number;
  };
  resolutions: RecipeSuiteResolution[];
}

export interface RecipeSuitePackageInput {
  scope: unknown;
  result: unknown;
  /** Retained summary documents keyed by their suite-package relative path. */
  summaries: Readonly<Record<string, unknown>>;
}

const DIGEST_RE = /^sha256:[a-f0-9]{64}$/u;
const NON_EXECUTION_REASON_SET = new Set<string>(RECIPE_SUITE_NON_EXECUTION_REASONS);

export function digestRecipeSuiteScope(scope: unknown): string {
  return digestRecipeDocument(scope);
}

export function validateRecipeSuiteScopeDocument(scope: unknown): RecipeValidationResult {
  const ctx = createContext();
  parseScope(ctx, scope);
  return finishResult(ctx);
}

export function validateRecipeSuiteResultDocument(result: unknown): RecipeValidationResult {
  const ctx = createContext();
  parseResult(ctx, result);
  return finishResult(ctx);
}

export function validateRecipeSuitePackage(input: RecipeSuitePackageInput): RecipeValidationResult {
  const ctx = createContext();
  const scope = parseScope(ctx, input.scope);
  const result = parseResult(ctx, input.result);
  if (!scope || !result) return finishResult(ctx);

  if (result.suite_id !== scope.suite_id) {
    addFinding(
      ctx,
      'error',
      'recipe_suite.suite_id_mismatch',
      'suite-result.json.suite_id',
      'Suite result suite_id must match the frozen scope.',
    );
  }
  if (result.scope_digest !== digestRecipeSuiteScope(scope)) {
    addFinding(
      ctx,
      'error',
      'recipe_suite.scope_digest_mismatch',
      'suite-result.json.scope_digest',
      'Suite result scope_digest must match the canonical frozen scope.',
    );
  }

  const declaredIds = new Set(scope.cases.map((entry) => entry.id));
  const resolutionsById = new Map<string, RecipeSuiteResolution[]>();
  for (const resolution of result.resolutions) {
    const entries = resolutionsById.get(resolution.id) ?? [];
    entries.push(resolution);
    resolutionsById.set(resolution.id, entries);
    if (!declaredIds.has(resolution.id)) {
      addFinding(
        ctx,
        'error',
        'recipe_suite.undeclared_resolution',
        'suite-result.json.resolutions',
        `Resolution ${resolution.id} is not declared by the frozen scope.`,
      );
    }
  }
  for (const id of declaredIds) {
    const matches = resolutionsById.get(id) ?? [];
    if (matches.length === 0) {
      addFinding(
        ctx,
        'error',
        'recipe_suite.missing_resolution',
        'suite-result.json.resolutions',
        `Declared case ${id} has no resolution.`,
      );
    } else if (matches.length > 1) {
      addFinding(
        ctx,
        'error',
        'recipe_suite.duplicate_resolution',
        'suite-result.json.resolutions',
        `Declared case ${id} has more than one resolution.`,
      );
    }
  }

  const executed = result.resolutions.filter((entry) => entry.kind === 'verdict').length;
  const notExecuted = result.resolutions.filter((entry) => entry.kind === 'not_executed').length;
  const expectedTotals = {
    declared: scope.cases.length,
    executed,
    not_executed: notExecuted,
  };
  for (const key of ['declared', 'executed', 'not_executed'] as const) {
    if (result.totals[key] !== expectedTotals[key]) {
      addFinding(
        ctx,
        'error',
        'recipe_suite.totals_mismatch',
        `suite-result.json.totals.${key}`,
        `Suite total ${key} must equal ${expectedTotals[key]}.`,
      );
    }
  }
  if (result.totals.executed + result.totals.not_executed !== result.totals.declared) {
    addFinding(
      ctx,
      'error',
      'recipe_suite.totals_mismatch',
      'suite-result.json.totals',
      'Suite executed and not_executed totals must sum to declared.',
    );
  }

  const finalResolutions = new Map(
    [...resolutionsById.entries()]
      .filter(([, entries]) => entries.length === 1)
      .map(([id, entries]) => [id, entries[0]!] as const),
  );
  const summaryPathOwners = new Map<string, string>();
  const summaryDigestOwners = new Map<string, string>();
  result.resolutions.forEach((resolution, index) => {
    if (resolution.kind !== 'verdict') return;
    const pathOwner = summaryPathOwners.get(resolution.summary_path);
    if (pathOwner != null) {
      addFinding(
        ctx,
        'error',
        'recipe_suite.duplicate_summary_path',
        `suite-result.json.resolutions[${index}].summary_path`,
        `Cases ${pathOwner} and ${resolution.id} cannot reuse the same retained summary.`,
      );
    } else {
      summaryPathOwners.set(resolution.summary_path, resolution.id);
    }
    const digestOwner = summaryDigestOwners.get(resolution.summary_digest);
    if (digestOwner != null) {
      addFinding(
        ctx,
        'error',
        'recipe_suite.duplicate_summary_digest',
        `suite-result.json.resolutions[${index}].summary_digest`,
        `Cases ${digestOwner} and ${resolution.id} cannot reuse the same retained summary digest.`,
      );
    } else {
      summaryDigestOwners.set(resolution.summary_digest, resolution.id);
    }
  });
  const referencedSummaryPaths = new Set(
    result.resolutions
      .filter((resolution) => resolution.kind === 'verdict')
      .map((resolution) => resolution.summary_path),
  );
  for (const summaryPath of Object.keys(input.summaries)) {
    if (!referencedSummaryPaths.has(summaryPath)) {
      addFinding(
        ctx,
        'error',
        'recipe_suite.unexpected_summary',
        `summaries.${summaryPath}`,
        `Retained summary ${summaryPath} is not referenced by a suite verdict.`,
      );
    }
  }
  result.resolutions.forEach((resolution, index) => {
    if (resolution.kind === 'verdict') {
      validateVerdictSummary(ctx, resolution, index, input.summaries);
      return;
    }
    validateNonExecutionSemantics(ctx, resolution, index, declaredIds, finalResolutions);
  });
  validateOrderingDependencyGraph(ctx, finalResolutions);

  return finishResult(ctx);
}

function validateOrderingDependencyGraph(
  ctx: MutableValidationContext,
  resolutions: ReadonlyMap<string, RecipeSuiteResolution>,
): void {
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): void => {
    if (visiting.has(id)) {
      addFinding(
        ctx,
        'error',
        'recipe_suite.ordering_dependency_cycle',
        'suite-result.json.resolutions',
        `Ordering dependencies must be acyclic; ${id} participates in a cycle.`,
      );
      return;
    }
    if (visited.has(id)) return;
    const resolution = resolutions.get(id);
    if (resolution?.kind !== 'not_executed' || resolution.reason_class !== 'ordering_dependent') {
      visited.add(id);
      return;
    }
    visiting.add(id);
    for (const blocker of resolution.blocked_by ?? []) visit(blocker);
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of resolutions.keys()) visit(id);
}

function parseScope(
  ctx: MutableValidationContext,
  value: unknown,
): RecipeSuiteScopeDocument | undefined {
  if (!isRecord(value)) {
    addFinding(
      ctx,
      'error',
      'recipe_suite.invalid_scope',
      'suite-scope.json',
      'Suite scope must be an object.',
    );
    return undefined;
  }
  validateExactKeys(ctx, value, ['$schema', 'suite_id', 'cases'], 'suite-scope.json');
  if (value.$schema !== RECIPE_SUITE_SCOPE_SCHEMA_URL) {
    addFinding(
      ctx,
      'error',
      'recipe_suite.invalid_scope_schema',
      'suite-scope.json.$schema',
      'Suite scope must declare the Recipe Suite Scope v1 schema URL.',
    );
  }
  if (!isNonEmptyString(value.suite_id)) {
    addFinding(
      ctx,
      'error',
      'recipe_suite.invalid_suite_id',
      'suite-scope.json.suite_id',
      'Suite scope suite_id must be a non-empty string.',
    );
  }
  if (!Array.isArray(value.cases) || value.cases.length === 0) {
    addFinding(
      ctx,
      'error',
      'recipe_suite.invalid_cases',
      'suite-scope.json.cases',
      'Suite scope cases must be a non-empty array.',
    );
    return undefined;
  }
  const cases: RecipeSuiteScopeCase[] = [];
  const seen = new Set<string>();
  value.cases.forEach((entry, index) => {
    const path = `suite-scope.json.cases[${index}]`;
    if (!isRecord(entry)) {
      addFinding(ctx, 'error', 'recipe_suite.invalid_case', path, 'Suite cases must be objects.');
      return;
    }
    validateExactKeys(ctx, entry, ['id'], path);
    if (!isNonEmptyString(entry.id)) {
      addFinding(
        ctx,
        'error',
        'recipe_suite.invalid_case_id',
        `${path}.id`,
        'Suite case id must be a non-empty string.',
      );
      return;
    }
    if (seen.has(entry.id)) {
      addFinding(
        ctx,
        'error',
        'recipe_suite.duplicate_case_id',
        `${path}.id`,
        `Suite case id ${entry.id} appears more than once.`,
      );
    }
    seen.add(entry.id);
    cases.push({ id: entry.id });
  });
  if (!isNonEmptyString(value.suite_id) || cases.length !== value.cases.length) return undefined;
  return { $schema: RECIPE_SUITE_SCOPE_SCHEMA_URL, suite_id: value.suite_id, cases };
}

function parseResult(
  ctx: MutableValidationContext,
  value: unknown,
): RecipeSuiteResultDocument | undefined {
  if (!isRecord(value)) {
    addFinding(
      ctx,
      'error',
      'recipe_suite.invalid_result',
      'suite-result.json',
      'Suite result must be an object.',
    );
    return undefined;
  }
  validateExactKeys(
    ctx,
    value,
    ['$schema', 'suite_id', 'scope_digest', 'totals', 'resolutions'],
    'suite-result.json',
  );
  if (value.$schema !== RECIPE_SUITE_RESULT_SCHEMA_URL) {
    addFinding(
      ctx,
      'error',
      'recipe_suite.invalid_result_schema',
      'suite-result.json.$schema',
      'Suite result must declare the Recipe Suite Result v1 schema URL.',
    );
  }
  if (!isNonEmptyString(value.suite_id)) {
    addFinding(
      ctx,
      'error',
      'recipe_suite.invalid_suite_id',
      'suite-result.json.suite_id',
      'Suite result suite_id must be a non-empty string.',
    );
  }
  if (typeof value.scope_digest !== 'string' || !DIGEST_RE.test(value.scope_digest)) {
    addFinding(
      ctx,
      'error',
      'recipe_suite.invalid_scope_digest',
      'suite-result.json.scope_digest',
      'Suite scope_digest must be a sha256 digest.',
    );
  }
  const totals = parseTotals(ctx, value.totals);
  if (!Array.isArray(value.resolutions) || value.resolutions.length === 0) {
    addFinding(
      ctx,
      'error',
      'recipe_suite.invalid_resolutions',
      'suite-result.json.resolutions',
      'Suite resolutions must be a non-empty array.',
    );
    return undefined;
  }
  const resolutions: RecipeSuiteResolution[] = [];
  value.resolutions.forEach((entry, index) => {
    const parsed = parseResolution(ctx, entry, index);
    if (parsed) resolutions.push(parsed);
  });
  if (
    !isNonEmptyString(value.suite_id) ||
    typeof value.scope_digest !== 'string' ||
    !DIGEST_RE.test(value.scope_digest) ||
    !totals ||
    resolutions.length !== value.resolutions.length
  ) {
    return undefined;
  }
  return {
    $schema: RECIPE_SUITE_RESULT_SCHEMA_URL,
    suite_id: value.suite_id,
    scope_digest: value.scope_digest,
    totals,
    resolutions,
  };
}

function parseTotals(
  ctx: MutableValidationContext,
  value: unknown,
): RecipeSuiteResultDocument['totals'] | undefined {
  if (!isRecord(value)) {
    addFinding(
      ctx,
      'error',
      'recipe_suite.invalid_totals',
      'suite-result.json.totals',
      'Suite totals must be an object.',
    );
    return undefined;
  }
  validateExactKeys(
    ctx,
    value,
    ['declared', 'executed', 'not_executed'],
    'suite-result.json.totals',
  );
  const output = {} as RecipeSuiteResultDocument['totals'];
  let valid = true;
  for (const key of ['declared', 'executed', 'not_executed'] as const) {
    const minimum = key === 'declared' ? 1 : 0;
    if (!Number.isInteger(value[key]) || Number(value[key]) < minimum) {
      addFinding(
        ctx,
        'error',
        'recipe_suite.invalid_total',
        `suite-result.json.totals.${key}`,
        `Suite total ${key} must be an integer of at least ${minimum}.`,
      );
      valid = false;
    } else {
      output[key] = Number(value[key]);
    }
  }
  return valid ? output : undefined;
}

function parseResolution(
  ctx: MutableValidationContext,
  value: unknown,
  index: number,
): RecipeSuiteResolution | undefined {
  const path = `suite-result.json.resolutions[${index}]`;
  if (!isRecord(value)) {
    addFinding(
      ctx,
      'error',
      'recipe_suite.invalid_resolution',
      path,
      'Suite resolutions must be objects.',
    );
    return undefined;
  }
  if (value.kind === 'verdict') {
    validateExactKeys(ctx, value, ['id', 'kind', 'status', 'summary_path', 'summary_digest'], path);
    if (
      !isNonEmptyString(value.id) ||
      typeof value.status !== 'string' ||
      !TERMINAL_STATUSES.has(value.status) ||
      !isNonEmptyString(value.summary_path) ||
      !isRelativeArtifactPath(value.summary_path) ||
      typeof value.summary_digest !== 'string' ||
      !DIGEST_RE.test(value.summary_digest)
    ) {
      addFinding(
        ctx,
        'error',
        'recipe_suite.invalid_verdict',
        path,
        'Suite verdict requires an id, terminal status, safe summary path, and sha256 summary digest.',
      );
      return undefined;
    }
    return {
      id: value.id,
      kind: 'verdict',
      status: value.status as RecipeSuiteVerdictStatus,
      summary_path: value.summary_path,
      summary_digest: value.summary_digest,
    };
  }
  if (value.kind === 'not_executed') {
    validateExactKeys(ctx, value, ['id', 'kind', 'reason_class', 'detail', 'blocked_by'], path, [
      'blocked_by',
    ]);
    const blockedBy = value.blocked_by;
    const blockedByValid =
      blockedBy == null ||
      (Array.isArray(blockedBy) &&
        blockedBy.length > 0 &&
        blockedBy.every(isNonEmptyString) &&
        new Set(blockedBy).size === blockedBy.length);
    if (
      !isNonEmptyString(value.id) ||
      typeof value.reason_class !== 'string' ||
      !NON_EXECUTION_REASON_SET.has(value.reason_class) ||
      !isNonEmptyString(value.detail) ||
      !blockedByValid ||
      (value.reason_class === 'ordering_dependent' && blockedBy == null) ||
      (value.reason_class !== 'ordering_dependent' && blockedBy != null)
    ) {
      addFinding(
        ctx,
        'error',
        'recipe_suite.invalid_non_execution',
        path,
        'Suite non-execution requires an explicit reason, detail, and blocked_by only for ordering_dependent.',
      );
      return undefined;
    }
    return {
      id: value.id,
      kind: 'not_executed',
      reason_class: value.reason_class as RecipeSuiteNonExecutionReason,
      detail: value.detail,
      ...(Array.isArray(blockedBy) ? { blocked_by: [...blockedBy] as string[] } : {}),
    };
  }
  addFinding(
    ctx,
    'error',
    'recipe_suite.invalid_resolution_kind',
    `${path}.kind`,
    'Suite resolution kind must be verdict or not_executed.',
  );
  return undefined;
}

function validateVerdictSummary(
  ctx: MutableValidationContext,
  verdict: RecipeSuiteVerdictResolution,
  index: number,
  summaries: Readonly<Record<string, unknown>>,
): void {
  const path = `suite-result.json.resolutions[${index}]`;
  const summary = summaries[verdict.summary_path];
  if (summary == null) {
    addFinding(
      ctx,
      'error',
      'recipe_suite.missing_summary',
      `${path}.summary_path`,
      `Suite package is missing ${verdict.summary_path}.`,
    );
    return;
  }
  if (digestRecipeDocument(summary) !== verdict.summary_digest) {
    addFinding(
      ctx,
      'error',
      'recipe_suite.summary_digest_mismatch',
      `${path}.summary_digest`,
      `Retained summary ${verdict.summary_path} does not match its digest.`,
    );
  }
  if (!isRecord(summary) || summary.status !== verdict.status) {
    addFinding(
      ctx,
      'error',
      'recipe_suite.summary_status_mismatch',
      `${path}.status`,
      `Verdict status must match retained summary ${verdict.summary_path}.`,
    );
  }
}

function validateNonExecutionSemantics(
  ctx: MutableValidationContext,
  resolution: RecipeSuiteNonExecutionResolution,
  index: number,
  declaredIds: ReadonlySet<string>,
  finalResolutions: ReadonlyMap<string, RecipeSuiteResolution>,
): void {
  const path = `suite-result.json.resolutions[${index}]`;
  if (resolution.reason_class === 'oversight') {
    addFinding(
      ctx,
      'error',
      'recipe_suite.incomplete_oversight',
      `${path}.reason_class`,
      'A suite containing oversight is incomplete.',
    );
  }
  if (resolution.reason_class !== 'ordering_dependent') return;
  const blockedBy = resolution.blocked_by ?? [];
  for (const blocker of blockedBy) {
    if (!declaredIds.has(blocker)) {
      addFinding(
        ctx,
        'error',
        'recipe_suite.undeclared_blocker',
        `${path}.blocked_by`,
        `Blocking case ${blocker} is not declared by the frozen scope.`,
      );
    }
  }
  if (
    blockedBy.length > 0 &&
    blockedBy.every((blocker) => {
      const blockerResolution = finalResolutions.get(blocker);
      return blockerResolution?.kind === 'verdict' && blockerResolution.status === 'pass';
    })
  ) {
    addFinding(
      ctx,
      'error',
      'recipe_suite.resolved_ordering_dependency',
      `${path}.blocked_by`,
      'An ordering-dependent case cannot remain unexecuted after every blocker passes.',
    );
  }
}

function validateExactKeys(
  ctx: MutableValidationContext,
  value: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
  optional: readonly string[] = [],
): void {
  const allowedSet = new Set(allowed);
  const optionalSet = new Set(optional);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) {
      addFinding(
        ctx,
        'error',
        'recipe_suite.unexpected_field',
        `${path}.${key}`,
        `${path} does not support ${key}.`,
      );
    }
  }
  for (const key of allowed) {
    if (optionalSet.has(key)) continue;
    if (!Object.hasOwn(value, key)) {
      addFinding(
        ctx,
        'error',
        'recipe_suite.missing_field',
        `${path}.${key}`,
        `${path} requires ${key}.`,
      );
    }
  }
}
