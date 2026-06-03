import assert from 'node:assert/strict';
import test from 'node:test';

import type { ReadyGatePayload, Run } from '@farmslot/protocol';

import {
  readyWorkspaceInputArtifacts,
  readyWorkspaceInputSnapshot,
  readyWorkspaceQualityItemCount,
  readyWorkspaceTicketInputMarkdown,
} from './ready-workspace-inputs.js';

const emptyState = {
  legacyTaskPromptText: '',
  legacyTaskPromptLoading: false,
  legacyTaskPromptError: '',
};

function payload(overrides: Partial<ReadyGatePayload> = {}): ReadyGatePayload {
  return {
    ...overrides,
  } as ReadyGatePayload;
}

test('readyWorkspaceInputArtifacts builds ticket, prompt, checklist, task, and template rows', () => {
  const artifacts = readyWorkspaceInputArtifacts(
    payload({
      inputSnapshot: {
        ticketData: {
          source: 'jira',
          jiraKey: 'PROJ-1',
          title: 'Fix crash',
          description: 'Crashes on save',
          issueType: 'Bug',
          acceptanceCriteria: ['No crash'],
          comments: ['Please fix', 'Confirmed'],
          labels: ['mobile'],
        },
        initialContext: 'Operator supplied context',
        checklist: ['Reproduce', 'Validate'],
        taskFile: '/tmp/TASK.md',
        taskPrompt: '# Task body',
        templateProvenance: {
          flowType: 'fix-bug',
          templateName: 'fix-bug.md',
          source: 'project',
          contentHash: 'abcdef1234567890',
        },
      } as unknown as ReadyGatePayload['inputSnapshot'],
    }),
    null,
    emptyState,
  );

  assert.deepEqual(
    artifacts.map((artifact) => [artifact.id, artifact.label, artifact.kind]),
    [
      ['ticket', 'PROJ-1', 'Jira'],
      ['ticket-comments', 'Ticket comments', 'Comments'],
      ['initial-context', 'Operator prompt', 'Prompt'],
      ['checklist', 'Dispatch checklist', 'Checklist'],
      ['task-prompt', 'TASK.md prompt', 'Task'],
      ['template-provenance', 'Template provenance', 'Template'],
    ],
  );
  assert.match(artifacts[0].body, /# Fix crash/);
  assert.match(artifacts[0].body, /- No crash/);
  assert.equal(artifacts[1].body, 'Please fix\n\n---\n\nConfirmed');
  assert.equal(artifacts[4].body, '# Task body');
  assert.match(artifacts[5].summary, /abcdef123456/);
});

test('readyWorkspaceInputSnapshot falls back to run input fields for legacy payloads', () => {
  const run = {
    taskFile: '/tmp/TASK.md',
    ticketData: {
      source: 'github',
      githubIssue: 'owner/repo#5',
      title: 'Issue title',
      description: '',
    },
    engineState: {
      interactiveDev: {
        initialContext: 'Initial context',
        checklist: ['Check one'],
      },
    },
    templateProvenance: {
      flowType: 'dev',
      templateName: 'dev.md',
      source: 'project',
      contentHash: '1234567890abcdef',
    },
  } as unknown as Run;

  const snapshot = readyWorkspaceInputSnapshot(payload(), run);

  assert.equal(snapshot?.taskFile, '/tmp/TASK.md');
  assert.equal(snapshot?.ticketData?.githubIssue, 'owner/repo#5');
  assert.deepEqual(snapshot?.checklist, ['Check one']);
});

test('readyWorkspaceInputArtifacts reports legacy task prompt load states', () => {
  const basePayload = payload({ inputSnapshot: { taskFile: '/tmp/TASK.md' } });

  assert.equal(
    readyWorkspaceInputArtifacts(basePayload, null, emptyState).find(
      (artifact) => artifact.id === 'task-prompt',
    )?.body,
    'Open this artifact to load TASK.md.',
  );
  assert.equal(
    readyWorkspaceInputArtifacts(basePayload, null, {
      ...emptyState,
      legacyTaskPromptLoading: true,
    }).find((artifact) => artifact.id === 'task-prompt')?.body,
    'Loading TASK.md…',
  );
  assert.equal(
    readyWorkspaceInputArtifacts(basePayload, null, {
      ...emptyState,
      legacyTaskPromptError: '404',
    }).find((artifact) => artifact.id === 'task-prompt')?.body,
    'Failed to load TASK.md: 404',
  );
});

test('ready workspace quality and ticket helpers keep display precedence stable', () => {
  assert.equal(
    readyWorkspaceQualityItemCount(
      payload({
        recipeQualityArtifact: { compact: { reasons: ['r1', 'r2'] } },
        qualityReport: { acVerdicts: [{ id: 'ac1' }] },
        acceptanceCriteria: ['fallback'],
      } as unknown as ReadyGatePayload),
    ),
    2,
  );
  assert.match(
    readyWorkspaceTicketInputMarkdown({
      source: 'github',
      githubIssue: 'owner/repo#7',
      title: '',
      description: 'Body',
      stepsToReproduce: ['Open app'],
      linkedTickets: [{ ref: 'BUG-2', url: 'https://example.test/BUG-2', title: 'Related' }],
    } as unknown as Parameters<typeof readyWorkspaceTicketInputMarkdown>[0]),
    /# owner\/repo#7[\s\S]*1\. Open app[\s\S]*\[BUG-2\]/,
  );
});
