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
    // The issues-verdict floor alone, and a lowercase stricter recommendation.
    ['issues', 'nit', 'APPROVE', 'COMMENT'],
    ['pass', 'minor', 'request_changes', 'REQUEST_CHANGES'],
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
  const dir = path.join(farmslotRoot(), 'projects', project);
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

test('round-nine APPROVE retains its minor as a non-blocking follow-up', () => {
  const result = parseStructuredReviewFeedback(
    JSON.stringify({
      schemaVersion: 1,
      verdict: 'pass',
      recommendation: 'APPROVE',
      issues: [issue],
    }),
    'review-result.json',
    undefined,
    undefined,
    9,
  );
  assert.equal(result.verdict, 'pass');
  assert.equal(result.recommendation, 'APPROVE');
  assert.deepEqual(result.issues, [issue]);
});

test('only admitted round-3+ advisories relax verdicts; malformed and serious findings stay strict', () => {
  const parse = (
    round: number | undefined,
    severity: string | undefined,
    verdict = 'issues',
    recommendation = 'COMMENT',
  ) =>
    parseStructuredReviewFeedback(
      JSON.stringify({
        schemaVersion: 1,
        verdict,
        recommendation,
        reviewRound: 9,
        issues: Array.from({ length: 5 }, () => ({ ...issue, severity })),
      }),
      'review-result.json',
      undefined,
      undefined,
      round,
    );
  for (const round of [undefined, 1, 2]) {
    assert.equal(parse(round, 'minor').verdict, 'issues');
    assert.equal(parse(round, 'nit').verdict, 'issues');
  }
  for (const round of [3, 9]) {
    for (const severity of ['minor', 'nit']) {
      for (const recommendation of ['APPROVE', 'COMMENT', 'REQUEST_CHANGES']) {
        const result = parse(round, severity, 'issues', recommendation);
        assert.equal(result.verdict, 'pass');
        assert.equal(result.recommendation, 'APPROVE');
        assert.equal(result.issues.length, 5);
        assert.equal(result.recommendationCorrection?.read, 'APPROVE');
      }
    }
    for (const severity of ['major', 'blocker', undefined])
      assert.equal(parse(round, severity, 'pass', 'APPROVE').verdict, 'issues');
    for (const severity of ['invalid', 'minor'])
      assert.equal(parse(round, severity, 'pass', 'LGTM').incomplete, true);
    const result = parseStructuredReviewFeedback(
      JSON.stringify({
        schemaVersion: 1,
        verdict: 'pass',
        recommendation: 'APPROVE',
        issues: [issue],
      }),
      'review-result.json',
      undefined,
      [{ ...issue, severity: 'major' }],
      round,
    );
    assert.equal(result.incomplete, true);
  }
});
