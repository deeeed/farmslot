import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  buildFailedStepDiagnosticDraft,
  buildWorkspaceCopilotDraft,
  buildWorkspaceCopilotDraftForRoute,
  workspaceCopilotInputForRoute,
} from './workspace-copilot';

test('buildWorkspaceCopilotDraft includes compact workspace context', () => {
  const draft = buildWorkspaceCopilotDraft({
    current: 'slot',
    slotId: 'runner-mobile-2',
    runId: 'run-1234567890abcdefghijklmnopqrstuvwxyz',
    familyId: 'family-abcdef1234567890',
    prNumber: 30095,
    decisionId: 'decision-abcdef1234567890',
    decisionKind: 'review',
    workspaceFocus: 'ready',
    recipeRunId: 'current-artifacts',
    artifactPath: 'inputs/diff.txt',
  });

  assert.match(draft, /^Inspect the current mobile workspace \(/);
  assert.match(draft, /screen=slot/);
  assert.match(draft, /slot=runner-mobile-2/);
  assert.match(draft, /run=run-1234567890/);
  assert.match(draft, /family=family-abcdef123/);
  assert.match(draft, /PR #30095/);
  assert.match(draft, /decision=decision-abcdef/);
  assert.match(draft, /decisionKind=review/);
  assert.match(draft, /focus=ready/);
  assert.match(draft, /recipe=current-artifacts/);
  assert.match(draft, /artifact=inputs\/diff\.txt/);
  assert.match(draft, /safest next action\.$/);
});

test('buildWorkspaceCopilotDraft works without specific context', () => {
  assert.equal(
    buildWorkspaceCopilotDraft({}),
    'Inspect the current mobile workspace. Summarize what needs attention and propose the safest next action.',
  );
});

test('workspaceCopilotInputForRoute extracts slot detail context', () => {
  assert.deepEqual(
    workspaceCopilotInputForRoute('/slot/runner-mobile-2', {
      id: 'runner-mobile-2',
      runId: 'run-abc',
      recipeRun: 'current-artifacts',
    }),
    {
      current: 'slot',
      familyId: null,
      slotId: 'runner-mobile-2',
      runId: 'run-abc',
      prNumber: null,
      decisionId: null,
      decisionKind: null,
      workspaceFocus: null,
      recipeRunId: 'current-artifacts',
      artifactPath: null,
    },
  );
});

test('workspaceCopilotInputForRoute maps artifact filters to workspace screens', () => {
  assert.deepEqual(
    workspaceCopilotInputForRoute('/artifacts/run-abc', {
      runId: 'run-abc',
      filter: 'visual',
      artifact: 'screens/after.png',
    }),
    {
      current: 'compare',
      familyId: null,
      slotId: null,
      runId: 'run-abc',
      prNumber: null,
      decisionId: null,
      decisionKind: null,
      workspaceFocus: null,
      recipeRunId: null,
      artifactPath: 'screens/after.png',
    },
  );

  assert.match(
    buildWorkspaceCopilotDraftForRoute('/artifacts/run-abc', {
      runId: 'run-abc',
      filter: 'diffs',
      artifact: 'inputs/diff.txt',
    }),
    /screen=diff, run=run-abc, artifact=inputs\/diff\.txt/,
  );
});

test('workspaceCopilotInputForRoute extracts PR and decision routes', () => {
  assert.equal(workspaceCopilotInputForRoute('/prs', { pr: '30095' }).prNumber, 30095);
  assert.deepEqual(
    workspaceCopilotInputForRoute('/decision/decision-abc', {
      id: 'decision-abc',
      runId: 'run-abc',
    }),
    {
      current: 'review',
      familyId: null,
      slotId: null,
      runId: 'run-abc',
      prNumber: null,
      decisionId: 'decision-abc',
      decisionKind: null,
      workspaceFocus: null,
      recipeRunId: null,
      artifactPath: null,
    },
  );
});

test('workspaceCopilotInputForRoute preserves ready workspace focus from navigation params', () => {
  assert.deepEqual(
    workspaceCopilotInputForRoute('/decision/decision-ready', {
      id: 'decision-ready',
      runId: 'run-ready',
      decisionKind: 'ready',
      workspace: 'ready',
    }),
    {
      current: 'ready',
      familyId: null,
      slotId: null,
      runId: 'run-ready',
      prNumber: null,
      decisionId: 'decision-ready',
      decisionKind: 'ready',
      workspaceFocus: 'ready',
      recipeRunId: null,
      artifactPath: null,
    },
  );

  assert.match(
    buildWorkspaceCopilotDraftForRoute('/artifacts/run-ready', {
      runId: 'run-ready',
      filter: 'review',
      decisionKind: 'ready',
      workspace: 'ready',
      artifact: 'reports/ready.md',
    }),
    /screen=ready, run=run-ready, decisionKind=ready, focus=ready, artifact=reports\/ready\.md/,
  );
});

test('buildFailedStepDiagnosticDraft asks gateway intelligence for recovery proposal first', () => {
  const draft = buildFailedStepDiagnosticDraft({
    runId: 'run-abc',
    ticketOrPr: 'example-org/example-mobile#30095',
    flowType: 'review-pr',
    stepName: 'monitor',
    slotId: 'runner-mobile-2',
    stepDetail: 'Validator timed out',
  });

  assert.match(draft, /^Why did step "monitor" fail in run run-abc\?/);
  assert.match(draft, /Ticket or PR: example-org\/example-mobile#30095/);
  assert.match(draft, /Flow: review-pr/);
  assert.match(draft, /Slot: runner-mobile-2/);
  assert.match(draft, /Step detail: Validator timed out/);
  assert.match(draft, /Call propose_run_recovery for this run and step first\./);
  assert.match(draft, /read-only next steps\.$/);
});
