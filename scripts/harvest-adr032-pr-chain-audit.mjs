#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

import {
  assertPreMergeReview,
  hasPreMergeGhApprove,
  requiredChecksGreen,
  reviewTimingForPr,
} from './lib/adr032-pr-chain-validate.mjs';

const [, , rawPath, mainSha, evidenceDir, outPath] = process.argv;
if (!rawPath || !mainSha || !evidenceDir || !outPath) {
  console.error('Usage: harvest-adr032-pr-chain-audit.mjs <raw> <mainSha> <evidenceDir> <outPath>');
  process.exit(1);
}

const raw = fs.readFileSync(rawPath, 'utf8');
const chunks = raw.split('---\n').map((c) => c.trim()).filter(Boolean);
if (chunks.length !== 6) {
  console.error('pr-chain-audit: expected 6 gh pr view payloads, got', chunks.length);
  process.exit(1);
}

const prs = chunks.map((c) => JSON.parse(c));
for (const p of prs) {
  const result = assertPreMergeReview(p, evidenceDir);
  if (!result.ok) {
    console.error(result.error);
    process.exit(1);
  }
}

const integrity = [];
for (const p of prs) {
  const timing = reviewTimingForPr(p, evidenceDir);
  const premergePath = path.join(evidenceDir, `pr${p.number}-premerge.json`);
  const premerge = fs.existsSync(premergePath)
    ? JSON.parse(fs.readFileSync(premergePath, 'utf8'))
    : null;
  integrity.push({
    number: p.number,
    mergedAt: p.mergedAt,
    reviewTiming: timing,
    preMergeGhApprove: hasPreMergeGhApprove(p),
    premergeCaptured: premerge != null,
    mergeTimeCiGreen: premerge
      ? requiredChecksGreen(premerge.statusCheckRollup, p.mergedAt).greenAtDecision
      : null,
  });
}

const out = {
  harvestedAt: new Date().toISOString(),
  mainSha,
  integrity,
  prs: prs.map((p) => {
    const timing = reviewTimingForPr(p, evidenceDir);
    return {
      ...p,
      crossReviewArtifact: path.join(evidenceDir, `pr${p.number}-CROSS-REVIEW-LOOP.json`),
      reviewTiming: timing,
      postMergeGhApproveOnly: timing === 'post-merge-gh-only',
    };
  }),
};

fs.writeFileSync(outPath, `${JSON.stringify(out, null, 2)}\n`);
console.log('ok pr-chain-audit: pre-merge review timing validated for PRs 81-86');