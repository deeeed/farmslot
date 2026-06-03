import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildNoChangeGateInputs,
  isOwnPrApprovalError,
  noChangeDispositionLabel,
  noChangeRejectionMessage,
  shouldForceNoChangeHumanGate,
} from './gate-policy.js';
import { makeRun } from './test-fixtures.js';

test('isOwnPrApprovalError detects GitHub self-approval failures', () => {
  assert.equal(
    isOwnPrApprovalError(
      new Error('GraphQL: Review Can not approve your own pull request (addPullRequestReview)'),
    ),
    true,
  );
  assert.equal(
    isOwnPrApprovalError({ stderr: 'GraphQL: Review cannot approve your own pull request' }),
    true,
  );
  assert.equal(
    isOwnPrApprovalError(new Error('GraphQL: Resource not accessible by integration')),
    false,
  );
});

test('shouldForceNoChangeHumanGate forces only fix-bug no-code dispositions', () => {
  assert.equal(
    shouldForceNoChangeHumanGate(
      makeRun({
        flowType: 'fix-bug',
        metrics: { nudgeCount: 0, model: 'gpt-5.5', runner: 'codex', disposition: 'already_fixed' },
      }),
    ),
    true,
  );
  assert.equal(
    shouldForceNoChangeHumanGate(
      makeRun({
        flowType: 'fix-bug',
        metrics: {
          nudgeCount: 0,
          model: 'gpt-5.5',
          runner: 'codex',
          disposition: 'not_reproducible',
        },
      }),
    ),
    true,
  );
  assert.equal(
    shouldForceNoChangeHumanGate(
      makeRun({
        flowType: 'fix-bug',
        metrics: { nudgeCount: 0, model: 'gpt-5.5', runner: 'codex', disposition: 'fixed' },
      }),
    ),
    false,
  );
  assert.equal(
    shouldForceNoChangeHumanGate(
      makeRun({
        flowType: 'dev',
        metrics: { nudgeCount: 0, model: 'gpt-5.5', runner: 'codex', disposition: 'already_fixed' },
      }),
    ),
    false,
  );
});

test('noChangeDispositionLabel renders operator labels', () => {
  assert.equal(noChangeDispositionLabel('already_fixed'), 'already fixed');
  assert.equal(noChangeDispositionLabel('not_reproducible'), 'not reproducible');
  assert.equal(noChangeDispositionLabel('fixed'), 'fixed');
});

test('buildNoChangeGateInputs renders full evidence into desc + payload', () => {
  const { desc, payload } = buildNoChangeGateInputs({
    disposition: 'already_fixed',
    ticketOrPr: 'EXAMPLE/repo#1234',
    monitorReason: 'Behaviour matches AC on current main',
    evidence: {
      reportPath: 'artifacts/no-change-report.md',
      artifacts: ['artifacts/proof-1.png', 'artifacts/proof-2.png'],
      confidence: 'high',
      reproductionAttempted: true,
      noCodeChange: true,
    },
    report: 'Verified on main @ abc1234. AC1, AC2, AC3 all pass.',
  });

  assert.match(desc, /Worker reported \*\*already fixed\*\* for EXAMPLE\/repo#1234/);
  assert.match(desc, /Worker reason: Behaviour matches AC on current main/);
  assert.match(desc, /- report: `artifacts\/no-change-report\.md`/);
  assert.match(desc, /- artifact: `artifacts\/proof-1\.png`/);
  assert.match(desc, /- artifact: `artifacts\/proof-2\.png`/);
  assert.match(desc, /- confidence: high/);
  assert.match(desc, /- reproduction attempted: yes/);
  assert.match(desc, /Report excerpt:\n\nVerified on main @ abc1234/);

  assert.equal(payload.kind, 'no-change');
  assert.equal(payload.disposition, 'already_fixed');
  assert.equal(payload.reason, 'Behaviour matches AC on current main');
  assert.equal(payload.evidence?.confidence, 'high');
  assert.equal(payload.workerReport, 'Verified on main @ abc1234. AC1, AC2, AC3 all pass.');
});

test('buildNoChangeGateInputs falls back to "none reported" when evidence is absent', () => {
  const { desc, payload } = buildNoChangeGateInputs({
    disposition: 'not_reproducible',
    ticketOrPr: 'JIRA-9001',
  });

  assert.match(desc, /Worker reported \*\*not reproducible\*\* for JIRA-9001/);
  assert.match(desc, /Evidence: none reported\./);
  assert.doesNotMatch(desc, /Worker reason:/);
  assert.doesNotMatch(desc, /Report excerpt:/);
  assert.equal(payload.workerReport, undefined);
  assert.equal(payload.evidence, undefined);
  assert.equal(payload.reason, undefined);
});

test('buildNoChangeGateInputs caps long reports at 600 chars', () => {
  const longReport = 'x'.repeat(2000);
  const { desc } = buildNoChangeGateInputs({
    disposition: 'already_fixed',
    ticketOrPr: 'JIRA-1',
    report: longReport,
  });
  const excerpt = desc.split('Report excerpt:\n\n')[1] ?? '';
  assert.equal(excerpt.length, 600);
});

test('noChangeRejectionMessage formats reject-retry vs mark-blocked', () => {
  assert.equal(
    noChangeRejectionMessage('reject-retry', 'JIRA-42'),
    'No-change result rejected; retry reproduction for JIRA-42',
  );
  assert.equal(
    noChangeRejectionMessage('mark-blocked', 'JIRA-42'),
    'No-change result marked blocked; insufficient evidence for JIRA-42',
  );
});
