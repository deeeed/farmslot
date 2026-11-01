import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import type { ReviewIssue } from '@farmslot/protocol';
import { invalidateProjectVarsCache } from '@farmslot/slot-config';

import { farmslotRoot } from '../core/config.js';

import { loadReviewApprovalPolicy } from './approval-policy.js';
import { parseStructuredReviewFeedback } from './feedback.js';

const issue = { file: 'src/a.ts', line: 1, description: 'Incorrect value', severity: 'minor' };

test('paired review results cannot approve a minor or hide a defect in a pass verdict', () => {
  const parse = (
    verdict: string,
    severity: string,
    recommendation?: string,
    additionalIssues?: ReviewIssue[],
  ) =>
    parseStructuredReviewFeedback(
      JSON.stringify({
        schemaVersion: 1,
        verdict,
        issues: [{ ...issue, severity }],
        ...(recommendation === undefined ? {} : { recommendation }),
      }),
      'review-result.json',
      undefined,
      additionalIssues,
    );
  // A conflict reads at the strictest of the policy's verdict, the reviewer's own recommendation
  // and, for an issues verdict, COMMENT (ba397e2c: pass/APPROVE with minor findings). It keeps
  // the findings and never approves them.
  for (const [verdict, severity, recommendation, read] of [
    ['pass', 'minor', 'APPROVE', 'COMMENT'],
    ['issues', 'minor', 'APPROVE', 'COMMENT'],
    ['pass', 'minor', undefined, 'COMMENT'],
    ['pass', 'minor', 'approve', 'COMMENT'],
    ['pass', 'minor', 'LGTM', 'COMMENT'],
    ['pass', 'major', 'COMMENT', 'REQUEST_CHANGES'],
    ['issues', 'blocker', 'COMMENT', 'REQUEST_CHANGES'],
    ['pass', 'minor', 'REQUEST_CHANGES', 'REQUEST_CHANGES'],
    ['issues', 'minor', 'REQUEST_CHANGES', 'REQUEST_CHANGES'],
    ['issues', 'nit', 'COMMENT', 'COMMENT'],
  ] as const)
    assert.deepEqual(parse(verdict, severity, recommendation), {
      verdict: 'issues',
      issues: [{ ...issue, severity }],
      recommendation: read,
      recommendationCorrection: {
        verdict,
        ...(recommendation === undefined ? {} : { recommendation }),
        read,
      },
    });
  // Consistent results read as they are.
  assert.equal(parse('issues', 'minor', 'COMMENT').recommendationCorrection, undefined);
  assert.equal(parse('issues', 'major', 'REQUEST_CHANGES').recommendation, 'REQUEST_CHANGES');
  assert.equal(parse('pass', 'nit', 'APPROVE').verdict, 'pass');
  // Nothing reads as an approval, and line comments from elsewhere still refuse.
  assert.equal(parse('pass', 'nit', 'LGTM').incomplete, true);
  assert.equal(parse('pass', 'minor', 'APPROVE', []).incomplete, true);
});

test('policy changes are read without restarting or waiting for the project cache', async (t) => {
  const project = `approval-policy-${process.pid}`;
  const dir = path.join(farmslotRoot, 'projects', project);
  await mkdir(dir, { recursive: true });
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
    invalidateProjectVarsCache(project);
  });
  const file = path.join(dir, 'project.json');
  await writeFile(file, JSON.stringify({ name: project, approvalPolicy: { maxNits: 3 } }));
  assert.equal((await loadReviewApprovalPolicy(project)).maxNits, 3);
  await writeFile(file, JSON.stringify({ name: project, approvalPolicy: { maxNits: 0 } }));
  assert.equal((await loadReviewApprovalPolicy(project)).maxNits, 0);
  await writeFile(file, JSON.stringify({ name: project, approvalPolicy: { maxNits: -1 } }));
  await assert.rejects(loadReviewApprovalPolicy(project), /Invalid approvalPolicy/);
});

test('legacy advisory line comments participate in policy before a stale gate can keep approval', () => {
  const raw = JSON.stringify({
    schemaVersion: 1,
    verdict: 'pass',
    issues: [],
    recommendation: 'APPROVE',
  });
  for (const [severity, expected] of [
    ['minor', 'COMMENT'],
    ['major', 'REQUEST_CHANGES'],
  ] as const) {
    const result = parseStructuredReviewFeedback(raw, 'review-result.json', undefined, [
      { ...issue, severity },
    ]);
    assert.equal(result.incomplete, true);
    assert.equal(result.recommendation, expected);
  }
});
