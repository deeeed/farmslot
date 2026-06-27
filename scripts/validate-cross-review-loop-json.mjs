#!/usr/bin/env node
/**
 * Minimal validator for CROSS-REVIEW-LOOP.json against the repo schema.
 * Usage: node scripts/validate-cross-review-loop-json.mjs <file> [file...]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCHEMA_PATH = path.join(
  ROOT,
  '.agents/skills/fs-cross-review-loop/templates/CROSS-REVIEW-LOOP.schema.json',
);

const FINAL_VERDICTS = new Set(['pending', 'clean', 'escalated']);
const STATUSES = new Set(['running', 'clean', 'escalated']);
const VERDICTS = new Set(['PASS', 'ISSUES']);
const SEVERITIES = new Set(['P0', 'P1', 'P2', 'P3', 'nit', 'style-only']);

function fail(msg) {
  console.error(`validate-cross-review-loop: ${msg}`);
  process.exitCode = 1;
}

function isObj(v) {
  return v != null && typeof v === 'object' && !Array.isArray(v);
}

function validateReviewer(r, ctx) {
  if (!isObj(r)) return fail(`${ctx}: reviewer must be object`);
  for (const k of ['id', 'label', 'runnerType', 'paneId']) {
    if (!(k in r)) return fail(`${ctx}: missing reviewer.${k}`);
  }
  if (typeof r.id !== 'string' || !r.id) return fail(`${ctx}: reviewer.id required`);
  if (typeof r.label !== 'string' || !r.label) return fail(`${ctx}: reviewer.label required`);
}

function validateFinding(f, ctx) {
  if (!isObj(f)) return fail(`${ctx}: finding must be object`);
  for (const k of ['reviewerId', 'severity', 'reference', 'finding']) {
    if (!(k in f)) return fail(`${ctx}: missing finding.${k}`);
  }
  if (!SEVERITIES.has(f.severity)) return fail(`${ctx}: invalid severity ${f.severity}`);
  if (typeof f.finding !== 'string' || !f.finding) return fail(`${ctx}: finding text required`);
}

function validateReviewerVerdict(v, ctx) {
  if (!isObj(v)) return fail(`${ctx}: reviewerVerdict must be object`);
  for (const k of [
    'reviewerId',
    'verdict',
    'blockingCount',
    'evidenceReview',
    'validationReview',
    'outputArtifact',
  ]) {
    if (!(k in v)) return fail(`${ctx}: missing reviewerVerdict.${k}`);
  }
  if (!VERDICTS.has(v.verdict)) return fail(`${ctx}: invalid verdict ${v.verdict}`);
  if (typeof v.blockingCount !== 'number' || v.blockingCount < 0) {
    return fail(`${ctx}: blockingCount must be >= 0`);
  }
}

function validateCycleRecord(c, ctx) {
  if (!isObj(c)) return fail(`${ctx}: cycleRecord must be object`);
  for (const k of [
    'cycle',
    'startedAt',
    'workerReadySignal',
    'reviewerVerdicts',
    'findingsSentToWorker',
    'workerFixSummary',
    'validationSummary',
    'completedAt',
  ]) {
    if (!(k in c)) return fail(`${ctx}: missing cycleRecord.${k}`);
  }
  if (!Array.isArray(c.reviewerVerdicts)) return fail(`${ctx}: reviewerVerdicts must be array`);
  c.reviewerVerdicts.forEach((v, i) => validateReviewerVerdict(v, `${ctx}.reviewerVerdicts[${i}]`));
  if (!Array.isArray(c.findingsSentToWorker)) return fail(`${ctx}: findingsSentToWorker must be array`);
  c.findingsSentToWorker.forEach((f, i) => validateFinding(f, `${ctx}.findingsSentToWorker[${i}]`));
}

function validateFile(filePath) {
  let doc;
  try {
    doc = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    return fail(`${filePath}: invalid JSON: ${(error).message}`);
  }
  if (!isObj(doc)) return fail(`${filePath}: root must be object`);

  for (const k of [
    'status',
    'startedAt',
    'updatedAt',
    'task',
    'artifactDir',
    'maxCycles',
    'cycles',
    'requiredReviewers',
    'optionalReviewers',
    'blockingFindingsOpen',
    'finalVerdict',
    'stopReason',
    'cycleRecords',
  ]) {
    if (!(k in doc)) return fail(`${filePath}: missing required field ${k}`);
  }

  if (!STATUSES.has(doc.status)) return fail(`${filePath}: invalid status ${doc.status}`);
  if (!FINAL_VERDICTS.has(doc.finalVerdict)) return fail(`${filePath}: invalid finalVerdict`);
  if (typeof doc.maxCycles !== 'number' || doc.maxCycles < 1) {
    return fail(`${filePath}: maxCycles must be >= 1`);
  }
  if (typeof doc.cycles !== 'number' || doc.cycles < 0) return fail(`${filePath}: cycles invalid`);
  if (typeof doc.blockingFindingsOpen !== 'number' || doc.blockingFindingsOpen < 0) {
    return fail(`${filePath}: blockingFindingsOpen invalid`);
  }
  if (!Array.isArray(doc.requiredReviewers) || doc.requiredReviewers.length < 1) {
    return fail(`${filePath}: requiredReviewers must have >= 1 entry`);
  }
  doc.requiredReviewers.forEach((r, i) => validateReviewer(r, `${filePath}.requiredReviewers[${i}]`));
  if (!Array.isArray(doc.optionalReviewers)) return fail(`${filePath}: optionalReviewers must be array`);
  doc.optionalReviewers.forEach((r, i) => validateReviewer(r, `${filePath}.optionalReviewers[${i}]`));
  if (!Array.isArray(doc.cycleRecords)) return fail(`${filePath}: cycleRecords must be array`);
  doc.cycleRecords.forEach((c, i) => validateCycleRecord(c, `${filePath}.cycleRecords[${i}]`));

  if (!fs.existsSync(SCHEMA_PATH)) return fail(`schema missing: ${SCHEMA_PATH}`);
  console.log(`ok ${filePath}`);
}

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error('Usage: validate-cross-review-loop-json.mjs <file> [file...]');
  process.exit(1);
}
for (const file of files) validateFile(path.resolve(file));
if (process.exitCode) process.exit(process.exitCode);