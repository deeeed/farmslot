import os from 'node:os';
import path from 'node:path';

import { isRecord } from '@farmslot/protocol';
import { getJsonPathValue, redactRecipeParams } from '@farmslot/recipe-runner';

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
}

const MAX_JSON_BYTES = 4 * 1024 * 1024;
const MAX_NODE_LINES = 28;
const MAX_CLAIM_LINES = 5;
const MAX_LINE = 200;
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

/** Key-based and value-based redaction shared with recorded recipe parameters. */
function redact(key: string, value: unknown): unknown {
  let safe = redactRecipeParams({ [key]: value }, undefined).params[key];
  if (typeof safe === 'string') {
    for (const pattern of TOKEN_PATTERNS) safe = (safe as string).replace(pattern, '<redacted>');
    const home = os.homedir();
    if (home.length > 1) safe = (safe as string).split(home).join('~');
  }
  return safe;
}

function scalar(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(clip(oneLine(value), MAX_VALUE));
  if (value === undefined) return 'missing';
  return clip(JSON.stringify(value) ?? String(value), MAX_VALUE);
}

function display(key: string, raw: unknown): string {
  const value = redact(key, raw);
  if (Array.isArray(value)) {
    const items = value.filter((item) => item === null || typeof item !== 'object');
    if (items.length !== value.length || !items.length) return `[${value.length}]`;
    const shown = items.slice(0, 2).map((item) => scalar(redact(key, item)));
    return `[${value.length}] ${shown.join(',')}${value.length > 2 ? `,+${value.length - 2}` : ''}`;
  }
  if (isRecord(value)) return `{${Object.keys(value).length} keys}`;
  return scalar(value);
}

interface Leaf {
  path: string;
  operator: string;
  value?: unknown;
}

function leaves(assertion: unknown): Leaf[] {
  if (!isRecord(assertion)) return [];
  for (const group of ['all', 'any']) {
    if (Array.isArray(assertion[group])) return assertion[group].flatMap(leaves);
  }
  return typeof assertion.path === 'string' && typeof assertion.operator === 'string'
    ? [{ path: assertion.path, operator: assertion.operator, value: assertion.value }]
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

function lastKey(jsonPath: string): string {
  return /([^.[\]]+)(?:\[\d+\])*$/.exec(jsonPath)?.[1] ?? jsonPath;
}

function assertionText(document: unknown, leaf: Leaf, failed: boolean): string {
  const label = leaf.path.replace(/^\$\.?/, '') || '$';
  let actual: unknown;
  try {
    actual = document === undefined ? undefined : getJsonPathValue(document, leaf.path);
  } catch {
    actual = undefined;
  }
  const shown = document === undefined ? 'not retained' : display(lastKey(leaf.path), actual);
  const symbol = OPERATORS[leaf.operator] ?? leaf.operator;
  const implied = (leaf.operator === 'eq' || leaf.operator === 'deep_eq') && !failed;
  const expected =
    leaf.value === undefined ? symbol : `${symbol}${display(lastKey(leaf.path), leaf.value)}`;
  return implied ? `${label}=${shown}` : `${label}=${shown} (${expected})`;
}

async function entryDetail(root: string, entry: Record<string, unknown>): Promise<string> {
  const output = isRecord(entry.output) ? entry.output : {};
  const failed = entry.ok !== true;
  const parts: string[] = [];
  if (typeof output.path === 'string' && output.assertion !== undefined) {
    // Reports are retained in the package at the path the assertion read.
    const document = await optionalJson(root, output.path).catch(() => undefined);
    parts.push(path.basename(output.path));
    parts.push(...leaves(output.assertion).map((leaf) => assertionText(document, leaf, failed)));
  } else if (typeof output.exitCode === 'number') {
    parts.push(`exit ${output.exitCode}`);
    const stream = failed && typeof output.stderr === 'string' ? output.stderr : output.stdout;
    if (typeof stream === 'string' && stream.trim())
      parts.push(String(redact('stdout', clip(oneLine(stream), 80))));
  } else if (Array.isArray(output.artifacts)) {
    parts.push(`indexed ${output.artifacts.length}`);
  } else {
    for (const [key, value] of Object.entries(output).slice(0, 4)) {
      if (value === null || typeof value !== 'object') parts.push(`${key}=${display(key, value)}`);
    }
  }
  const error = isRecord(entry.error) ? entry.error.message : entry.error;
  if (failed && typeof error === 'string') parts.push(`error: ${redact('error', oneLine(error))}`);
  return parts.join(' · ');
}

function networkOf(params: Record<string, unknown>, reports: unknown[]): string {
  for (const key of ['network', 'chain', 'environment']) {
    if (typeof params[key] === 'string') return String(params[key]);
  }
  const seen = new Set(
    reports.flatMap((report) =>
      isRecord(report) && typeof report.network === 'string' ? [report.network] : [],
    ),
  );
  return seen.size === 1 ? [...seen][0]! : seen.size ? [...seen].sort().join('/') : 'not recorded';
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
  const ledger = await optionalJson(root, 'acceptance-status.json');
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
  const runId = isRecord(summary) && typeof summary.recipeRunId === 'string' ? summary.recipeRunId : '?';
  const digest =
    isRecord(resolution) && isRecord(resolution.root) && typeof resolution.root.digest === 'string'
      ? resolution.root.digest
      : 'unknown';
  const commit =
    isRecord(product) && typeof product.git_ref === 'string'
      ? `${product.git_ref} (${product.dirty === false ? 'clean' : 'dirty'})`
      : 'not recorded';
  const inputs = Object.entries(params)
    .map(([key, value]) => `${key}=${display(key, value).replace(/^"|"$/g, '')}`)
    .join(' · ');

  const lines = [
    `Recipe: ${oneLine(title)}`,
    `Run ${runId} · digest ${digest}`,
    `Commit ${commit} · network ${networkOf(params, reports)}`,
    ...(inputs ? [`Inputs: ${inputs}`] : []),
  ].map((line) => clip(line, MAX_LINE));

  const nodeLines = await Promise.all(
    entries.map(async (entry) => {
      const detail = await entryDetail(root, entry);
      const mark = entry.ok === true ? '✓' : '✗';
      return clip(
        `${mark} ${String(entry.nodeId)}  ${String(entry.action)}${detail ? `  ${detail}` : ''}`,
        MAX_LINE,
      );
    }),
  );
  if (nodeLines.length > MAX_NODE_LINES) {
    // Keep every failure; fill the rest in trace order.
    const keep = new Set(nodeLines.flatMap((line, index) => (line.startsWith('✗') ? [index] : [])));
    for (let index = 0; keep.size < MAX_NODE_LINES - 1 && index < nodeLines.length; index += 1)
      keep.add(index);
    const kept = nodeLines.filter((_, index) => keep.has(index));
    lines.push(...kept, `… ${nodeLines.length - kept.length} more passing nodes in trace.json`);
  } else {
    lines.push(...nodeLines);
  }

  const passed = isRecord(summary) && typeof summary.passed === 'number' ? summary.passed : '?';
  const total = isRecord(summary) && typeof summary.total === 'number' ? summary.total : '?';
  const status = isRecord(summary) && typeof summary.status === 'string' ? summary.status : '?';
  lines.push(`${passed}/${total} nodes passed · status ${status}`);

  const criteria = (isRecord(ledger) && Array.isArray(ledger.criteria) ? ledger.criteria : []).filter(
    isRecord,
  );
  if (!criteria.length) {
    lines.push('Criteria: none declared by the recipe (no proofTargets)');
  } else {
    const claimLines = criteria.map((claim) =>
      clip(
        `${String(claim.id)} ${String(claim.verdict)} [${String(claim.proofMode)}] ← ${
          Array.isArray(claim.recipeNodes) && claim.recipeNodes.length
            ? claim.recipeNodes.join(', ')
            : 'no node'
        }`,
        MAX_LINE,
      ),
    );
    lines.push(...claimLines.slice(0, MAX_CLAIM_LINES));
    if (claimLines.length > MAX_CLAIM_LINES)
      lines.push(`… ${claimLines.length - MAX_CLAIM_LINES} more criteria in acceptance-status.json`);
  }
  lines.push(clip(`Artifacts: ${input.displayDir ?? root}`, MAX_LINE));
  return `${lines.join('\n')}\n`;
}
