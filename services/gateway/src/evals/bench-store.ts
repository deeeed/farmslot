import { createHash } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

import {
  type EvalBenchOriginal,
  type EvalBenchResult,
  evalBenchRollups,
  type EvalBenchTrial,
  type EvalBenchUsage,
  isRecord,
} from '@farmslot/protocol';

function record(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`Invalid benchmark ${label}`);
  return value;
}
function string(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`Invalid benchmark ${label}`);
  return value;
}
function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}
function number(value: unknown): number | null {
  if (value == null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0)
    throw new Error('Invalid benchmark metric');
  return value;
}
function usage(value: unknown): EvalBenchUsage {
  const v = record(value, 'usage');
  return {
    inputTokens: number(v.inputTokens),
    outputTokens: number(v.outputTokens),
    cacheReadTokens: number(v.cacheReadTokens),
    cacheWriteTokens: number(v.cacheWriteTokens),
    reasoningTokens: number(v.reasoningTokens),
    costUsd: number(v.costUsd),
    costNote: optionalString(v.costNote),
    turns: number(v.turns),
    wallMinutes: number(v.wallMinutes),
  };
}

/** The operator selects one root; callers cannot supply a filesystem path. */
async function source(root: string, file: string) {
  const resolved = await realpath(path.resolve(root, file));
  const relative = path.relative(root, resolved);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative))
    throw new Error('Benchmark source escapes the configured dataset');
  if ((await stat(resolved)).size > 4 * 1024 * 1024)
    throw new Error('Benchmark record exceeds 4 MiB');
  const text = await readFile(resolved, 'utf8');
  const value: unknown = JSON.parse(text);
  return { value, sha256: createHash('sha256').update(text).digest('hex') };
}

function original(value: unknown): EvalBenchOriginal {
  const v = record(value, 'original usage');
  const start = Date.parse(string(v.startedAt, 'original usage start'));
  const end = Date.parse(string(v.completedAt, 'original usage end'));
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start)
    throw new Error('Invalid original usage interval');
  return {
    repo: string(v.repo, 'original repo'),
    head: string(v.head, 'original head'),
    runId: string(v.runId, 'original run'),
    model: string(v.model, 'original model'),
    scope: string(v.scope, 'original usage scope'),
    startedAt: string(v.startedAt, 'original usage start'),
    completedAt: string(v.completedAt, 'original usage end'),
    sourceSha256: string(v.sourceSha256, 'original usage provenance'),
    usage: usage(v.usage),
  };
}

export function parseBenchTrial(
  value: unknown,
  sha256: string,
  originals: EvalBenchOriginal[] = [],
): EvalBenchTrial {
  const v = record(value, 'trial');
  if (v.schema !== 'bench-trial/1') throw new Error('Expected bench-trial/1');
  const task = record(v.task, 'task');
  const arm = record(v.arm, 'arm');
  const outcome = record(v.outcome, 'outcome');
  const refs = record(v.reference, 'reference');
  const pre = refs.prereview == null ? {} : record(refs.prereview, 'pre-review original');
  const judgedPre =
    outcome.vsPrereview == null ? {} : record(outcome.vsPrereview, 'original verdict');
  const judgedMerged = outcome.vsMerged == null ? {} : record(outcome.vsMerged, 'merged verdict');
  const repo = string(task.refRepo, 'reference repo');
  const head = optionalString(pre.head) ?? '';
  const matches = originals.filter((o) => o.repo === repo && o.head === head);
  if (matches.length > 1) throw new Error('Ambiguous original usage receipt');
  return {
    runId: string(v.runId, 'run ID'),
    sourceSha256: sha256,
    dataset: string(v.dataset, 'dataset'),
    item: string(task.item, 'item'),
    problemType: string(task.profile, 'problem type'),
    area: string(task.area, 'area'),
    sizeClass: string(task.sizeClass, 'size'),
    model: string(arm.model, 'model'),
    modelId: string(arm.modelId, 'model ID'),
    route: string(arm.route, 'route'),
    effort: string(arm.effort, 'effort'),
    reference: { repo, base: optionalString(pre.base) ?? '', head, pr: number(task.refPr) },
    verdict: optionalString(judgedPre.verdict),
    verdictVsMerged: optionalString(judgedMerged.verdict),
    mergeable: optionalString(judgedPre.mergeable),
    unscored: optionalString(outcome.unscored),
    usage: usage(v.usage),
    original: matches[0] ?? null,
  };
}

export async function readEvalBench(
  rootPath = process.env.FARMSLOT_EVAL_DATASET_ROOT,
): Promise<EvalBenchResult> {
  if (!rootPath)
    return { configured: false, dataset: null, trials: [], rollups: [], infraFailures: [] };
  const root = await realpath(rootPath);
  const index = record((await source(root, 'trial-records/index.json')).value, 'index');
  if (
    index.schema !== 'bench-trial-index/1' ||
    !Array.isArray(index.trials) ||
    index.trials.length > 1000
  )
    throw new Error('Invalid benchmark index');
  let originals: EvalBenchOriginal[] = [];
  try {
    const receipts = record(
      (await source(root, 'reference-usage.json')).value,
      'original usage receipts',
    );
    if (receipts.schema !== 'bench-reference-usage/1' || !Array.isArray(receipts.originals))
      throw new Error('Invalid original usage receipts');
    originals = receipts.originals.map(original);
  } catch (error) {
    // Older datasets have no original-run usage capture. Missing is never $0.
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
  }
  const trials: EvalBenchTrial[] = [];
  for (const entry of index.trials) {
    const row = record(entry, 'index row');
    const data = await source(root, string(row.file, 'record file'));
    const trial = parseBenchTrial(data.value, data.sha256, originals);
    if (trial.runId !== row.runId) throw new Error('Benchmark index and record run IDs differ');
    if (trials.some((t) => t.runId === trial.runId)) throw new Error('Duplicate benchmark run');
    trials.push(trial);
  }
  const datasets = new Set(trials.map((t) => t.dataset));
  if (datasets.size > 1) throw new Error('Benchmark index mixes datasets');
  const infraFailures = (Array.isArray(index.infraFailures) ? index.infraFailures : []).map(
    (entry) => {
      const v = record(entry, 'infrastructure failure');
      return {
        runId: string(v.runId, 'failed run'),
        item: string(v.item, 'failed item'),
        failedStep: string(v.failedStep, 'failed step'),
        error: string(v.error, 'failure reason'),
      };
    },
  );
  return {
    configured: true,
    dataset: trials[0]?.dataset ?? null,
    trials,
    rollups: evalBenchRollups(trials),
    infraFailures,
  };
}
