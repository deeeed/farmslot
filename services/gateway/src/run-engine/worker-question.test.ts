import assert from 'node:assert/strict';
import test from 'node:test';

import type { NativeSessionEvent } from '@farmslot/protocol';

import { paneOpenQuestion } from '../runners/pane-state-script.js';

import {
  nativePendingRequestText,
  trackOpenQuestion,
  workerQuestionHandoffDescription,
} from './worker-question.js';

// Claude's AskUserQuestion menu, as on QA run 3e2f400a.
const CLAUDE_QUESTION_PANE = [
  '⏺ The QA scope is frozen at 6c2b9e1, but the slot is on main.',
  '',
  '───────────────────────────────────────────────────────────────',
  ' ☐ Frozen head',
  '',
  'Detach the checkout to the frozen scope head before testing?',
  '',
  '❯ 1. Detach to frozen head (Recommended)',
  '     Check out 6c2b9e1 so the QA scope matches the frozen package.',
  '  2. Keep current branch',
  '     Test the current main head instead.',
  '  3. Type something.',
  '',
  'Enter to select · Tab/Arrow keys to navigate · Esc to cancel',
].join('\n');

const CLAUDE_WORKING_PANE = [
  '✻ Churning… (15m 15s · ↓ 46.9k tokens)',
  '',
  '────────────────────────────────────────────────────────────────',
  '❯ ',
  '────────────────────────────────────────────────────────────────',
  '  fs · Opus 5.5 · ctx:25%',
  '  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents',
].join('\n');

test('paneOpenQuestion returns an open menu or prompt and nothing for a working pane', () => {
  const question = paneOpenQuestion(CLAUDE_QUESTION_PANE);
  assert.match(question ?? '', /Detach the checkout to the frozen scope head before testing\?/);
  assert.match(question ?? '', /2\. Keep current branch/);
  assert.equal(
    paneOpenQuestion('Apply the patch?\nDo you want to continue? [y/n]'),
    'Apply the patch?\nDo you want to continue? [y/n]',
  );
  assert.equal(paneOpenQuestion(CLAUDE_WORKING_PANE), null);
});

test('a question typed into the live composer is unsent input, not an open question', () => {
  const codexBusy = [
    '• Working (3m 35s • esc to interrupt) · 1 background terminal running',
    '› Would you like to review #1240 next?',
    '  tab to queue message                                                          87% context left',
  ].join('\n');
  const claudeDraft = [
    '⏺ Rebase finished.',
    '',
    '────────────────────────────────────────────────────────────────',
    '❯ Do you want me to push the branch now?',
    '────────────────────────────────────────────────────────────────',
    '  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents',
  ].join('\n');
  assert.equal(paneOpenQuestion(codexBusy), null);
  assert.equal(paneOpenQuestion(claudeDraft), null);
  // A prompt the runner shows above its composer still counts.
  assert.match(
    paneOpenQuestion(
      `Overwrite the lockfile? [y/n]\n${claudeDraft.split('\n').slice(2).join('\n')}`,
    ) ?? '',
    /\[y\/n\]/,
  );
});

test('a pane question counts on its second poll; a native request counts at once', () => {
  const state: { openQuestion?: { text: string; polls: number } } = {};
  assert.equal(trackOpenQuestion(state, 'Detach?'), null);
  assert.equal(trackOpenQuestion(state, 'Detach?'), 'Detach?');
  assert.equal(trackOpenQuestion(state, null), null);
  assert.equal(state.openQuestion, undefined);
  assert.equal(trackOpenQuestion(state, 'Detach?'), null, 'a closed question starts over');
  assert.equal(trackOpenQuestion({}, 'Allow?', true), 'Allow?');
});

test('native pending requests read as their title, detail, prompts and options', () => {
  const event = (request: NativeSessionEvent['request']): NativeSessionEvent => ({
    sessionId: 's',
    sequence: 1,
    generation: 'g',
    at: '2026-10-17T00:00:00.000Z',
    type: 'question.requested',
    request,
  });
  assert.equal(nativePendingRequestText([]), null);
  assert.equal(
    nativePendingRequestText([
      event({
        id: 'q',
        title: 'Frozen head',
        questions: [
          {
            id: 'q1',
            prompt: 'Detach to the frozen head?',
            options: [{ label: 'Detach', description: 'Check out 6c2b9e1' }, { label: 'Keep' }],
          },
        ],
      }),
      event({ id: 'a', title: 'Run yarn install', detail: 'Writes node_modules' }),
    ]),
    'Frozen head\nDetach to the frozen head?\n- Detach: Check out 6c2b9e1\n- Keep\n\nRun yarn install\nWrites node_modules',
  );
  assert.match(nativePendingRequestText([event(undefined)]) ?? '', /without details/);
});

test('the handoff description fences the question, avoiding a fence it contains', () => {
  assert.match(workerQuestionHandoffDescription('Detach?'), /```text\nDetach\?\n```$/);
  assert.match(workerQuestionHandoffDescription('Run ```x```?'), /~~~text\nRun ```x```\?\n~~~$/);
});
