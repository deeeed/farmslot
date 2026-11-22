import os from 'node:os';
import path from 'node:path';

import { isRecord } from '@farmslot/protocol';
import { evaluateAtomicValue, getJsonPathValue, redactRecipeParams } from '@farmslot/recipe-runner';

import { readContainedJsonArtifact } from '../artifact-files.js';

/**
 * A compact, redacted text transcript of one retained recipe attempt, derived only from the
 * frozen package (trace, summary, provenance, claim ledger and retained reports). It is the
 * proof artifact for runs without UI claims; the package stays the authority.
 */
export interface RecipeTranscriptInput {
  /** Retained artifact package root (the directory holding trace.json). */
  artifactDir: string;
  /** Package path shown in the footer; defaults to `artifactDir`. */
  displayDir?: string;
  /**
   * The task's `artifacts/` directory. Its acceptance-status.json supplies the criteria when the
   * package declares none, but only when it belongs to the same recipe run.
   */
  runLedgerDir?: string;
}

const MAX_JSON_BYTES = 4 * 1024 * 1024;
const MAX_LINES = 40;
const MAX_CLAIM_LINES = 5;
const MAX_LINE = 160;
const MAX_VALUE = 48;

const OPERATORS: Record<string, string> = {
  eq: '=',
  deep_eq: '=',
  ne: '≠',
  neq: '≠',
  gt: '>',
  gte: '≥',
  lt: '<',
  lte: '≤',
  contains: '∋',
  not_contains: '∌',
  matches: '~',
  one_of: '∈',
  length_eq: 'len=',
  length_gt: 'len>',
  length_gte: 'len≥',
  length_lt: 'len<',
  length_lte: 'len≤',
};

const TOKEN_PATTERNS: RegExp[] = [
  /\bBearer\s+[^\s"',]+/giu,
  /\b(?:gh[pousr]_|github_pat_|sk-|xox[abpr]-)[A-Za-z0-9_-]{10,}/gu,
];

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

// Task-local paths: publication strips any PR-body line that contains one, even in a fence.
const LOCAL_PATH =
  /(?:\.\/)?(?:\.task|temp|artifacts|screenshots|videos|recipe-runs)\/[^\s<)>'"`|]*?([^\s<)>'"`|/]+)(?=[\s<)>'"`|]|$)/giu;

function sensitiveKey(key: string): boolean {
  return redactRecipeParams({ [key]: 'value' }, undefined).params[key] === '<redacted>';
}

/**
 * Redaction shared with recorded recipe parameters: any sensitive key on the value's path hides
 * it, and strings lose credential patterns, home paths and task-local paths.
 */
function redact(keys: readonly string[], value: unknown): unknown {
  if (keys.some(sensitiveKey)) return '<redacted>';
  if (Array.isArray(value)) return value.map((item) => redact([], item));
  if (isRecord(value)) return value;
  if (typeof value !== 'string') return value;
  let safe = String(redactRecipeParams({ value }, undefined).params.value);
  for (const pattern of TOKEN_PATTERNS) safe = safe.replace(pattern, '<redacted>');
  const home = os.homedir();
  if (home.length > 1) safe = safe.split(home).join('~');
  return safe.replace(LOCAL_PATH, '…/$1');
}

/** Any free text (ids, labels, paths) on one line with the same redaction. */
function safeText(value: unknown): string {
  return oneLine(String(redact([], String(value))));
}

function scalar(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(clip(oneLine(value), MAX_VALUE));
  if (value === undefined) return 'missing';
  return clip(JSON.stringify(value) ?? String(value), MAX_VALUE);
}

function display(keys: readonly string[], raw: unknown): string {
  const value = redact(keys, raw);
  if (Array.isArray(value)) {
    const items = value.filter((item) => item === null || typeof item !== 'object');
    if (items.length !== value.length || !items.length) return `[${value.length}]`;
    const shown = items.slice(0, 2).map(scalar);
    return `[${value.length}] ${shown.join(',')}${value.length > 2 ? `,+${value.length - 2}` : ''}`;
  }
  if (isRecord(value)) return `{${Object.keys(value).length} keys}`;
  return scalar(value);
}

interface Leaf {
  path: string;
  operator: string;
  value?: unknown;
  /** The group that decides the leaf: it must hold (all), must not hold (none), or may (any). */
  mode: 'all' | 'any' | 'none';
}

function leaves(assertion: unknown, mode: Leaf['mode'] = 'all'): Leaf[] {
  if (!isRecord(assertion)) return [];
  for (const group of ['all', 'any', 'none'] as const) {
    if (!Array.isArray(assertion[group])) continue;
    const next =
      group === 'none' ? (mode === 'none' ? 'all' : 'none') : group === 'any' ? 'any' : mode;
    return assertion[group].flatMap((child) => leaves(child, mode === 'any' ? 'any' : next));
  }
  return typeof assertion.path === 'string' && typeof assertion.operator === 'string'
    ? [{ path: assertion.path, operator: assertion.operator, value: assertion.value, mode }]
    : [];
}

async function optionalJson(root: string, file: string): Promise<unknown> {
  try {
    return await readContainedJsonArtifact<unknown>(root, file, MAX_JSON_BYTES, file);
  } catch (error) {
    if (isRecord(error) && error.code === 'ENOENT') return undefined;
    throw error;
  }
}

function pathKeys(jsonPath: string): string[] {
  return jsonPath
    .replace(/^\$\.?/, '')
    .split(/[.[\]]+/)
    .filter(Boolean);
}

function holds(actual: unknown, leaf: Leaf): boolean | undefined {
  try {
    return evaluateAtomicValue(actual, leaf.operator, leaf.value);
  } catch {
    return undefined;
  }
}

/** The retained report against the whole recorded assertion, with its group semantics. */
function satisfies(document: unknown, assertion: unknown): boolean | undefined {
  if (!isRecord(assertion)) return undefined;
  for (const group of ['all', 'any', 'none'] as const) {
    if (!Array.isArray(assertion[group])) continue;
    const results = assertion[group].map((child) => satisfies(document, child));
    if (results.includes(undefined)) return undefined;
    if (group === 'all') return results.every(Boolean);
    return group === 'any' ? results.some(Boolean) : !results.some(Boolean);
  }
  if (typeof assertion.path !== 'string' || typeof assertion.operator !== 'string')
    return undefined;
  let actual: unknown;
  try {
    actual = getJsonPathValue(document, assertion.path);
  } catch {
    return undefined;
  }
  return holds(actual, {
    path: assertion.path,
    operator: assertion.operator,
    value: assertion.value,
    mode: 'all',
  });
}

function assertionText(document: unknown, leaf: Leaf, failed: boolean): string {
  const keys = pathKeys(leaf.path);
  const label = `${leaf.mode === 'all' ? '' : `${leaf.mode === 'none' ? 'not' : 'any'} `}${safeText(
    leaf.path.replace(/^\$\.?/, '') || '$',
  )}`;
  let actual: unknown;
  try {
    actual = document === undefined ? undefined : getJsonPathValue(document, leaf.path);
  } catch {
    actual = undefined;
  }
  const shown = document === undefined ? 'not retained' : display(keys, actual);
  const symbol = safeText(OPERATORS[leaf.operator] ?? leaf.operator);
  const implied =
    (leaf.operator === 'eq' || leaf.operator === 'deep_eq') && !failed && leaf.mode === 'all';
  const expected = leaf.value === undefined ? symbol : `${symbol}${display(keys, leaf.value)}`;
  return implied ? `${label}=${shown}` : `${label}=${shown} (${expected})`;
}

async function entryDetail(root: string, entry: Record<string, unknown>): Promise<string[]> {
  const output = isRecord(entry.output) ? entry.output : {};
  const failed = entry.ok !== true;
  const parts: string[] = [];
  if (typeof output.path === 'string' && output.assertion !== undefined) {
    // Reports are retained in the package at the path the assertion read.
    const document = await optionalJson(root, output.path).catch(() => undefined);
    // The retained report is read after the run; flag one that no longer satisfies what passed,
    // first so the line budget never clips the warning off.
    if (!failed && document !== undefined && satisfies(document, output.assertion) === false)
      parts.push('⚠ retained report no longer satisfies this assertion');
    parts.push(safeText(path.basename(output.path)));
    parts.push(...leaves(output.assertion).map((leaf) => assertionText(document, leaf, failed)));
  } else if (typeof output.exitCode === 'number') {
    // Exit code only: stdout, stderr and error text can carry credentials.
    parts.push(`exit ${output.exitCode}`);
  } else if (Array.isArray(output.artifacts)) {
    parts.push(`indexed ${output.artifacts.length}`);
  }
  if (failed && !(typeof output.path === 'string' && output.assertion !== undefined))
    parts.push('failed; details in report.md');
  return parts;
}

function wrap(head: string, parts: readonly string[]): string[] {
  const lines = [head];
  for (const part of parts) {
    const last = lines.length - 1;
    const joined = `${lines[last]}${last === 0 && lines[0] === head ? '  ' : ' · '}${part}`;
    if (joined.length <= MAX_LINE) lines[last] = joined;
    else lines.push(clip(`    ${part}`, MAX_LINE));
  }
  return lines;
}

function networkOf(params: Record<string, unknown>, reports: unknown[]): string {
  const safe = (value: string) => clip(oneLine(String(redact(['network'], value))), MAX_VALUE);
  for (const key of ['network', 'chain', 'environment']) {
    if (typeof params[key] === 'string') return safe(String(params[key]));
  }
  const seen = new Set(
    reports.flatMap((report) =>
      isRecord(report) && typeof report.network === 'string' ? [safe(report.network)] : [],
    ),
  );
  return seen.size ? [...seen].sort().join('/') : 'not recorded';
}

/** Render the transcript text; deterministic for one package. */
export async function renderRecipeTranscript(input: RecipeTranscriptInput): Promise<string> {
  const root = input.artifactDir;
  const trace = await readContainedJsonArtifact<unknown>(
    root,
    'trace.json',
    MAX_JSON_BYTES,
    'Recipe trace',
  );
  const summary = await readContainedJsonArtifact<unknown>(
    root,
    'summary.json',
    MAX_JSON_BYTES,
    'Recipe summary',
  );
  const recipe = await optionalJson(root, 'recipe.json');
  const resolution = await optionalJson(root, 'recipe-resolution.json');
  const product = await optionalJson(root, 'product-provenance.json');
  const invocation = await optionalJson(root, 'recipe-invocation.json');
  const packageLedger = await optionalJson(root, 'acceptance-status.json');
  const entries = (isRecord(trace) && Array.isArray(trace.entries) ? trace.entries : []).filter(
    isRecord,
  );
  const params = isRecord(invocation) && isRecord(invocation.params) ? invocation.params : {};

  const reportPaths = [
    ...new Set(
      entries.flatMap((entry) =>
        isRecord(entry.output) &&
        typeof entry.output.path === 'string' &&
        entry.output.assertion !== undefined
          ? [entry.output.path]
          : [],
      ),
    ),
  ];
  const reports = await Promise.all(
    reportPaths.map((file) => optionalJson(root, file).catch(() => undefined)),
  );

  const title = isRecord(recipe) && typeof recipe.title === 'string' ? recipe.title : 'untitled';
  const runId =
    isRecord(summary) && typeof summary.recipeRunId === 'string'
      ? summary.recipeRunId
      : 'not recorded';
  const digest =
    isRecord(resolution) && isRecord(resolution.root) && typeof resolution.root.digest === 'string'
      ? resolution.root.digest
      : 'unknown';
  const commit =
    isRecord(product) && typeof product.git_ref === 'string'
      ? `${clip(safeText(product.git_ref), 64)} (${product.dirty === false ? 'clean' : 'dirty: not a clean-commit proof'})`
      : 'not recorded';
  const inputs = Object.entries(params)
    .map(([key, value]) => `${safeText(key)}=${display([key], value).replace(/^"|"$/g, '')}`)
    .join(' · ');

  const header = [
    `Recipe: ${safeText(title)}`,
    `Run ${safeText(runId)} · digest ${safeText(digest)}`,
    `Commit ${commit} · network ${networkOf(params, reports)}`,
    ...(inputs ? [`Inputs: ${inputs}`] : []),
  ].map((line) => clip(line, MAX_LINE));

  const passed = isRecord(summary) && typeof summary.passed === 'number' ? summary.passed : '?';
  const total = isRecord(summary) && typeof summary.total === 'number' ? summary.total : '?';
  const status = isRecord(summary) && typeof summary.status === 'string' ? summary.status : '?';
  const footer = [`${passed}/${total} nodes passed · status ${status}`];
  // Only rows of this execution: a row retained from, or recorded by, another run is not its proof.
  const criteriaOf = (ledger: unknown) =>
    (isRecord(ledger) && Array.isArray(ledger.criteria) ? ledger.criteria : [])
      .filter(isRecord)
      .filter(
        (row) =>
          row.retainedFrom === undefined &&
          (row.recipeRunId === undefined || row.recipeRunId === runId),
      );
  let criteria = criteriaOf(packageLedger);
  if (!criteria.length && input.runLedgerDir) {
    const runLedger = await optionalJson(input.runLedgerDir, 'acceptance-status.json').catch(
      () => undefined,
    );
    if (isRecord(runLedger) && runLedger.recipeRunId === runId) criteria = criteriaOf(runLedger);
  }
  if (!criteria.length) {
    footer.push(
      'Criteria: none declared (no recipe proofTargets, none in the run acceptance-status.json)',
    );
  } else {
    const claimLines = criteria.map((claim) =>
      clip(
        safeText(
          `${String(claim.id)} ${String(claim.verdict)} [${String(claim.proofMode)}] ← ${
            Array.isArray(claim.recipeNodes) && claim.recipeNodes.length
              ? claim.recipeNodes.join(', ')
              : 'no node'
          }`,
        ),
        MAX_LINE,
      ),
    );
    footer.push(...claimLines.slice(0, MAX_CLAIM_LINES));
    if (claimLines.length > MAX_CLAIM_LINES)
      footer.push(
        `… ${claimLines.length - MAX_CLAIM_LINES} more criteria in acceptance-status.json`,
      );
  }
  // A basename only: publication drops PR-body lines that carry a task-local path.
  footer.push(
    clip(
      `Artifacts: recipe run ${path.basename(input.displayDir ?? root)} (trace.json, report.md)`,
      MAX_LINE,
    ),
  );

  const nodes = await Promise.all(
    entries.map(async (entry) => ({
      failed: entry.ok !== true,
      head: `${entry.ok === true ? '✓' : '✗'} ${safeText(entry.nodeId)}  ${safeText(entry.action)}`,
      parts: await entryDetail(root, entry),
    })),
  );
  const budget = MAX_LINES - header.length - footer.length;
  let shown = nodes;
  let omitted = 0;
  if (nodes.length > budget) {
    // Failures first, then trace order, within the budget.
    const keep = new Set<number>();
    for (const failedFirst of [true, false])
      nodes.forEach((node, index) => {
        if (node.failed === failedFirst && keep.size < budget - 1) keep.add(index);
      });
    shown = nodes.filter((_, index) => keep.has(index));
    omitted = nodes.length - shown.length;
  }
  // One line per node; wrap long details onto indented lines while the budget allows,
  // failures first.
  const blocks = shown.map((node) => [
    clip(node.parts.length ? `${node.head}  ${node.parts.join(' · ')}` : node.head, MAX_LINE),
  ]);
  let spare = budget - shown.length - (omitted ? 1 : 0);
  const order = shown
    .map((node, index) => ({ node, index }))
    .sort((a, b) => Number(b.node.failed) - Number(a.node.failed) || a.index - b.index);
  for (const { node, index } of order) {
    const wrapped = wrap(node.head, node.parts);
    if (wrapped.length > 1 && wrapped.length - 1 <= spare) {
      blocks[index] = wrapped;
      spare -= wrapped.length - 1;
    }
  }
  const lines = [
    ...header,
    ...blocks.flat(),
    ...(omitted
      ? [
          `… ${omitted} more nodes in trace.json (${
            nodes.filter((node) => node.failed && !shown.includes(node)).length
          } failed)`,
        ]
      : []),
    ...footer,
  ];
  return `${lines.join('\n')}\n`;
}
