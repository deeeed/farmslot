// The run evidence viewer's reads: one Recipe v1 run folder into the shared view-model,
// its sibling runs into a history, and a cheap signature the live page polls.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {
  createEvidenceReviewModel,
  type RunEvidenceView,
  runEvidenceView,
  type RunEvidenceViewRun,
} from '@farmslot/adapter-sdk/evidence';
import {
  type AcceptanceCriterionRef,
  isRecord,
  type RecordedEvidencePackageInput,
  type ReviewDiffSnapshot,
} from '@farmslot/protocol';
import { readRecordedEvidencePackage } from '@farmslot/recipe-runner';
import { groupRecipeCaptureComparisons } from '@farmslot/recipe-runner/evidence';

import { harnessContext } from './context-state.js';
import { harnessHost } from './host.js';
import { shellQuoteArg } from './parse-args.js';

/** The runner writes these two first and summary.json last. */
const RUN_MARKERS = ['recipe-invocation.json', 'recipe.json', 'summary.json'] as const;

export interface RunEvidenceHistoryEntry {
  id: string;
  title?: string;
  status: RunEvidenceViewRun['status'];
  startedAt?: string;
  /** Newest write in the folder, ISO time. */
  updatedAt: string;
}

/**
 * A file the run has not written yet reads as undefined. One it wrote that cannot be read or
 * parsed is reported in `errors`, so the page shows it instead of guessing the run's state.
 */
function readJson(file: string, errors: string[]): unknown {
  let body: string;
  try {
    body = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    errors.push(`${path.basename(file)} is unreadable: ${(error as Error).message}`);
    return undefined;
  }
  try {
    return JSON.parse(body);
  } catch (error) {
    errors.push(`${path.basename(file)} is not valid JSON: ${(error as Error).message}`);
    return undefined;
  }
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

export function isRecipeRunFolder(dir: string): boolean {
  return RUN_MARKERS.some((name) => fs.existsSync(path.join(dir, name)));
}

/**
 * The artifact manifest is the runner's last write, and its file exists before its bytes land.
 * The package is complete once the manifest reads whole.
 */
function packageComplete(dir: string): boolean {
  let body: string;
  try {
    body = fs.readFileSync(path.join(dir, 'artifact-manifest.json'), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
  try {
    const manifest: unknown = JSON.parse(body);
    return isRecord(manifest) && Array.isArray(manifest.artifacts);
  } catch (error) {
    // Expected while the runner is still writing it: the run is finishing, not failed.
    if (error instanceof SyntaxError) return false;
    throw error;
  }
}

/**
 * What the folder says about the run without reading its evidence. The runner writes
 * summary.json before both manifests, so the run is still finishing until the artifact
 * manifest reads whole; an unreadable summary is `unknown`, never `running`.
 */
function runFacts(dir: string): { run: RunEvidenceViewRun; errors: string[] } {
  const errors: string[] = [];
  const summary = readJson(path.join(dir, 'summary.json'), errors);
  const summaryUnreadable = errors.length > 0;
  const recipe = readJson(path.join(dir, 'recipe.json'), errors);
  const invocation = readJson(path.join(dir, 'recipe-invocation.json'), errors);
  const title = isRecord(recipe) ? (text(recipe.title) ?? text(recipe.description)) : undefined;
  const startedAt =
    (isRecord(summary) ? text(summary.startedAt) : undefined) ??
    (isRecord(invocation) ? text(invocation.startedAt) : undefined);
  const status =
    summary === undefined && !summaryUnreadable
      ? 'running'
      : !isRecord(summary) || (summary.status !== 'pass' && summary.status !== 'fail')
        ? 'unknown'
        : packageComplete(dir)
          ? summary.status
          : 'running';
  return {
    run: {
      id: path.basename(dir),
      ...(title ? { title } : {}),
      status,
      ...(startedAt ? { startedAt } : {}),
      ...(isRecord(summary) && text(summary.endedAt) ? { endedAt: String(summary.endedAt) } : {}),
      ...(isRecord(summary) && typeof summary.durationMs === 'number'
        ? { durationMs: summary.durationMs }
        : {}),
    },
    errors,
  };
}

/** Whether the page keeps following the folder: until the run finishes, or its summary reads. */
export function runEvidenceLive(view: Pick<RunEvidenceView, 'run'>): boolean {
  return view.run?.status === 'running' || view.run?.status === 'unknown';
}

/** A running run lists the criteria its recipe declares, none judged yet. */
function declaredCriteria(dir: string, errors: string[]): AcceptanceCriterionRef[] {
  const recipe = readJson(path.join(dir, 'recipe.json'), errors);
  if (!isRecord(recipe) || !Array.isArray(recipe.proofTargets)) return [];
  return recipe.proofTargets.flatMap((target) =>
    isRecord(target) && typeof target.id === 'string'
      ? [{ id: target.id, text: text(target.claim) ?? target.id }]
      : [],
  );
}

/**
 * The review revision a run's before/after pairs were bound to. The runner keeps no copy of
 * the host's frozen snapshot, but it writes a pair into evidence-manifest.json only when both
 * captures match that snapshot, so the pair's captures carry its base and head.
 */
function recordedComparisonSnapshot(
  dir: string,
  input: RecordedEvidencePackageInput,
  errors: string[],
): Pick<ReviewDiffSnapshot, 'baseSha' | 'headSha'> | undefined {
  const manifest = readJson(path.join(dir, 'evidence-manifest.json'), errors);
  const pair =
    isRecord(manifest) && Array.isArray(manifest.before_after_pairs)
      ? manifest.before_after_pairs.find(isRecord)
      : undefined;
  if (!pair || !input.claims) return undefined;
  const { media } = groupRecipeCaptureComparisons(input, input.claims.criteria);
  const commit = (file: unknown) =>
    media.find((entry) => entry.path === file)?.capture?.sourceCommit;
  const baseSha = commit(pair.before);
  const headSha = commit(pair.after);
  return baseSha && headSha ? { baseSha, headSha } : undefined;
}

/** One run folder as the shared view-model; read-only. */
export async function readRunEvidenceView(runDir: string): Promise<RunEvidenceView> {
  const dir = path.resolve(runDir);
  const { run, errors } = runFacts(dir);
  if (run.status === 'running') {
    // The runner republishes trace.json whole after each step, so its steps so far read live.
    const pendingTrace = readJson(path.join(dir, 'trace.json'), errors);
    const model = createEvidenceReviewModel({
      context: 'artifact',
      // runFacts already reported an unreadable recipe.json.
      criteria: declaredCriteria(dir, []),
      evidencePending: true,
      ...(pendingTrace === undefined ? {} : { pendingTrace }),
      readErrors: errors,
    });
    return runEvidenceView(model, run);
  }
  const read = await readRecordedEvidencePackage(dir);
  const comparisonSnapshot = recordedComparisonSnapshot(dir, read.input, errors);
  const model = createEvidenceReviewModel({
    context: 'artifact',
    package: read.input,
    ...(comparisonSnapshot ? { comparisonSnapshot } : {}),
    readErrors: [
      ...errors,
      ...read.checks.filter((check) => check.status === 'fail').map((c) => c.message),
    ],
  });
  return runEvidenceView(model, run);
}

function newestWriteMs(dir: string): number {
  let newest = 0;
  for (const name of fs.readdirSync(dir)) {
    const stat = fs.statSync(path.join(dir, name), { throwIfNoEntry: false });
    if (stat && stat.mtimeMs > newest) newest = stat.mtimeMs;
  }
  return newest;
}

/** The run folders directly inside `root`, newest first. */
export function listRunEvidenceHistory(root: string): RunEvidenceHistoryEntry[] {
  const dir = path.resolve(root);
  const entries = fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && isRecipeRunFolder(path.join(dir, entry.name)))
    .map((entry) => {
      const runDir = path.join(dir, entry.name);
      const { id, title, status, startedAt } = runFacts(runDir).run;
      return {
        id,
        ...(title ? { title } : {}),
        status,
        ...(startedAt ? { startedAt } : {}),
        updatedAt: new Date(newestWriteMs(runDir)).toISOString(),
      };
    });
  return entries.sort((a, b) =>
    (b.startedAt ?? b.updatedAt).localeCompare(a.startedAt ?? a.updatedAt),
  );
}

/**
 * Changes whenever a file the page shows is added, grows or is rewritten: the top-level
 * entries of `dir` and of its immediate subfolders.
 */
export function runEvidenceSignature(dir: string): string {
  const parts: string[] = [];
  const visit = (folder: string, prefix: string, depth: number) => {
    for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
      const file = path.join(folder, entry.name);
      const stat = fs.statSync(file, { throwIfNoEntry: false });
      if (!stat) continue;
      parts.push(`${prefix}${entry.name}:${stat.size}:${Math.trunc(stat.mtimeMs)}`);
      if (entry.isDirectory() && depth > 0) visit(file, `${prefix}${entry.name}/`, depth - 1);
    }
  };
  visit(path.resolve(dir), '', 1);
  return createHash('sha256').update(parts.sort().join('|')).digest('hex').slice(0, 16);
}

/** The command a run's end prints to open its evidence page; null when the host has none or
 * the project opts out. */
export function runEvidenceViewHint(
  artifactsDir: string,
  viewer = harnessContext()?.project?.viewer,
  command = harnessHost().viewCommand,
): string | null {
  if (!command || viewer?.link === false) return null;
  return `${command} ${shellQuoteArg(artifactsDir)}`;
}
