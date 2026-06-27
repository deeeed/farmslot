import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { DEFAULT_CURSOR_MODEL, DEFAULT_GROK_MODEL } from '@farmslot/protocol';

import { buildCodexExecLaunch, buildLaunchCommand } from './launch-command.js';
import { resolveWorkerDispatchPrompt } from './worker-prompt.js';

async function dispatchPrompt(taskFile: string): Promise<string> {
  return resolveWorkerDispatchPrompt('farmslot-farm', { taskFile });
}
import {
  detectRunnerLaunchBlocker,
  getRunnerDefinition,
  getRunnerObservability,
  normalizeRunner,
  runnerBufferedInstructionSubmitKey,
  runnerContinueCommand,
  runnerDefaultModel,
  runnerLineLooksWaiting,
  runnerNeedsPostLaunchPrompt,
  runnerPaneHasBufferedInstruction,
  runnerPaneHasPendingInstruction,
  runnerPaneHasProgressAfterInstruction,
  runnerPaneHasQueuedInstruction,
  runnerPaneLooksIdle,
  runnerPaneShouldSubmitExistingInstruction,
  runnerPaneShowsPromptAccepted,
  runnerPaneShowsTaskAlreadyRunning,
  runnerPaneShowsWorkspaceTrustPrompt,
  runnerPersistsSessionFiles,
  runnerProcessPattern,
  runnerProcessPatternSource,
  runnerSignalShowsCompletion,
  runnerSupportsInteractivePrompt,
  runnerSupportsModel,
  runnerSupportsTmuxNudges,
} from './registry.js';
import { assertCodexWorkerDoesNotInjectMcpOverrides, makeVars } from './test-fixtures.js';

describe('fake runner', () => {
  it('has exec launch mode', () => {
    assert.equal(getRunnerDefinition('fake').defaultLaunchMode, 'exec');
  });

  it('does not support interactive prompt', () => {
    assert.equal(runnerSupportsInteractivePrompt('fake'), false);
  });

  it('does not support tmux nudges', () => {
    assert.equal(runnerSupportsTmuxNudges('fake'), false);
  });

  it('does not need post-launch prompt', () => {
    assert.equal(runnerNeedsPostLaunchPrompt('fake'), false);
  });

  it('has null continue command', () => {
    assert.equal(runnerContinueCommand('fake'), null);
  });

  it('matches fake-runner process patterns', () => {
    const pattern = runnerProcessPattern('fake');
    assert.ok(pattern.test('farmslot-fake-runner'));
    assert.ok(pattern.test('fake-runner'));
  });
});

describe('claude runner', () => {
  it('normalizes legacy claude-code runner ids to claude', () => {
    assert.equal(normalizeRunner('claude-code'), 'claude');
    assert.equal(runnerNeedsPostLaunchPrompt('claude-code'), true);
  });

  it('needs post-launch prompt for normal interactive launches', () => {
    assert.equal(runnerNeedsPostLaunchPrompt('claude'), true);
  });

  it('has /continue as continue command', () => {
    assert.equal(runnerContinueCommand('claude'), '/continue');
  });

  it('accepts fable without making it the default model', () => {
    assert.equal(runnerSupportsModel('claude', 'fable'), true);
    assert.notEqual(getRunnerDefinition('claude').defaultModel, 'fable');
    assert.equal(runnerSupportsModel('codex', 'fable'), false);
  });
});

describe('codex runner', () => {
  it('is an interactive TUI runner that receives its task after launch', () => {
    assert.equal(getRunnerDefinition('codex').defaultLaunchMode, 'interactive');
    assert.equal(runnerNeedsPostLaunchPrompt('codex'), true);
    assert.equal(runnerSupportsInteractivePrompt('codex'), true);
    assert.equal(runnerSupportsTmuxNudges('codex'), true);
  });

  it('uses natural language for Codex in-TUI continue nudges', () => {
    assert.equal(
      runnerContinueCommand('codex'),
      'Continue the current task from where you left off.',
    );
  });

  it('launches interactive Codex with dangerous bypass enabled when the dangerous tier is passed', () => {
    const launch = buildCodexExecLaunch({
      binary: 'codex',
      model: 'gpt-5.5',
      prompt: 'Read TASK.md',
      repo: '/workspace/repo',
      safetyTier: 'dangerous',
    });
    assert.match(launch, /codex --dangerously-bypass-approvals-and-sandbox .*--model gpt-5\.5/);
    assertCodexWorkerDoesNotInjectMcpOverrides(launch);
    assert.doesNotMatch(launch, /model_reasoning_effort/);
    assert.doesNotMatch(launch, /codex exec /);
    assert.match(launch, /'Read TASK\.md'/);
  });

  it('can launch Codex TUI without an argv task prompt so the pane remains steerable', () => {
    const launch = buildCodexExecLaunch({
      binary: 'codex',
      model: 'gpt-5.5',
      repo: '/workspace/repo',
      safetyTier: 'dangerous',
    });
    assert.match(launch, /codex --dangerously-bypass-approvals-and-sandbox .*--model gpt-5\.5$/);
    assert.doesNotMatch(launch, /Read TASK\.md/);
  });
});

describe('none runner', () => {
  it('does not need post-launch prompt', () => {
    assert.equal(runnerNeedsPostLaunchPrompt('none'), false);
  });

  it('has null continue command', () => {
    assert.equal(runnerContinueCommand('none'), null);
  });
});

describe('opencode runner', () => {
  it('has null continue command', () => {
    assert.equal(runnerContinueCommand('opencode'), null);
  });
});

describe('cursor runner', () => {
  it('is registered as an interactive runner with composer-2.5 default model', () => {
    const def = getRunnerDefinition('cursor');
    assert.equal(def.id, 'cursor');
    assert.equal(def.defaultLaunchMode, 'interactive');
    assert.equal(runnerDefaultModel('cursor'), DEFAULT_CURSOR_MODEL);
  });

  it('treats the normal Cursor Agent TUI as steerable through tmux', () => {
    assert.equal(runnerNeedsPostLaunchPrompt('cursor'), false);
    assert.equal(runnerSupportsInteractivePrompt('cursor'), true);
    assert.equal(runnerSupportsTmuxNudges('cursor'), true);
    assert.equal(runnerContinueCommand('cursor'), null);
    assert.equal(getRunnerDefinition('cursor').requiresBusyComposerPoll, false);
    assert.equal(runnerPersistsSessionFiles('cursor'), false);
  });

  it('recognizes Cursor TUI waiting lines as nudge opportunities', () => {
    assert.equal(runnerLineLooksWaiting('press enter to continue', 'cursor'), true);
    assert.equal(runnerLineLooksWaiting('→ Plan, search, build anything', 'cursor'), true);
    assert.equal(runnerLineLooksWaiting('press enter to continue', 'codex'), true);
    assert.equal(runnerLineLooksWaiting('›', 'codex'), true);
    assert.equal(runnerLineLooksWaiting('› Run /review on my current changes', 'codex'), true);
  });

  it('detects Cursor idle prompt above trailing blank input-box rows', () => {
    assert.equal(
      runnerPaneLooksIdle(
        [
          '  Cursor Agent',
          ' ▄▄▄▄▄▄▄▄▄▄▄▄▄',
          '  → Plan, search, build anything',
          ' ▀▀▀▀▀▀▀▀▀▀▀▀▀',
          '',
          '',
          '',
          '',
          '',
        ],
        'cursor',
      ),
      true,
    );
  });

  it('detects Cursor workspace trust prompts before post-launch prompt delivery', () => {
    const pane = `
  │                                                                          │
  │                                                                          │
  │  ▶ [a] Trust this workspace                                              │
  │    [q] Quit                                                              │
  │                                                                          │
  │  Use arrow keys to navigate, Enter to select, or press the key shown     │
  │                                                                          │
  ╰──────────────────────────────────────────────────────────────────────────╯
`;

    assert.equal(runnerPaneShowsWorkspaceTrustPrompt(pane, 'cursor'), true);
    assert.equal(runnerPaneShowsWorkspaceTrustPrompt(pane, 'claude'), false);
    assert.equal(runnerPaneShowsWorkspaceTrustPrompt(pane, 'grok'), false);
    assert.deepEqual(detectRunnerLaunchBlocker(pane, 'cursor'), {
      kind: 'workspace-trust',
      summary:
        'Cursor is waiting for workspace trust confirmation before the chat input is available.',
      autoAction: 'cursor-trust-workspace',
    });
  });

  it('does not keep sending trust input once Cursor is already trusting the workspace', () => {
    const pane = `
  │    [a] Trust this workspace                                              │
  │    [q] Quit                                                              │
  │                                                                          │
  │  ⏳ Trusting workspace...                                                │
  │                                                                          │
  ╰──────────────────────────────────────────────────────────────────────────╯
`;

    assert.equal(runnerPaneShowsWorkspaceTrustPrompt(pane, 'cursor'), false);
  });

  it('detects Grok project-directory selection prompts before prompt delivery', () => {
    const pane = `
  ┃
  ┃  Run Grok Build in a project directory?
  ┃
  ┃  1 (○) farmslot-grok-probe (current)                                     █
  ┃                                /private/tmp/farmslot-grok-probe          █
  ┃  2 (○) farmslot                ~/dev/farmslot  (9m ago)
  ┃
  ┃  ↑/↓ navigate · y copy                                    Enter:submit
  ┃
`;

    assert.deepEqual(detectRunnerLaunchBlocker(pane, 'grok'), {
      kind: 'project-directory',
      summary:
        'Grok is waiting for project-directory selection before the chat input is available.',
      autoAction: 'grok-select-current-project',
    });
    assert.equal(detectRunnerLaunchBlocker(pane, 'cursor'), null);
  });

  it('classifies auth blockers without assigning an unsafe auto action', () => {
    const pane = 'Authentication expired. Please run cursor-agent login to continue.';
    assert.deepEqual(detectRunnerLaunchBlocker(pane, 'cursor'), {
      kind: 'auth-required',
      summary: 'cursor requires login/authentication before Farmslot can deliver the task prompt.',
      autoAction: null,
    });
  });

  it('does not classify optional MCP login warnings as runner auth blockers', async () => {
    const pane = [
      'MCP startup failed: handshaking with MCP server failed',
      'The sentry MCP server is not logged in. Run `codex mcp login sentry`.',
    ].join('\n');

    assert.equal(detectRunnerLaunchBlocker(pane, 'codex'), null);
  });

  it('detects Codex instructions buffered at the live composer without progress', async () => {
    const message = await dispatchPrompt('temp/tasks/fix/demo/SELF-REVIEW-FIX.md');
    const pane = `
• Current TASK.md status is already done.

› codex --continue
  ${message}

  gpt-5.5 medium fast · branch · Context 17% left · 25.3M in · 37.1K out
`;
    assert.equal(runnerPaneHasPendingInstruction(pane, message, 'codex'), true);
  });

  it('does not treat a submitted Codex instruction with progress as pending', async () => {
    const message = await dispatchPrompt('temp/tasks/fix/demo/SELF-REVIEW-FIX.md');
    const pane = `
› ${message}

• UserPromptSubmit hook (completed)
• Working (2s • esc to interrupt)

  gpt-5.5 medium fast · branch · Context 17% left
`;
    assert.equal(runnerPaneHasPendingInstruction(pane, message, 'codex'), false);
    assert.equal(runnerPaneHasProgressAfterInstruction(pane, message), true);
  });

  it('accepts prompt delivery when Codex immediately starts working and no marker remains visible', async () => {
    const message = await dispatchPrompt('temp/tasks/feat/proj-1043/SELF-REVIEW.md');
    const before = `
╭────────────────────────────╮
│ >_ OpenAI Codex            │
╰────────────────────────────╯

› Improve documentation in @filename

  gpt-5.5 medium fast · branch · Context 90% left
`;
    const after = `
╭────────────────────────────╮
│ >_ OpenAI Codex            │
╰────────────────────────────╯

• SessionStart hook (completed)
• Explored
  └ Read SELF-REVIEW.md
• Working (3s • esc to interrupt)

  gpt-5.5 medium fast · branch · Context 89% left
`;

    assert.equal(
      runnerPaneShowsPromptAccepted(after, before, message, 'SELF-REVIEW.md', 'codex'),
      true,
    );
  });

  it('does not mistake stale busy text before a buffered Codex instruction for progress', async () => {
    const message = await dispatchPrompt('temp/tasks/fix/demo/SELF-REVIEW-FIX.md');
    const pane = `
• Working (12s • esc to interrupt)

› ${message}

  gpt-5.5 high fast · ~/dev/repo
`;
    assert.equal(runnerPaneHasProgressAfterInstruction(pane, message), false);
    assert.equal(runnerPaneHasBufferedInstruction(pane, message, 'codex'), true);
  });

  it('does not accept Codex post-launch prompt delivery when Enter was dropped', async () => {
    const message = await dispatchPrompt('.task/fix/30728-0529-130215/SELF-REVIEW.md');
    const before = `
╭─────────────────────────────────────────────────────╮
│ >_ OpenAI Codex                                     │
╰─────────────────────────────────────────────────────╯

  gpt-5.5 high fast · ~/dev/example-app/example-mobile-5
`;
    const after = `
╭─────────────────────────────────────────────────────╮
│ >_ OpenAI Codex                                     │
╰─────────────────────────────────────────────────────╯

› ${message}


  gpt-5.5 high fast · ~/dev/example-app/example-mobile-5
`;

    assert.equal(runnerPaneHasBufferedInstruction(after, message, 'codex'), true);
    assert.equal(
      runnerPaneShowsPromptAccepted(after, before, message, 'SELF-REVIEW.md', 'codex'),
      false,
    );
  });

  it('accepts Claude post-launch prompt delivery once the prompt is in transcript history', async () => {
    const message = await dispatchPrompt('temp/tasks/feat/tat-1043-0608-144339/SELF-REVIEW.md');
    const before = `
 ▐▛███▜▌   Claude Code v2.1.162

❯ 
`;
    const after = `
 ▐▛███▜▌   Claude Code v2.1.162

❯ ${message}

✽ Any future Claude turn label can appear here…

───────────────────────────────────────────────────────────────────────────────
❯ 
───────────────────────────────────────────────────────────────────────────────
  [OMC#4.14.4] | session:0m | ctx:0%
`;

    assert.equal(runnerPaneHasBufferedInstruction(after, message, 'claude'), false);
    assert.equal(
      runnerPaneShowsPromptAccepted(after, before, message, 'SELF-REVIEW.md', 'claude'),
      true,
    );
  });

  it('recognizes a Claude self-review task that is already executing during readiness wait', async () => {
    const message = await dispatchPrompt('.task/feat/tat-3215-0622-110508/SELF-REVIEW.md');
    const pane = `
⏺ Update(.task/feat/tat-3215-0622-110508/SELF-REVIEW.md)
  ⎿  Added 1 line, removed 1 line

⏺ Bash(git diff main...HEAD --stat)
  ⎿  Running…

✻ Spinning… (28s · ↓ 643 tokens)

───────────────────────────────────────────────────────────────────────────────
❯
───────────────────────────────────────────────────────────────────────────────
  fs · Opus 4.8 · ctx:5%
  ⏵⏵ bypass permissions on (shift+tab to cycle)
`;

    assert.equal(
      runnerPaneShowsTaskAlreadyRunning(pane, message, 'SELF-REVIEW.md', 'claude'),
      true,
    );
  });

  it('accepts post-launch prompt delivery when the runner queues it for the next tool call', async () => {
    const message = await dispatchPrompt('temp/tasks/feat/tat-3307-0609-103547/TASK.md');
    const before = `
⏺ Working (6s • esc to interrupt)
`;
    const after = `
• Messages to be
  submitted
  after next
  tool call
  ↳ ${message}
`;

    assert.equal(runnerPaneHasQueuedInstruction(after, message), true);
    assert.equal(runnerPaneShowsPromptAccepted(after, before, message, 'TASK.md', 'claude'), true);
  });

  it('uses Tab to submit buffered Codex prompts when the TUI requests queueing', () => {
    const pane = `
› Read temp/tasks/feat/tat-3215-0601-200704/TASK.md and execute all steps. Mark each checkbox as you complete it.


  tab to queue message                                                                                                100% context left
`;

    assert.equal(runnerBufferedInstructionSubmitKey(pane, 'codex'), 'Tab');
    assert.equal(runnerBufferedInstructionSubmitKey(pane, 'claude'), 'Enter');
  });

  it('uses carriage return to submit buffered Cursor Run Everything prompts', () => {
    const pane = `
  Cursor Agent
  v2026.06.19-20-24-33-653a7fb

  → Read .task/feat/tat-3215-comparison-cursor-0622-132834/TASK.md and
    execute all steps. Mark each checkbox as you complete it.

  Composer 2.5                                                  Run Everything
`;

    assert.equal(runnerBufferedInstructionSubmitKey(pane, 'cursor'), 'C-m');
  });

  it('submits instead of duplicating a post-launch prompt when Cursor already shows the TASK marker', async () => {
    const message = await dispatchPrompt('temp/tasks/feat/tat-1043-0608-144339/TASK.md');
    const pane = `
  Follow-ups
  - Read temp/tasks/feat/tat-1043-0608-144339/TASK.md and execute all steps.

  Composer 2.5 · 83.9% · Auto-run
`;

    assert.equal(
      runnerPaneShouldSubmitExistingInstruction(pane, message, 'TASK.md', 'cursor', {
        allowMarkerOnly: false,
      }),
      false,
    );
    assert.equal(
      runnerPaneShouldSubmitExistingInstruction(pane, message, 'TASK.md', 'cursor', {
        allowMarkerOnly: true,
      }),
      true,
    );
  });

  it('does not submit from marker-only text when the marker is stale above the live composer', async () => {
    const message = await dispatchPrompt('temp/tasks/feat/tat-1043-0608-144339/TASK.md');
    const pane = `
  Old transcript
  - Read temp/tasks/feat/tat-1043-0608-144339/TASK.md and execute all steps.










  Cursor Agent
  → Plan, search, build anything
`;

    assert.equal(
      runnerPaneShouldSubmitExistingInstruction(pane, message, 'TASK.md', 'cursor', {
        allowMarkerOnly: true,
      }),
      false,
    );
  });

  it('accepts Cursor prompt delivery when the latest duplicate prompt occurrence has live progress', async () => {
    const message = await dispatchPrompt('temp/tasks/feat/tat-3303-0608-192956/TASK.md');
    const before = `
  Cursor Agent
  → Plan, search, build anything
`;
    const after = `
  ${message}

  Reading the task file and executing its steps.

    Read temp/tasks/feat/tat-3303-0608-192956/TASK.md

 ┌─ follow-ups ─────────────────────────────────────────────────────────────┐
 │ ○ ${message}                                                             │
 └──────────────────────────────────────────────────────────────────────────┘

 ⠰⠰ Reading  474 tokens
`;

    assert.equal(runnerPaneHasProgressAfterInstruction(after, message), true);
    assert.equal(runnerPaneHasBufferedInstruction(after, message, 'cursor'), false);
    assert.equal(runnerPaneShowsPromptAccepted(after, before, message, 'TASK.md', 'cursor'), true);
  });

  it('accepts Cursor delivery when current tail status is reading despite a duplicate follow-up', async () => {
    const message = await dispatchPrompt('temp/tasks/feat/tat-3303-0608-192956/TASK.md');
    const before = `
  Cursor Agent
  → Plan, search, build anything
`;
    const after = `
  Cursor Agent
  v2026.06.04-5fd875e

  ${message}

  I'll read the task file first, then work through each step and mark checkboxes as they're completed.

    Read temp/tasks/feat/tat-3303-0608-192956/TASK.md

 ┌─ follow-ups ─────────────────────────────────────────────────────────────┐
 │ ○ ${message}                                                             │
 │ enter send now · ↑ edit · esc cancel                                     │
 └──────────────────────────────────────────────────────────────────────────┘

 ⠀⠞ Reading  487 tokens

  → ${message}

  Composer 2.5 · Auto-run
`;

    assert.equal(runnerPaneHasBufferedInstruction(after, message, 'cursor'), true);
    assert.equal(runnerPaneShowsPromptAccepted(after, before, message, 'TASK.md', 'cursor'), true);
  });

  it('does not accept stale Cursor progress before a later buffered duplicate prompt', async () => {
    const message = await dispatchPrompt('temp/tasks/feat/tat-3303-0608-192956/TASK.md');
    const before = `
  Cursor Agent
  → Plan, search, build anything
`;
    const after = `
  ${message}

  Reading the task file and executing its steps.

  → ${message}

  Composer 2.5 · Auto-run
`;

    assert.equal(runnerPaneHasProgressAfterInstruction(after, message), false);
    assert.equal(runnerPaneHasBufferedInstruction(after, message, 'cursor'), true);
    assert.equal(runnerPaneShowsPromptAccepted(after, before, message, 'TASK.md', 'cursor'), false);
  });

  it('detects Codex instructions buffered after tmux wraps long task paths', async () => {
    const message = await dispatchPrompt('temp/tasks/fix/eval-bf5e8c3f61bd-clean-extension-42435-harness-4d24c9dd-5057557b-0525-022117/SELF-REVIEW-FIX.md');
    const pane = `
• Waiting for background terminal (2m 08s • esc to interrupt)

› ${message}

  gpt-5.5 high fast · ~/dev/example-app/example-browser-1
`;
    assert.equal(runnerPaneHasPendingInstruction(pane, message, 'codex'), true);
    assert.equal(runnerPaneHasBufferedInstruction(pane, message, 'codex'), true);
  });

  it('matches Cursor Agent process patterns without making unknown runners inherit Cursor semantics', () => {
    assert.equal(runnerProcessPattern('cursor').test('agent'), true);
    assert.equal(
      runnerProcessPattern('cursor').test('/Users/me/.local/bin/agent --model composer-2.5'),
      true,
    );
    assert.equal(
      runnerProcessPattern('cursor').test('/usr/local/bin/cursor-agent --model composer-2.5'),
      true,
    );
    assert.equal(runnerProcessPattern('cursor').test('ssh-agent'), false);
    assert.equal(runnerProcessPattern('cursor').test('gpg-agent'), false);
    assert.equal(runnerProcessPattern('cursor').test('pkg-agent'), false);
    assert.equal(runnerProcessPattern('aider').test('agent'), false);
  });

  it('accepts composer-2.5 and account-specific model names', () => {
    assert.equal(runnerSupportsModel('cursor', DEFAULT_CURSOR_MODEL), true);
    assert.equal(runnerSupportsModel('cursor', 'sonnet-4-thinking'), true);
    assert.equal(getRunnerDefinition('cursor').acceptsModel?.(null as any), false);
  });
});

describe('grok runner', () => {
  it('is registered as an interactive runner with grok-build default model', () => {
    const def = getRunnerDefinition('grok');
    assert.equal(def.id, 'grok');
    assert.equal(def.defaultLaunchMode, 'interactive');
    assert.equal(runnerDefaultModel('grok'), DEFAULT_GROK_MODEL);
  });

  it('uses post-launch prompt delivery and remains tmux-steerable', () => {
    assert.equal(runnerNeedsPostLaunchPrompt('grok'), true);
    assert.equal(runnerSupportsInteractivePrompt('grok'), true);
    assert.equal(runnerSupportsTmuxNudges('grok'), true);
    assert.equal(runnerContinueCommand('grok'), null);
    assert.equal(getRunnerDefinition('grok').requiresBusyComposerPoll, false);
    assert.equal(runnerPersistsSessionFiles('grok'), true);
  });

  it('recognizes Grok TUI waiting lines as nudge opportunities', () => {
    assert.equal(runnerLineLooksWaiting('send a message', 'grok'), true);
    assert.equal(runnerLineLooksWaiting('type a message', 'grok'), true);
    assert.equal(
      runnerLineLooksWaiting(
        '│ ❯                                                                        │',
        'grok',
      ),
      true,
    );
    assert.equal(runnerLineLooksWaiting('→ Plan, search, build anything', 'grok'), false);
  });

  it('recognizes Grok buffered prompts and submitted progress', () => {
    const message = 'Reply exactly OK and do not edit files.';
    const buffered = `
  ╭──────────────────────────────────────────────────────────────────────────╮
  │ ❯ Reply exactly OK and do not edit files.                                │
  ╰───────────────────────────────────────────────────────────── Grok Build ─╯
`;
    const submitted = `
     #1 Reply exactly OK and do not edit files.

    ⠋ Starting session… 5.0s

  ╭──────────────────────────────────────────────────────────────────────────╮
  │ ❯                                                                        │
  ╰───────────────────────────────────────────────────────────── Grok Build ─╯
`;

    assert.equal(runnerPaneHasPendingInstruction(buffered, message, 'grok'), true);
    assert.equal(runnerPaneShowsPromptAccepted(submitted, buffered, message, '', 'grok'), true);
  });
});

describe('custom runner fallback behavior', () => {
  it('uses the raw custom runner name as the process matcher source', () => {
    assert.equal(runnerProcessPatternSource('aider'), 'aider');
  });

  it('uses the broad catch-all when no runner is specified', () => {
    assert.equal(
      runnerProcessPatternSource(undefined),
      'claude|codex|opencode|cursor-agent|grok|farmslot-fake-runner|fake-runner',
    );
  });
});

describe('persistsSessionFiles capability', () => {
  it('returns true for runners with durable usage/session files', () => {
    assert.equal(runnerPersistsSessionFiles('claude'), true);
    assert.equal(runnerPersistsSessionFiles('codex'), true);
    assert.equal(runnerPersistsSessionFiles('grok'), true);
  });

  it('returns false for runners without disk-backed session state', () => {
    assert.equal(runnerPersistsSessionFiles('opencode'), false);
    assert.equal(runnerPersistsSessionFiles('cursor'), false);
    assert.equal(runnerPersistsSessionFiles('fake'), false);
    assert.equal(runnerPersistsSessionFiles('none'), false);
  });

  it('returns false for unknown runners (prevents session-linkage contamination)', () => {
    // Unknown runner ids must not borrow Claude's persistsSessionFiles=true —
    // otherwise dispatch scans ~/.claude|~/.codex and attaches an unrelated
    // runnerSessionPath to the run.
    assert.equal(runnerPersistsSessionFiles('aider'), false);
    assert.equal(runnerPersistsSessionFiles('future-runner'), false);
  });
});

describe('tmux-interaction helpers — unknown runner isolation', () => {
  // Unknown runners must not inherit Claude's tmux semantics (interactive
  // prompts, nudges, post-launch prompt, /continue command, process matchers).
  // Callers rely on these booleans to decide whether to send mid-session
  // input; returning Claude's values for an unknown runner would send
  // `/continue` and similar Claude-specific strings to an unrelated TUI.
  it('runnerSupportsInteractivePrompt returns false for unknown runners', () => {
    assert.equal(runnerSupportsInteractivePrompt('aider'), false);
    assert.equal(runnerSupportsInteractivePrompt('future-runner'), false);
  });

  it('runnerSupportsTmuxNudges returns false for unknown runners', () => {
    assert.equal(runnerSupportsTmuxNudges('aider'), false);
  });

  it('runnerNeedsPostLaunchPrompt returns false for unknown runners', () => {
    assert.equal(runnerNeedsPostLaunchPrompt('aider'), false);
  });

  it('runnerContinueCommand returns null for unknown runners', () => {
    assert.equal(runnerContinueCommand('aider'), null);
    assert.equal(runnerContinueCommand('future-runner'), null);
  });

  it('runnerProcessPattern falls back to runner id (not known runner matchers) for unknown runners', () => {
    // Known runners include broad process matchers — an unknown runner must not
    // match those panes on a mixed-runner machine.
    const pattern = runnerProcessPattern('aider');
    assert.ok(pattern.test('aider'), 'matches the unknown runner id itself');
    assert.equal(pattern.test('claude'), false, 'does not borrow claude matcher');
  });
});

describe('worker signals', () => {
  it('accepts completed worker SIGNAL.json as completion evidence', () => {
    assert.equal(
      runnerSignalShowsCompletion(
        JSON.stringify({
          status: 'complete',
          outcome: 'success',
          timestamp: '2026-06-06T05:56:30Z',
        }),
      ),
      true,
    );
    assert.equal(runnerSignalShowsCompletion(JSON.stringify({ status: 'done' })), true);
  });

  it('rejects incomplete or invalid worker SIGNAL.json', () => {
    assert.equal(runnerSignalShowsCompletion(JSON.stringify({ outcome: 'success' })), false);
    assert.equal(
      runnerSignalShowsCompletion(JSON.stringify({ status: 'complete', outcome: 'failure' })),
      false,
    );
    assert.equal(
      runnerSignalShowsCompletion(JSON.stringify({ status: 'failed', outcome: 'failure' })),
      false,
    );
    assert.equal(runnerSignalShowsCompletion(JSON.stringify({ status: 'blocked' })), false);
    assert.equal(runnerSignalShowsCompletion(JSON.stringify({ outcome: 'failure' })), false);
    assert.equal(runnerSignalShowsCompletion(''), false);
    assert.equal(runnerSignalShowsCompletion('{'), false);
  });
});

describe('buildLaunchCommand', () => {
  const TASK_DIR = '.task/fix/abc';
  const TASK_FILE = `${TASK_DIR}/TASK.md`;
  const PROMPT = 'Read TASK.md and execute.';

  describe('claude runner', () => {
    it('inline-launches with --dangerously-skip-permissions when the full-auto tier is explicit', () => {
      // Intrinsic runner default is sandboxed; pre-refactor dangerous posture
      // is reachable only by opting into a higher tier (project default or
      // dispatch param).
      const vars = makeVars({ dispatchCmd: '' });
      const cmd = buildLaunchCommand(vars, 'claude', 'sonnet', PROMPT, { safetyTier: 'full-auto' });
      assert.match(
        cmd,
        /unset CLAUDECODE && \/usr\/local\/bin\/claude --dangerously-skip-permissions --model sonnet/,
      );
      assert.doesNotMatch(cmd, /--dangerously-bypass-approvals-and-sandbox/);
      assert.match(
        cmd,
        /install-runner-observability\.mjs' --runner 'claude' --repo '\/tmp\/repo'/,
      );
      assert.doesNotMatch(cmd, /farmslot-observability-hook\.mjs/);
      assert.doesNotMatch(cmd, /base64 --decode/);
      assert.doesNotMatch(cmd, /import fs from/);
    });

    it('inline-launches interactively by default so relaunch paths stay steerable', () => {
      const vars = makeVars({ dispatchCmd: '' });
      const cmd = buildLaunchCommand(vars, 'claude', 'sonnet', PROMPT);
      assert.doesNotMatch(cmd, /--dangerously-/);
      assert.doesNotMatch(cmd, /--print/);
      assert.doesNotMatch(cmd, /Read TASK/);
      assert.match(cmd, /install-runner-observability\.mjs/);
      assert.match(
        cmd,
        /cd '\/tmp\/repo' && unset CLAUDECODE && \/usr\/local\/bin\/claude --model sonnet$/,
      );
    });

    it('routes through expandDispatchCmd when claudeUsesDispatchCmd=true', () => {
      const vars = makeVars({
        dispatchCmd: 'cd {repo} && {claude_path} --model {model} {task_file}',
      });
      const cmd = buildLaunchCommand(vars, 'claude', 'opus', PROMPT, {
        taskFile: TASK_FILE,
        claudeUsesDispatchCmd: true,
      });
      assert.match(cmd, /install-runner-observability\.mjs/);
      assert.match(
        cmd,
        /unset CLAUDECODE && cd \/tmp\/repo && \/usr\/local\/bin\/claude --model opus \.task\/fix\/abc\/TASK\.md/,
      );
    });

    it('passes project runtimeDir through to observability install', () => {
      const vars = makeVars({ dispatchCmd: '' });
      const cmd = buildLaunchCommand(vars, 'claude', 'sonnet', PROMPT, {
        runtimeDir: 'temp/recipe/runtime',
      });
      assert.match(cmd, /--runtime-dir 'temp\/recipe\/runtime'/);
      assert.doesNotMatch(cmd, /--runtime-dir '\.agent'/);
    });

    it('uses a shell-safe HOME expression for remote observability installs', () => {
      const vars = makeVars({ host: 'remote-mac', remoteRepo: '~/work/repo' });
      const cmd = buildLaunchCommand(vars, 'claude', 'sonnet', PROMPT);
      assert.match(
        cmd,
        /node "\$\{HOME\}\/farmslot-node\/scripts\/install-runner-observability\.mjs"/,
      );
      assert.match(cmd, /--repo "\$\{HOME\}\/work\/repo"/);
      assert.match(cmd, /cd "\$\{HOME\}\/work\/repo" && unset CLAUDECODE/);
    });

    it('appends modelFlag when dispatch_cmd lacks {model} placeholder', () => {
      const vars = makeVars({
        dispatchCmd: 'cd {repo} && {claude_path}',
      });
      const cmd = buildLaunchCommand(vars, 'claude', 'sonnet', PROMPT, {
        taskFile: TASK_FILE,
        claudeUsesDispatchCmd: true,
      });
      assert.match(cmd, / --model sonnet$/);
    });

    it('does not append modelFlag when model is null or "unknown"', () => {
      const vars = makeVars({ dispatchCmd: '' });
      const cmdNull = buildLaunchCommand(vars, 'claude', null, PROMPT);
      const cmdUnknown = buildLaunchCommand(vars, 'claude', 'unknown', PROMPT);
      assert.doesNotMatch(cmdNull, /--model/);
      assert.doesNotMatch(cmdUnknown, /--model/);
    });

    it('throws when claudeUsesDispatchCmd=true but no dispatch_cmd is configured', () => {
      const vars = makeVars({ dispatchCmd: '', machine: 'runner-a' });
      assert.throws(
        () => buildLaunchCommand(vars, 'claude', 'sonnet', PROMPT, { claudeUsesDispatchCmd: true }),
        /No dispatch_cmd in pool config for runner-a/,
      );
    });
  });

  describe('codex runner', () => {
    it('falls back to inline exec-mode launcher when dispatch_cmd is absent', () => {
      // Without an explicit tier, Codex now defaults to sandboxed (ADR-023 §3).
      // The dangerous flag only appears when a project/dispatch explicitly opts in.
      const vars = makeVars({ dispatchCmd: '' });
      const cmd = buildLaunchCommand(vars, 'codex', 'gpt-5', PROMPT, { safetyTier: 'dangerous' });
      assert.match(cmd, /codex --dangerously-bypass-approvals-and-sandbox .*--model gpt-5/);
      assert.match(cmd, /install-runner-observability\.mjs' --runner 'codex'/);
      assertCodexWorkerDoesNotInjectMcpOverrides(cmd);
      assert.doesNotMatch(cmd, /model_reasoning_effort/);
      assert.doesNotMatch(cmd, /'Read TASK\.md and execute\.'/);
    });

    it('routes through expandDispatchCmd when dispatch_cmd is runner-aware via {codex_path}', () => {
      const vars = makeVars({
        dispatchCmd: 'cd {repo} && {codex_path} --model {model}',
      });
      const cmd = buildLaunchCommand(vars, 'codex', 'gpt-5', PROMPT);
      assert.match(
        cmd,
        /unset CLAUDECODE && cd \/tmp\/repo && \/usr\/local\/bin\/codex .*--model gpt-5/,
      );
      assert.match(cmd, /install-runner-observability\.mjs' --runner 'codex'/);
      assertCodexWorkerDoesNotInjectMcpOverrides(cmd);
      assert.doesNotMatch(cmd, /model_reasoning_effort/);
      assert.doesNotMatch(cmd, /--dangerously-bypass-approvals-and-sandbox/);
      assert.doesNotMatch(cmd, /Read TASK\.md and execute\./);
    });

    it('routes through expandDispatchCmd when dispatch_cmd uses {runner_path}', () => {
      const vars = makeVars({
        dispatchCmd: 'cd {repo} && {runner_path}',
      });
      const cmd = buildLaunchCommand(vars, 'codex', 'gpt-5', PROMPT);
      assert.match(cmd, /unset CLAUDECODE && cd \/tmp\/repo && \/usr\/local\/bin\/codex/);
      assert.doesNotMatch(cmd, /model_reasoning_effort/);
    });

    it('falls back to inline launcher when dispatch_cmd exists but is claude-shaped', () => {
      const vars = makeVars({
        dispatchCmd: 'cd {repo} && {claude_path}',
      });
      const cmd = buildLaunchCommand(vars, 'codex', 'gpt-5', PROMPT, { safetyTier: 'dangerous' });
      assert.match(cmd, /codex --dangerously-bypass-approvals-and-sandbox/);
    });

    it('exposes hook-file observability provider after Phase 1.5', () => {
      assert.equal(getRunnerDefinition('codex').observabilityScope, 'event-driven');
      assert.ok(getRunnerObservability('codex'));
    });
  });

  describe('opencode runner', () => {
    it('requires a runner-aware dispatch_cmd', () => {
      const vars = makeVars({ dispatchCmd: '', machine: 'runner-a' });
      assert.throws(
        () => buildLaunchCommand(vars, 'opencode', null, PROMPT),
        /Runner 'opencode' requires a runner-aware dispatch_cmd on runner-a/,
      );
    });

    it('launches via expandDispatchCmd when dispatch_cmd uses {opencode_path}', () => {
      const vars = makeVars({
        dispatchCmd: 'cd {repo} && {opencode_path}',
      });
      const cmd = buildLaunchCommand(vars, 'opencode', null, PROMPT);
      assert.match(cmd, /unset CLAUDECODE && cd \/tmp\/repo && \/usr\/local\/bin\/opencode/);
    });

    it('launches via expandDispatchCmd when dispatch_cmd uses {runner}', () => {
      const vars = makeVars({
        dispatchCmd: 'cd {repo} && {runner}',
      });
      const cmd = buildLaunchCommand(vars, 'opencode', null, PROMPT);
      assert.match(cmd, /unset CLAUDECODE && cd \/tmp\/repo && opencode/);
    });
  });

  describe('cursor runner', () => {
    it('falls back to bare `cursor-agent` on PATH when no cursor_path is configured', () => {
      const vars = makeVars({ dispatchCmd: '', cursorPath: '' });
      const cmd = buildLaunchCommand(vars, 'cursor', null, PROMPT);
      assert.equal(
        cmd,
        "cd '/tmp/repo' && cursor-agent --sandbox enabled --model composer-2.5 'Read TASK.md and execute.'",
      );
    });

    it('falls back to inline Cursor Agent launcher with composer-2.5 default model', () => {
      const vars = makeVars({ dispatchCmd: '', cursorPath: '/usr/local/bin/cursor-agent' });
      const cmd = buildLaunchCommand(vars, 'cursor', null, PROMPT);
      assert.equal(
        cmd,
        "cd '/tmp/repo' && /usr/local/bin/cursor-agent --sandbox enabled --model composer-2.5 'Read TASK.md and execute.'",
      );
      assert.match(cmd, /Read TASK/);
      assert.doesNotMatch(cmd, /--print/);
      assert.doesNotMatch(cmd, /--trust/);
      assert.doesNotMatch(cmd, /--force/);
      assert.doesNotMatch(cmd, /--dangerously-/);
      assert.doesNotMatch(cmd, /CLAUDECODE/);
    });

    it('uses selected model and configured cursor path for inline launch', () => {
      const vars = makeVars({ dispatchCmd: '', cursorPath: '/opt/cursor/bin/agent' });
      const cmd = buildLaunchCommand(vars, 'cursor', 'sonnet-4', PROMPT, {
        safetyTier: 'full-auto',
      });
      assert.equal(
        cmd,
        "cd '/tmp/repo' && /opt/cursor/bin/agent --force --sandbox enabled --model sonnet-4 'Read TASK.md and execute.'",
      );
      assert.match(cmd, /Read TASK/);
      assert.doesNotMatch(cmd, /--print/);
      assert.doesNotMatch(cmd, /--trust/);
    });

    it('routes through expandDispatchCmd when dispatch_cmd uses {cursor_path}', () => {
      const vars = makeVars({
        dispatchCmd: 'cd {repo} && {cursor_path} {safety_flags} --model {model} {task_prompt}',
      });
      const cmd = buildLaunchCommand(vars, 'cursor', DEFAULT_CURSOR_MODEL, PROMPT, {
        safetyTier: 'dangerous',
      });
      assert.match(
        cmd,
        /cd \/tmp\/repo && \/usr\/local\/bin\/cursor-agent --force --sandbox disabled --model composer-2.5 Read TASK\.md and execute\.$/,
      );
      assert.match(cmd, /Read TASK\.md and execute\./);
      assert.doesNotMatch(cmd, /CLAUDECODE/);
    });
  });

  describe('grok runner', () => {
    it('falls back to bare `grok` on PATH when no grok_path is configured', () => {
      const vars = makeVars({ dispatchCmd: '', grokPath: '' });
      const cmd = buildLaunchCommand(vars, 'grok', null, PROMPT);
      assert.equal(cmd, "cd '/tmp/repo' && grok --model grok-build");
    });

    it('falls back to inline Grok launcher with grok-build default model', () => {
      const vars = makeVars({ dispatchCmd: '', grokPath: '/usr/local/bin/grok' });
      const cmd = buildLaunchCommand(vars, 'grok', null, PROMPT);
      assert.equal(cmd, "cd '/tmp/repo' && /usr/local/bin/grok --model grok-build");
      assert.doesNotMatch(cmd, /Read TASK/);
      assert.doesNotMatch(cmd, /--single/);
      assert.doesNotMatch(cmd, /--print/);
    });

    it('uses selected model, effort, and configured grok path for inline launch', () => {
      const vars = makeVars({ dispatchCmd: '', grokPath: '/Users/deeeed/.grok/bin/grok' });
      const cmd = buildLaunchCommand(vars, 'grok', 'grok-composer-2.5-fast', PROMPT, {
        effort: 'xhigh',
        safetyTier: 'full-auto',
      });
      assert.equal(
        cmd,
        "cd '/tmp/repo' && /Users/deeeed/.grok/bin/grok --permission-mode auto --effort xhigh --model grok-composer-2.5-fast",
      );
    });

    it('routes through expandDispatchCmd when dispatch_cmd uses {grok_path}', () => {
      const vars = makeVars({
        dispatchCmd:
          'cd {repo} && {grok_path} {safety_flags} --effort {effort} --model {model} {task_prompt}',
      });
      const cmd = buildLaunchCommand(vars, 'grok', DEFAULT_GROK_MODEL, PROMPT, {
        effort: 'high',
        safetyTier: 'dangerous',
      });
      assert.match(
        cmd,
        /cd \/tmp\/repo && \/usr\/local\/bin\/grok --permission-mode bypassPermissions --effort high --model grok-build$/,
      );
      assert.doesNotMatch(cmd, /Read TASK\.md and execute\./);
      assert.doesNotMatch(cmd, /CLAUDECODE/);
    });
  });

  describe('fake runner', () => {
    it('uses the local npx harness and ignores dispatch_cmd entirely', () => {
      const vars = makeVars({
        dispatchCmd: 'cd {repo} && {claude_path} --model {model}',
      });
      const cmd = buildLaunchCommand(vars, 'fake', 'sonnet', PROMPT, { taskDir: TASK_DIR });
      assert.equal(
        cmd,
        `cd '/tmp/repo' && npx farmslot fake-runner --task-dir '${TASK_DIR}' --scenario success --step-delay-ms 500`,
      );
    });

    it('throws when taskDir is missing (fake harness needs it)', () => {
      const vars = makeVars();
      assert.throws(
        () => buildLaunchCommand(vars, 'fake', null, PROMPT),
        /Runner 'fake' requires opts.taskDir/,
      );
    });
  });

  describe('none runner', () => {
    it('returns empty string (no launch command)', () => {
      const vars = makeVars();
      assert.equal(buildLaunchCommand(vars, 'none', null, PROMPT), '');
    });
  });

  describe('commandIsRunnerAware detection (internal)', () => {
    it('callers do not need to detect runner-awareness themselves — proven by the codex fallback test above', () => {
      // Regression guard: both the runner-aware and non-aware branches are covered by the codex tests.
      // If a caller ever needs to duplicate this detection, that indicates the abstraction has leaked.
      const vars = makeVars({ dispatchCmd: 'cd {repo} && {claude_path}' });
      // With a claude-shaped dispatch_cmd, codex should silently fall back to inline exec —
      // no caller-side detection required. Tier must be explicit for the flag.
      const cmd = buildLaunchCommand(vars, 'codex', null, PROMPT, { safetyTier: 'dangerous' });
      assert.match(cmd, /--dangerously-bypass-approvals-and-sandbox/);
    });
  });
});
