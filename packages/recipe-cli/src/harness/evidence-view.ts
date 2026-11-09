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
import { type AcceptanceCriterionRef, isRecord } from '@farmslot/protocol';
import { readRecordedEvidencePackage } from '@farmslot/recipe-runner';

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

function readJson(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

export function isRecipeRunFolder(dir: string): boolean {
  return RUN_MARKERS.some((name) => fs.existsSync(path.join(dir, name)));
}

/** What the folder says about the run without reading its evidence. */
function runFacts(dir: string): RunEvidenceViewRun {
  const summary = readJson(path.join(dir, 'summary.json'));
  const recipe = readJson(path.join(dir, 'recipe.json'));
  const invocation = readJson(path.join(dir, 'recipe-invocation.json'));
  const title = isRecord(recipe) ? (text(recipe.title) ?? text(recipe.description)) : undefined;
  const startedAt =
    (isRecord(summary) ? text(summary.startedAt) : undefined) ??
    (isRecord(invocation) ? text(invocation.startedAt) : undefined);
  const status = !isRecord(summary)
    ? 'running'
    : summary.status === 'pass' || summary.status === 'fail'
      ? summary.status
      : 'unknown';
  return {
    id: path.basename(dir),
    ...(title ? { title } : {}),
    status,
    ...(startedAt ? { startedAt } : {}),
    ...(isRecord(summary) && text(summary.endedAt) ? { endedAt: String(summary.endedAt) } : {}),
    ...(isRecord(summary) && typeof summary.durationMs === 'number'
      ? { durationMs: summary.durationMs }
      : {}),
  };
}

/** A running run lists the criteria its recipe declares, none judged yet. */
function declaredCriteria(dir: string): AcceptanceCriterionRef[] {
  const recipe = readJson(path.join(dir, 'recipe.json'));
  if (!isRecord(recipe) || !Array.isArray(recipe.proofTargets)) return [];
  return recipe.proofTargets.flatMap((target) =>
    isRecord(target) && typeof target.id === 'string'
      ? [{ id: target.id, text: text(target.claim) ?? target.id }]
      : [],
  );
}

/** One run folder as the shared view-model; read-only, media is never opened. */
export async function readRunEvidenceView(runDir: string): Promise<RunEvidenceView> {
  const dir = path.resolve(runDir);
  const run = runFacts(dir);
  if (run.status === 'running') {
    const model = createEvidenceReviewModel({
      context: 'artifact',
      criteria: declaredCriteria(dir),
      evidencePending: true,
    });
    return runEvidenceView(model, run);
  }
  const read = await readRecordedEvidencePackage(dir);
  const model = createEvidenceReviewModel({
    context: 'artifact',
    package: read.input,
    readErrors: read.checks.filter((check) => check.status === 'fail').map((c) => c.message),
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
      const { id, title, status, startedAt } = runFacts(runDir);
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

/** The command a run's end prints to open its evidence page; null when the project opts out. */
export function runEvidenceViewHint(
  artifactsDir: string,
  viewer = harnessContext()?.project?.viewer,
): string | null {
  if (viewer?.link === false) return null;
  return `${harnessHost().viewCommand ?? 'farmslot recipe view'} ${shellQuoteArg(artifactsDir)}`;
}
