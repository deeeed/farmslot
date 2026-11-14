import { createTwoFilesPatch, formatPatch, parsePatch } from 'diff';

import type {
  EvalBenchComparison,
  EvalBenchComparisonGetParams,
  EvalBenchCriterion,
  EvalBenchDiffFile,
  EvalBenchFinding,
  EvalBenchPatch,
  EvalBenchTrialDetail,
} from '@farmslot/protocol';

import { GatewayMethodError } from '../core/method-error.js';

import {
  benchOptionalString as text,
  benchRecord as record,
  readBenchSource,
  readBenchText,
  readEvalBench,
  resolveBenchRoot,
} from './bench-store.js';

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

export function benchDiffFiles(patch: string): EvalBenchDiffFile[] {
  let parsed: ReturnType<typeof parsePatch>;
  try {
    parsed = parsePatch(patch);
  } catch {
    throw new GatewayMethodError(
      'BENCHMARK_SOURCE_INVALID',
      'Retained unified patch cannot be parsed',
    );
  }
  return parsed.map((file) => {
    const name =
      (file.newFileName === '/dev/null' ? file.oldFileName : file.newFileName) ??
      file.index ??
      'Unknown file';
    const filePath = name.replace(/^[ab]\//, '');
    const lines = file.hunks.flatMap((hunk) => hunk.lines);
    const test =
      /(^|\/)(__tests__|tests?|specs?)(\/|$)|\.(test|spec)\.[^/]+$|_test\.[^/]+$|(^|\/)test_[^/]+$/.test(
        filePath,
      );
    return {
      path: filePath,
      additions: lines.filter((line) => line.startsWith('+')).length,
      deletions: lines.filter((line) => line.startsWith('-')).length,
      text: formatPatch(file),
      kind: test ? 'test' : /\.(md|txt|json|ya?ml|lock)$/.test(filePath) ? 'other' : 'code',
    };
  });
}

async function optionalSource<T>(read: () => Promise<T>) {
  try {
    return await read();
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
    throw error;
  }
}
async function patchSource(root: string, file: string): Promise<EvalBenchPatch> {
  const source = await optionalSource(() => readBenchText(root, file));
  if (!source)
    return {
      text: null,
      sha256: null,
      files: [],
      totals: null,
      missingReason: 'Retained patch not available',
    };
  const files = benchDiffFiles(source.text);
  if (source.text.trim() && !files.length)
    return {
      text: null,
      sha256: source.sha256,
      files: [],
      totals: null,
      missingReason: 'Retained artifact is not a parseable unified patch',
    };
  const totals = { additions: 0, deletions: 0, codeLines: 0, testLines: 0, otherLines: 0 };
  for (const file of files) {
    totals.additions += file.additions;
    totals.deletions += file.deletions;
    if (file.kind === 'code') totals.codeLines += file.additions + file.deletions;
    else if (file.kind === 'test') totals.testLines += file.additions + file.deletions;
    else totals.otherLines += file.additions + file.deletions;
  }
  return { text: source.text, sha256: source.sha256, files, totals, missingReason: null };
}
function findings(value: unknown): EvalBenchFinding[] {
  return (Array.isArray(value) ? value : []).map((entry) => {
    const v = record(entry, 'finding');
    return {
      severity: text(v.severity) ?? 'Unclassified',
      text: text(v.text) ?? '',
      cause: text(v.cause),
      evidence: text(v.evidence),
      sharedWithOriginal: typeof v.sharedWithOriginal === 'boolean' ? v.sharedWithOriginal : null,
    };
  });
}
function criteria(value: unknown): EvalBenchCriterion[] {
  const status = record(value, 'acceptance ledger');
  if (status.schemaVersion !== 2 || !Array.isArray(status.criteria))
    throw new Error('Unsupported retained acceptance ledger');
  return status.criteria.map((entry) => {
    const v = record(entry, 'criterion');
    return {
      id: text(v.id) ?? '',
      text: text(v.text) ?? '',
      verdict: text(v.verdict) ?? 'unproven',
      evidence: strings(v.evidence),
      proofMode: text(v.proofMode),
      timing: text(v.timing),
    };
  });
}

export async function readEvalBenchComparison(
  params: EvalBenchComparisonGetParams,
  rootPath = process.env.FARMSLOT_EVAL_DATASET_ROOT,
): Promise<EvalBenchComparison> {
  if (
    !Array.isArray(params?.runIds) ||
    params.runIds.length < 1 ||
    params.runIds.length > 2 ||
    params.runIds.some((id) => typeof id !== 'string') ||
    new Set(params.runIds).size !== params.runIds.length
  )
    throw new Error('Select one or two distinct benchmark trials');
  if (!rootPath) throw new Error('No benchmark dataset configured');
  const summary = await readEvalBench(rootPath);
  const selected = params.runIds.map((id) => {
    const trial = summary.trials.find((t) => t.runId === id);
    if (!trial) throw new Error('Selected trial is not in this benchmark');
    return trial;
  });
  const first = selected[0];
  if (
    selected.some(
      (t) =>
        t.dataset !== first.dataset ||
        t.item !== first.item ||
        t.problemType !== first.problemType ||
        JSON.stringify(t.reference) !== JSON.stringify(first.reference),
    )
  )
    throw new Error('Select trials of the same case and pinned reference');
  const root = await resolveBenchRoot(rootPath);
  const index = record((await readBenchSource(root, 'trial-records/index.json')).value, 'index');
  if (!Array.isArray(index.trials)) throw new Error('Invalid benchmark index');
  const originalPatch = first.reference.head
    ? await patchSource(root, `refs/${first.item}-prereview.diff`)
    : {
        text: null,
        sha256: null,
        files: [],
        totals: null,
        missingReason: 'Pre-review original unavailable',
      };
  const trials: EvalBenchTrialDetail[] = [];
  for (const trial of selected) {
    const indexEntry = index.trials
      .map((entry) => record(entry, 'index row'))
      .find((r) => r.runId === trial.runId);
    if (!indexEntry || typeof indexEntry.file !== 'string')
      throw new Error('Selected benchmark record disappeared');
    const rawSource = await readBenchSource(root, indexEntry.file);
    if (rawSource.sha256 !== trial.sourceSha256)
      throw new Error('Benchmark record changed while reading; refresh the comparison');
    const raw = record(rawSource.value, 'trial');
    const outcome = record(raw.outcome, 'outcome');
    const arm = record(raw.arm, 'arm');
    const merged = outcome.vsMerged == null ? {} : record(outcome.vsMerged, 'merged judgment');
    const judged =
      outcome.vsPrereview == null ? {} : record(outcome.vsPrereview, 'original judgment');
    const worker = `workers/worker-${trial.runId.slice(0, 8)}`;
    const patch = await patchSource(root, `${worker}/diff-vs-base.patch`);
    const metrics = await optionalSource(() => readBenchSource(root, `${worker}/metrics.json`));
    const candidateBase = metrics ? text(record(metrics.value, 'worker metrics').blindBase) : null;
    const metricRun = metrics ? text(record(metrics.value, 'worker metrics').runId) : null;
    if (metricRun && metricRun !== trial.runId)
      throw new Error('Retained worker artifact belongs to a different trial');
    const sameBase =
      metricRun === trial.runId &&
      !!candidateBase &&
      /^[0-9a-f]{7,40}$/i.test(first.reference.base) &&
      /^[0-9a-f]{40}$/i.test(candidateBase) &&
      candidateBase.startsWith(first.reference.base);
    const ledger = await optionalSource(() =>
      readBenchSource(root, `${worker}/task/artifacts/acceptance-status.json`),
    );
    const redFirst = outcome.redFirst == null ? null : record(outcome.redFirst, 'baseline proof');
    const refFiles = new Set(originalPatch.files.map((f) => f.path));
    const candidateFiles = new Set(patch.files.map((f) => f.path));
    trials.push({
      trial,
      patch,
      candidateBase,
      diffOfDiffs:
        sameBase && originalPatch.text !== null && patch.text !== null
          ? createTwoFilesPatch(
              'pre-review-original.patch',
              `${trial.runId}.patch`,
              originalPatch.text,
              patch.text,
            )
          : null,
      fileComparisons: [...new Set([...refFiles, ...candidateFiles])].map((file) => ({
        path: file,
        diffOfDiffs:
          sameBase && originalPatch.text !== null && patch.text !== null
            ? createTwoFilesPatch(
                'pre-review-original.patch',
                `${trial.runId}.patch`,
                originalPatch.files.find((f) => f.path === file)?.text ?? '',
                patch.files.find((f) => f.path === file)?.text ?? '',
              )
            : null,
        note: !sameBase
          ? 'Candidate and original bases are not verified equal.'
          : originalPatch.text === null || patch.text === null
            ? 'Both retained patches are required.'
            : null,
      })),
      comparisonNote: !sameBase
        ? 'Candidate and original bases are not verified equal; no diff-of-diffs is computed.'
        : originalPatch.text === null || patch.text === null
          ? 'Both retained patches are required for diff-of-diffs.'
          : null,
      extraFiles:
        originalPatch.text === null || patch.text === null
          ? []
          : [...candidateFiles].filter((f) => !refFiles.has(f)),
      missingFiles:
        originalPatch.text === null || patch.text === null
          ? []
          : [...refFiles].filter((f) => !candidateFiles.has(f)),
      criteria: ledger ? criteria(ledger.value) : [],
      coverageNote: ledger ? null : 'Retained acceptance ledger unavailable',
      acClaim: text(judged.acsMet),
      template: text(arm.template),
      originalGaps: strings(judged.gaps),
      aheadOfOriginal: strings(judged.aheadOfReference),
      mergedGaps: strings(merged.gaps),
      fixedByOriginalReview: strings(merged.gapsFixedByReviewInOriginal),
      findings: findings(outcome.findings),
      driftNotes: strings(outcome.driftNotes),
      gate: text(outcome.gate),
      redFirst: redFirst
        ? {
            tests: typeof redFirst.tests === 'boolean' ? redFirst.tests : null,
            recipe: typeof redFirst.recipe === 'boolean' ? redFirst.recipe : null,
            how: text(redFirst.how),
          }
        : null,
    });
  }
  return {
    capturedAt: new Date().toISOString(),
    dataset: first.dataset,
    item: first.item,
    reference: first.reference,
    original: first.original,
    originalPatch,
    trials,
  };
}
