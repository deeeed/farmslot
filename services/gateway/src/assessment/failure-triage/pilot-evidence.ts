import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { corpusIntegrityPassed } from './corpus-integrity.js';
import { CORPORA } from './corpus-lock.js';
import { triageGate, triageMetrics } from './metrics.js';
import { RUBRIC_VERSION, textDigest } from './packet.js';
import type { TriageCorpus, TriageResult } from './types.js';

/** Exact receipts from one reviewed experiment. Admitting another requires a reviewed source change. */
export const TRIAGE_PILOT_RECEIPT_HASH =
  'afe213b7c88ed4e0b2a9d432144c9f8417f4cddfa778a0f48a766e09b5ca8862';

export async function verifyTriagePilotEvidence(directory: string) {
  const manifestBytes = await readFile(path.join(directory, 'receipt-manifest.json'), 'utf8');
  if (textDigest(manifestBytes) !== TRIAGE_PILOT_RECEIPT_HASH)
    throw new Error('Unapproved triage evaluation receipt');
  // The exact-byte hash admits this schema and its fixed local filenames.
  const manifest = JSON.parse(manifestBytes) as {
    sourceRevision: string;
    files: Record<string, string>;
  };
  const files: Record<string, string> = {};
  for (const [name, expected] of Object.entries(manifest.files)) {
    const bytes = await readFile(path.join(directory, name), 'utf8');
    if (textDigest(bytes) !== expected) throw new Error('Changed triage evaluation artifact');
    files[name] = bytes;
  }
  const corpus = JSON.parse(files['corpus-manifest.json']) as TriageCorpus & { corpusHash: string };
  const candidate = JSON.parse(files['candidate-results.json']) as TriageResult[];
  const baselines = JSON.parse(files['baseline-results.json']) as {
    deterministic: TriageResult[];
    cueSheet: TriageResult[];
  };
  const report = JSON.parse(files['evaluation.json']) as {
    corpusHash: string;
    rubricVersion: string;
    provider: string;
    requestedModel: string;
    liveStatus: string;
    safetyViolations: number;
    decision: string;
    usage: { attempts: number; reservedUsd: number; limits: { maxCalls: number; maxUsd: number } };
  };
  const run = JSON.parse(files['run.json']) as { mode: string; status: string };
  const source = JSON.parse(files['source-manifest.json']) as {
    revision: string;
    dirty: boolean;
    sourceSnapshotHash: string;
  };
  if (
    corpus.corpusHash !== CORPORA.v2.hash ||
    report.corpusHash !== corpus.corpusHash ||
    report.rubricVersion !== RUBRIC_VERSION ||
    source.revision !== manifest.sourceRevision ||
    source.dirty ||
    run.mode !== 'live' ||
    run.status !== 'completed'
  )
    throw new Error('Incompatible triage evaluation provenance');
  const cases = corpus.cases.filter((c) => c.split === 'held-out');
  const gate = triageGate({
    liveStatus: report.liveStatus,
    corpusIntegrityPassed: corpusIntegrityPassed(corpus.corpusHash),
    metrics: triageMetrics(cases, candidate, corpus.cases),
    baseline: triageMetrics(cases, baselines.deterministic, corpus.cases),
    cueSheet: triageMetrics(cases, baselines.cueSheet, corpus.cases),
    violations: report.safetyViolations,
    withinBudget:
      report.usage.attempts <= Math.min(60, report.usage.limits.maxCalls) &&
      report.usage.reservedUsd <= Math.min(0.1, report.usage.limits.maxUsd),
  });
  if (!gate.eligible || report.decision !== 'pilot')
    throw new Error('Triage pilot prerequisite failed');
  return {
    receiptHash: TRIAGE_PILOT_RECEIPT_HASH,
    corpusHash: corpus.corpusHash,
    sourceRevision: source.revision,
    sourceSnapshotHash: source.sourceSnapshotHash,
    provider: report.provider,
    model: report.requestedModel,
    rubricVersion: report.rubricVersion,
    gate,
    efficiencyClaim: 'not_established' as const,
  };
}
