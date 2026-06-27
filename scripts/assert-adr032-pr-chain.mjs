#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import {
  assertPreMergeReview,
  requiredChecksGreen,
  reviewTimingForPr,
} from './lib/adr032-pr-chain-validate.mjs';

const [, , evidenceDir, auditPath] = process.argv;
if (!evidenceDir || !auditPath) {
  console.error('Usage: assert-adr032-pr-chain.mjs <evidenceDir> <pr-chain-audit.json>');
  process.exit(1);
}

const audit = JSON.parse(fs.readFileSync(auditPath, 'utf8'));
const expected = [81, 82, 83, 84, 85, 86];
if (!Array.isArray(audit.prs) || audit.prs.length !== expected.length) {
  console.error('pr-chain-audit: expected', expected.length, 'PR entries');
  process.exit(1);
}

for (const pr of audit.prs) {
  if (pr.state !== 'MERGED') {
    console.error('pr-chain-audit: PR', pr.number, 'state', pr.state, '!= MERGED');
    process.exit(1);
  }
  const crossReview = path.join(evidenceDir, `pr${pr.number}-CROSS-REVIEW-LOOP.json`);
  if (!fs.existsSync(crossReview)) {
    console.error('pr-chain-audit: missing', crossReview);
    process.exit(1);
  }
  const result = assertPreMergeReview(pr, evidenceDir);
  if (!result.ok) {
    console.error(result.error);
    process.exit(1);
  }
  if (result.timing === 'post-merge-gh-only') {
    console.error('pr-chain-audit: PR', pr.number, 'must not rely on post-merge GH approve only');
    process.exit(1);
  }
}

const pr81Note = JSON.parse(
  fs.readFileSync(path.join(evidenceDir, 'pr81-merge-timing-note.json'), 'utf8'),
);
if (pr81Note.mergeTimeCiGreen !== true) {
  console.error('pr81-merge-timing-note: mergeTimeCiGreen must be true');
  process.exit(1);
}
const pr81Pre = JSON.parse(fs.readFileSync(path.join(evidenceDir, 'pr81-premerge.json'), 'utf8'));
const pr81Ci = requiredChecksGreen(pr81Pre.statusCheckRollup, pr81Note.mergedAt);
if (!pr81Ci.greenAtDecision) {
  console.error('pr81-premerge: required CI not green at merge decision');
  process.exit(1);
}

const pr82Note = JSON.parse(
  fs.readFileSync(path.join(evidenceDir, 'pr82-merge-timing-note.json'), 'utf8'),
);
if (pr82Note.mergeTimeCiGreen !== false || !pr82Note.processWaiver) {
  console.error('pr82-merge-timing-note: must document mergeTimeCiGreen=false with processWaiver');
  process.exit(1);
}
const pr82Pre = JSON.parse(fs.readFileSync(path.join(evidenceDir, 'pr82-premerge.json'), 'utf8'));
const pr82Ci = requiredChecksGreen(pr82Pre.statusCheckRollup, pr82Note.mergedAt);
if (pr82Ci.greenAtDecision) {
  console.error('pr82-premerge: expected IN_PROGRESS required jobs at merge (not green)');
  process.exit(1);
}

if (!Array.isArray(audit.integrity) || audit.integrity.length !== expected.length) {
  console.error('pr-chain-audit: missing integrity array');
  process.exit(1);
}
for (const row of audit.integrity) {
  if (row.reviewTiming !== 'pre-merge-cross-review' && row.reviewTiming !== 'pre-merge-gh-approve') {
    console.error('integrity: PR', row.number, 'bad reviewTiming', row.reviewTiming);
    process.exit(1);
  }
}

console.log('ok pr-chain-audit: pre-merge review + merge-time CI disclosures validated');