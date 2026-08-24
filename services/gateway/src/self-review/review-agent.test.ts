import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import type { AgentContext } from '@farmslot/protocol';

import { retainedReviewerDeliveryPlan } from '../runners/registry.js';
import { targetForChecklistBasename } from '../tasks/checklist-target.js';

import {
  resumeReviewAgentPromptDelivery,
  reviewerChecklistBasename,
  reviewerFeedbackRelPath,
  scopeReviewFeedbackPath,
  selectRecoverableReviewContext,
  selfReviewChecklistMarkPrompt,
  waitForRecoveredReviewerOrCleanup,
} from './review-agent.js';
import { TerminalReviewArtifactError } from './terminal-result.js';

test('self-review cold launch and recovery send to interactive argv-first runners', () => {
  const source = fs.readFileSync(
    fileURLToPath(new URL('./review-agent.ts', import.meta.url)),
    'utf8',
  );
  assert.match(
    source,
    /if \(!target \|\| !taskMdPath \|\| !runner \|\| !runnerSupportsInteractivePrompt\(runner\)\)/,
  );
  assert.match(
    source,
    /if \(runnerSupportsInteractivePrompt\(runner\)\) \{\s*const promptAcceptanceBaselineMs/,
  );
  assert.doesNotMatch(
    source,
    /if \(runnerNeedsPostLaunchPrompt\(runner\)\) \{\s*const promptAcceptanceBaselineMs/,
  );
});

test('retained reviewer delivery uses native reset or a cold process replacement', () => {
  assert.deepEqual(retainedReviewerDeliveryPlan('claude', 'reset', 1), {
    kind: 'in-place',
    resetContext: true,
  });
  assert.deepEqual(retainedReviewerDeliveryPlan('codex', 'reset', 1), {
    kind: 'cold-relaunch',
    resetContext: false,
  });
  assert.deepEqual(retainedReviewerDeliveryPlan('codex', 'resume', 1), {
    kind: 'in-place',
    resetContext: false,
  });
});

test('restart recovery reclaims only the newest matching in-flight reviewer', () => {
  const context = (id: string, status: AgentContext['status'], scope: string | null) =>
    ({
      id,
      role: 'self-review',
      label: id,
      status,
      slotId: 'slot-1',
      runId: 'run-1',
      runner: 'claude',
      taskFile: `tasks/run-1/SELF-REVIEW.${id}.md`,
      signalFile: `tasks/run-1/SELF-REVIEW.${id}-SIGNAL.json`,
      artifactScope: scope,
      target: { session: 'ff-1', window: id, pane: null, target: `ff-1:${id}` },
    }) satisfies AgentContext;
  const contexts = [
    context('rev-claude', 'working', 'independent-review-2'),
    context('rev1-claude', 'complete', 'independent-review-2'),
    { ...context('rev2-claude', 'working', 'independent-review-2'), reviewLoopNumber: 4 },
  ];

  const recovered = selectRecoverableReviewContext(contexts, {
    taskDir: 'tasks/run-1',
    runner: 'claude',
    artifactScope: 'independent-review-2',
  });
  assert.equal(recovered?.id, 'rev2-claude');
  assert.equal(recovered?.reviewLoopNumber, 4);
  assert.equal(
    selectRecoverableReviewContext(contexts, {
      taskDir: 'tasks/run-1',
      runner: 'claude',
      artifactScope: null,
    }),
    null,
  );
});

test('review agent instructions use context-scoped checklist, signal, and feedback files', () => {
  const checklist = reviewerChecklistBasename('rev-codex-2');
  const feedback = reviewerFeedbackRelPath('rev-codex-2');
  const target = targetForChecklistBasename(checklist);

  assert.equal(checklist, 'SELF-REVIEW.rev-codex-2.md');
  assert.equal(target.signal, 'SELF-REVIEW.rev-codex-2-SIGNAL.json');
  assert.equal(feedback, 'artifacts/review-feedback.rev-codex-2.md');

  const prompt = selfReviewChecklistMarkPrompt(
    'tasks/run-1',
    `tasks/run-1/${checklist}`,
    target,
    feedback,
  );

  assert.match(prompt, /--checklist SELF-REVIEW\.rev-codex-2\.md/);
  assert.match(prompt, /--signal SELF-REVIEW\.rev-codex-2-SIGNAL\.json/);
  assert.match(prompt, /tasks\/run-1\/artifacts\/review-feedback\.rev-codex-2\.md/);
});

test('review agent scopes legacy template feedback paths to the reviewer context', () => {
  const scoped = scopeReviewFeedbackPath(
    'Write tasks/run-1/artifacts/review-feedback.md, include review-feedback.md in evidence, but leave docs/review-feedback.md alone.',
    reviewerFeedbackRelPath('rev-claude'),
  );

  assert.equal(
    scoped,
    'Write tasks/run-1/artifacts/review-feedback.rev-claude.md, include artifacts/review-feedback.rev-claude.md in evidence, but leave docs/review-feedback.md alone.',
  );
});

test('review agent appends scoped feedback path when template omits legacy path', () => {
  const scoped = scopeReviewFeedbackPath('Review the diff.', reviewerFeedbackRelPath('rev-codex'));

  assert.equal(
    scoped,
    'Review the diff.\n\nWrite reviewer feedback to artifacts/review-feedback.rev-codex.md.',
  );
});

test('review agent does not rewrite a similarly named artifact directory', () => {
  const scoped = scopeReviewFeedbackPath(
    'Keep my-artifacts/review-feedback.md; write artifacts/review-feedback.md, now.',
    reviewerFeedbackRelPath('rev-codex'),
  );

  assert.equal(
    scoped,
    'Keep my-artifacts/review-feedback.md; write artifacts/review-feedback.rev-codex.md, now.',
  );
});

test('review prompt recovery sends to an interactive argv-first runner', async () => {
  const vars = {
    projectName: 'farmslot-farm',
  } as Parameters<typeof resumeReviewAgentPromptDelivery>[0];
  let sentPane = '';
  let sentPrompt = '';
  let sentRunner = '';

  const outcome = await resumeReviewAgentPromptDelivery(
    vars,
    'missing-run',
    {
      id: 'rev-cursor',
      runner: 'cursor',
      taskFile: 'tasks/run-1/SELF-REVIEW.rev-cursor.md',
      signalFile: 'tasks/run-1/SELF-REVIEW.rev-cursor-SIGNAL.json',
      target: { session: 'mm-4', window: 'rev-cursor', pane: null, target: 'mm-4:rev-cursor' },
      attemptStartedAt: '2026-08-24T03:37:05.626Z',
    },
    {
      resolveExactTmuxWindowPane: async () => ({ paneId: '%151', panePid: '59361' }),
      isRunnerAliveUnderPane: async () => true,
      resolveWorkerDispatchPrompt: async () => 'Review the prepared package.',
      resolveProjectRuntimeDir: async () => 'temp/recipe/runtime',
      sendRunnerPostLaunchPrompt: async (_vars, paneId, runner, prompt) => {
        sentPane = paneId;
        sentRunner = runner;
        sentPrompt = prompt;
      },
    },
  );

  assert.equal(outcome, 'delivered');
  assert.equal(sentPane, '%151');
  assert.equal(sentRunner, 'cursor');
  assert.match(sentPrompt, /SELF-REVIEW\.rev-cursor\.md/);
  assert.match(sentPrompt, /review-feedback\.rev-cursor\.md/);
});

test('review prompt recovery stays unsupported for non-interactive runners', async () => {
  const outcome = await resumeReviewAgentPromptDelivery(
    { projectName: 'farmslot-farm' } as Parameters<typeof resumeReviewAgentPromptDelivery>[0],
    'missing-run',
    {
      id: 'rev-scripted',
      runner: 'scripted',
      taskFile: 'tasks/run-1/SELF-REVIEW.rev-scripted.md',
      signalFile: 'tasks/run-1/SELF-REVIEW.rev-scripted-SIGNAL.json',
      target: { session: 'ff-1', window: 'rev-scripted', pane: null, target: 'ff-1:rev-scripted' },
      attemptStartedAt: '2026-08-24T03:37:05.626Z',
    },
    {
      resolveExactTmuxWindowPane: async () => {
        throw new Error('must not inspect tmux for unsupported runners');
      },
      isRunnerAliveUnderPane: async () => {
        throw new Error('must not inspect tmux for unsupported runners');
      },
      resolveWorkerDispatchPrompt: async () => {
        throw new Error('must not build a prompt for unsupported runners');
      },
      resolveProjectRuntimeDir: async () => {
        throw new Error('must not resolve runtime for unsupported runners');
      },
      sendRunnerPostLaunchPrompt: async () => {
        throw new Error('must not send a prompt for unsupported runners');
      },
    },
  );

  assert.equal(outcome, 'unsupported');
});

test('review prompt recovery reuses the exact live reviewer pane', async () => {
  const vars = {
    projectName: 'farmslot-farm',
  } as Parameters<typeof resumeReviewAgentPromptDelivery>[0];
  let sentPane = '';
  let sentPrompt = '';

  const outcome = await resumeReviewAgentPromptDelivery(
    vars,
    'missing-run',
    {
      id: 'rev-claude',
      runner: 'claude',
      taskFile: 'tasks/run-1/SELF-REVIEW.rev-claude.md',
      signalFile: 'tasks/run-1/SELF-REVIEW.rev-claude-SIGNAL.json',
      target: { session: 'ff-1', window: 'rev-claude', pane: null, target: 'ff-1:rev-claude' },
      attemptStartedAt: '2026-08-03T16:00:00.000Z',
    },
    {
      resolveExactTmuxWindowPane: async () => ({ paneId: '%22', panePid: '2002' }),
      isRunnerAliveUnderPane: async () => true,
      resolveWorkerDispatchPrompt: async () => 'Review the prepared package.',
      resolveProjectRuntimeDir: async () => 'temp/recipe/runtime',
      sendRunnerPostLaunchPrompt: async (_vars, paneId, _runner, prompt) => {
        sentPane = paneId;
        sentPrompt = prompt;
      },
    },
  );

  assert.equal(outcome, 'delivered');
  assert.equal(sentPane, '%22');
  assert.match(sentPrompt, /SELF-REVIEW\.rev-claude\.md/);
  assert.match(sentPrompt, /review-feedback\.rev-claude\.md/);
});

test('review recovery timeout performs cleanup before allowing a fresh reviewer', async () => {
  const cleanupReasons: Array<{ reason: string; status?: 'failed' | 'blocked' }> = [];
  const recordCleanup = async (reason: string, status?: 'failed' | 'blocked') => {
    cleanupReasons.push(status ? { reason, status } : { reason });
  };
  const completed = await waitForRecoveredReviewerOrCleanup(async () => false, recordCleanup);

  assert.equal(completed, false);
  assert.deepEqual(cleanupReasons, [{ reason: 'recovered reviewer timeout' }]);

  await assert.rejects(
    waitForRecoveredReviewerOrCleanup(async () => {
      throw new TerminalReviewArtifactError('invalid result');
    }, recordCleanup),
    TerminalReviewArtifactError,
  );
  assert.deepEqual(cleanupReasons.at(-1), {
    reason: 'invalid recovered reviewer artifact cleanup',
    status: 'blocked',
  });
});
