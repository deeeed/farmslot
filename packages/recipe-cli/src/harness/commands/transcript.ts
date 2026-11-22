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

async function entryDetail(root: string, entry: Record<string, unknown>): Promise<string[]> {
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
  const runId = isRecord(summary) && typeof summary.recipeRunId === 'string'
      ? summary.recipeRunId
      : 'not recorded';
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

  const header = [
    `Recipe: ${oneLine(title)}`,
    `Run ${runId} · digest ${digest}`,
    `Commit ${commit} · network ${networkOf(params, reports)}`,
    ...(inputs ? [`Inputs: ${inputs}`] : []),
  ].map((line) => clip(line, MAX_LINE));

  const passed = isRecord(summary) && typeof summary.passed === 'number' ? summary.passed : '?';
  const total = isRecord(summary) && typeof summary.total === 'number' ? summary.total : '?';
  const status = isRecord(summary) && typeof summary.status === 'string' ? summary.status : '?';
  const footer = [`${passed}/${total} nodes passed · status ${status}`];
  const criteria = (
    isRecord(ledger) && Array.isArray(ledger.criteria) ? ledger.criteria : []
  ).filter(isRecord);
  if (!criteria.length) {
    footer.push('Criteria: none declared by the recipe (no proofTargets)');
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
    footer.push(...claimLines.slice(0, MAX_CLAIM_LINES));
    if (claimLines.length > MAX_CLAIM_LINES)
      footer.push(`… ${claimLines.length - MAX_CLAIM_LINES} more criteria in acceptance-status.json`);
  }
  footer.push(clip(`Artifacts: ${input.displayDir ?? root}`, MAX_LINE));

  const nodes = await Promise.all(
    entries.map(async (entry) => ({
      failed: entry.ok !== true,
      head: `${entry.ok === true ? '✓' : '✗'} ${String(entry.nodeId)}  ${String(entry.action)}`,
      parts: await entryDetail(root, entry),
    })),
  );
  const budget = MAX_LINES - header.length - footer.length;
  let shown = nodes;
  let omitted = 0;
  if (nodes.length > budget) {
    // Keep every failure; fill the rest in trace order.
    const keep = new Set(nodes.flatMap((node, index) => (node.failed ? [index] : [])));
    for (let index = 0; keep.size < budget - 1 && index < nodes.length; index += 1)
      keep.add(index);
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
    ...(omitted ? [`… ${omitted} more passing nodes in trace.json`] : []),
    ...footer,
  ];
  return `${lines.join('\n')}\n`;
}
