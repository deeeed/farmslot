import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { DEFAULT_CURSOR_MODEL, DEFAULT_GROK_MODEL } from '@farmslot/protocol';

import {
  buildCodexExecLaunch,
  buildLaunchCommand,
  buildRunnerSessionReloadCommand,
  withTaskRecipeTrustEnvironment,
} from './launch-command.js';
import { readPaneStateFromCapture } from './pane-state-script.js';
import { resolveWorkerDispatchPrompt } from './worker-prompt.js';

const CLEAR_RECIPE_TRUST_ENV =
  'unset FARMSLOT_RECIPE_SOURCE_TRUST FARMSLOT_RECIPE_SOURCE_KIND FARMSLOT_RECIPE_SOURCE_NAME FARMSLOT_RECIPE_SOURCE_DIGEST FARMSLOT_RECIPE_APPROVE_PLAN; ';

async function dispatchPrompt(taskFile: string): Promise<string> {
  return resolveWorkerDispatchPrompt('farmslot-farm', { taskFile });
}

describe('recipe source trust environment', () => {
  it('marks task-scoped PR recipe input untrusted before launching any runner', () => {
    const command = withTaskRecipeTrustEnvironment(
      'cd /repo && claude',
      '/repo',
      '.task/review/pr-1',
    );
    assert.match(command, /inputs\/inherited\/recipe-source\.json/);
    assert.match(command, /FARMSLOT_RECIPE_SOURCE_TRUST=untrusted/);
    assert.match(command, /FARMSLOT_RECIPE_SOURCE_KIND=task/);
    assert.match(command, /FARMSLOT_RECIPE_SOURCE_NAME=task-inherited/);
    assert.match(command, /else unset FARMSLOT_RECIPE_SOURCE_TRUST/);
    assert.match(command, /; cd \/repo && claude$/);
  });

  it('clears stale recipe provenance without a task directory', () => {
    const command = withTaskRecipeTrustEnvironment('claude', '/repo');
    assert.match(command, /^unset FARMSLOT_RECIPE_SOURCE_TRUST /);
    assert.match(command, /FARMSLOT_RECIPE_APPROVE_PLAN; claude$/);
  });
});
import {
  assertSupportedRunnerSpelling,
  confirmTrustPromptWithFreshEvidence,
  detectRunnerLaunchBlocker,
  getRunnerDefinition,
  getRunnerObservability,
  grokPaneShowsColdStartSession,
  isRunnerPaneRetired,
  keyForClassifierTrustAction,
  normalizeRunner,
  resolveSafeSendTimeoutMs,
  RUNNER_HOOK_SAFE_SEND_TIMEOUT_MS,
  RUNNER_PANE_SAFE_SEND_TIMEOUT_MS,
  runnerBufferedInstructionSubmitKey,
  runnerContinueCommand,
  runnerDefaultModel,
  runnerLineLooksWaiting,
  runnerNeedsPostLaunchPrompt,
  runnerPaneComposerDraftState,
  runnerPaneHasBufferedInstruction,
  runnerPaneHasPendingInstruction,
  runnerPaneHasProgressAfterInstruction,
  runnerPaneHasQueuedInstruction,
  runnerPaneLooksIdle,
  runnerPaneShouldSubmitExistingInstruction,
  runnerPaneShowsCurrentInteractiveProgress,
  runnerPaneShowsPreSendDuplicateInstruction,
  runnerPaneShowsPromptAccepted,
  runnerPaneShowsSubmittedInstruction,
  runnerPaneShowsTaskAlreadyRunning,
  runnerPaneShowsWorkspaceTrustPrompt,
  runnerPersistsSessionFiles,
  runnerProcessPattern,
  runnerProcessPatternSource,
  runnerResolvesPreTaskLaunchBlockers,
  runnerSignalShowsCompletion,
  runnerSupportsInteractivePrompt,
  runnerSupportsModel,
  runnerSupportsTmuxNudges,
} from './registry.js';
import { assertCodexWorkerDoesNotInjectMcpOverrides, makeVars } from './test-fixtures.js';

describe('scripted runner', () => {
  it('has exec launch mode', () => {
    assert.equal(getRunnerDefinition('scripted').defaultLaunchMode, 'exec');
  });

  it('does not support interactive prompt', () => {
    assert.equal(runnerSupportsInteractivePrompt('scripted'), false);
  });

  it('does not support tmux nudges', () => {
    assert.equal(runnerSupportsTmuxNudges('scripted'), false);
  });

  it('does not need post-launch prompt', () => {
    assert.equal(runnerNeedsPostLaunchPrompt('scripted'), false);
  });

  it('does not resolve pre-task launch blockers', () => {
    assert.equal(runnerResolvesPreTaskLaunchBlockers('scripted'), false);
  });

  it('has null continue command', () => {
    assert.equal(runnerContinueCommand('scripted'), null);
  });

  it('matches scripted-runner process patterns', () => {
    const pattern = runnerProcessPattern('scripted');
    assert.ok(pattern.test('farmslot scripted-runner'));
    assert.ok(pattern.test('scripted-runner'));
  });

  it('rejects legacy fake runner ids instead of publishing them as aliases', () => {
    assert.equal(normalizeRunner('fake'), 'fake');
    assert.throws(() => assertSupportedRunnerSpelling('fake'), /use runner 'scripted'/);
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
    // Use the isolated codex-home only if provisioned; otherwise fall back to global.
    assert.match(
      launch,
      /if \[ -e '\/workspace\/repo\/\.agent\/codex-home\/auth\.json' \]; then export CODEX_HOME='\/workspace\/repo\/\.agent\/codex-home'; else .*fi/,
    );
    assert.match(
      launch,
      /codex --disable plugin_hooks --dangerously-bypass-approvals-and-sandbox .*--model gpt-5\.5/,
    );
    assertCodexWorkerDoesNotInjectMcpOverrides(launch);
    assert.match(launch, /model_reasoning_effort="xhigh"/);
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
    assert.match(
      launch,
      /then export CODEX_HOME='\/workspace\/repo\/\.agent\/codex-home'; else .*fi/,
    );
    assert.match(
      launch,
      /codex --disable plugin_hooks --dangerously-bypass-approvals-and-sandbox .*model_reasoning_effort="xhigh".*--model gpt-5\.5$/,
    );
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
    assert.equal(runnerResolvesPreTaskLaunchBlockers('cursor'), true);
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

  it('treats a later idle prompt as ending stale progress text', () => {
    assert.equal(
      runnerPaneShowsCurrentInteractiveProgress('• Explored\nReview finished\n›', 'codex'),
      false,
    );
    assert.equal(
      runnerPaneShowsCurrentInteractiveProgress('✻ Explored 2 files\nReview finished\n❯', 'claude'),
      false,
    );
    assert.equal(runnerPaneShowsCurrentInteractiveProgress('✻ Reading…', 'claude'), true);
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

  it('maps classifier trust_prompt/send_yes to the Grok project-directory confirmation key', () => {
    const pane = `
  Run Grok Build in a project directory?
  1 (○) farmslot-grok-probe (current)
  Enter:submit
`;
    assert.equal(
      keyForClassifierTrustAction(
        { state: 'trust_prompt', confidence: 0.99, suggestedAction: 'send_yes' },
        'grok',
        pane,
      ),
      'Enter',
    );
    assert.equal(
      keyForClassifierTrustAction(
        { state: 'trust_prompt', confidence: 0.99, suggestedAction: 'send_yes' },
        'cursor',
        `
  ▶ [a] Trust this workspace
    [q] Quit
  Use arrow keys to navigate
`,
      ),
      'a',
    );
    // Truncated pane: detector may miss markers, but classifier send_yes still
    // maps to Grok's confirmation key so ready-timeout recovery can fire.
    assert.equal(
      keyForClassifierTrustAction(
        { state: 'trust_prompt', confidence: 0.99, suggestedAction: 'send_yes' },
        'grok',
        'Run Grok Build in a project directory?\n1 (○) probe',
      ),
      'Enter',
    );
    assert.equal(
      keyForClassifierTrustAction(
        { state: 'ready', confidence: 0.99, suggestedAction: 'send_yes' },
        'grok',
        pane,
      ),
      null,
    );
  });

  it('confirmTrustPromptWithFreshEvidence sends the detector key for the captured target', async () => {
    const grokPane = `
  ┃  Run Grok Build in a project directory?
  ┃  1 (○) farmslot-grok-probe (current)
  ┃  ↑/↓ navigate · y copy                                    Enter:submit
`;
    const commands: string[] = [];
    const result = await confirmTrustPromptWithFreshEvidence({
      runnerId: 'grok',
      target: 'ff-2:agent.0',
      logPrefix: 'test',
      exec: async (tmuxCommand) => {
        commands.push(tmuxCommand);
        return { exitCode: 0, stdout: tmuxCommand.startsWith('capture-pane') ? grokPane : '' };
      },
    });
    assert.deepEqual(result, { outcome: 'sent', key: 'Enter' });
    assert.equal(commands.length, 2);
    assert.match(commands[0], /^capture-pane -p -t 'ff-2:agent\.0'/);
    assert.match(commands[1], /^send-keys -t 'ff-2:agent\.0' 'Enter'/);
  });

  it('confirmTrustPromptWithFreshEvidence maps a cursor workspace-trust capture to the a key', async () => {
    const cursorPane = `
  ▶ [a] Trust this workspace
    [q] Quit
  Use arrow keys to navigate
`;
    const commands: string[] = [];
    const result = await confirmTrustPromptWithFreshEvidence({
      runnerId: 'cursor',
      target: 'ff-1:agent.0',
      logPrefix: 'test',
      exec: async (tmuxCommand) => {
        commands.push(tmuxCommand);
        return { exitCode: 0, stdout: tmuxCommand.startsWith('capture-pane') ? cursorPane : '' };
      },
    });
    assert.deepEqual(result, { outcome: 'sent', key: 'a' });
    assert.match(commands[1], /^send-keys -t 'ff-1:agent\.0' 'a'/);
  });

  it('refreshes and trusts changed Codex repository hooks', async () => {
    const codexPane = `
  Hooks need review
  1. Review hooks
  2. Trust all and continue
  3. Continue without trusting (hooks won't run)
  Press enter to confirm or esc to go back
`;
    assert.deepEqual(detectRunnerLaunchBlocker(codexPane, 'codex'), {
      kind: 'hooks-review',
      summary: 'Codex is waiting for repository hook review before the chat input is available.',
      autoAction: 'codex-refresh-hooks-and-trust',
    });

    const commands: string[] = [];
    let refreshed = false;
    const result = await confirmTrustPromptWithFreshEvidence({
      runnerId: 'codex',
      target: 'core-2:review.0',
      logPrefix: 'test',
      exec: async (tmuxCommand) => {
        commands.push(tmuxCommand);
        return { exitCode: 0, stdout: tmuxCommand.startsWith('capture-pane') ? codexPane : '' };
      },
      refreshCodexHooks: async () => {
        refreshed = true;
      },
    });

    assert.equal(refreshed, true);
    assert.deepEqual(result, { outcome: 'sent', key: '2' });
    assert.match(commands[1], /^send-keys -t 'core-2:review\.0' '2' 'Enter'/);
  });

  it('confirmTrustPromptWithFreshEvidence never sends without fresh deterministic evidence', async () => {
    const commands: string[] = [];
    const result = await confirmTrustPromptWithFreshEvidence({
      runnerId: 'grok',
      target: 'ff-2:agent.0',
      logPrefix: 'test',
      exec: async (tmuxCommand) => {
        commands.push(tmuxCommand);
        // Fresh capture shows a ready pane — the trust prompt is gone.
        return { exitCode: 0, stdout: 'grok> awaiting your instructions' };
      },
    });
    assert.deepEqual(result, { outcome: 'no-fresh-evidence' });
    assert.equal(commands.length, 1);
    assert.match(commands[0], /^capture-pane/);
  });

  it('confirmTrustPromptWithFreshEvidence surfaces a failed send instead of swallowing it', async () => {
    const grokPane = `
  ┃  Run Grok Build in a project directory?
  ┃  1 (○) farmslot-grok-probe (current)
  ┃  ↑/↓ navigate · y copy                                    Enter:submit
`;
    await assert.rejects(
      () =>
        confirmTrustPromptWithFreshEvidence({
          runnerId: 'grok',
          target: 'ff-2:agent.0',
          logPrefix: 'test',
          exec: async (tmuxCommand) =>
            tmuxCommand.startsWith('capture-pane')
              ? { exitCode: 0, stdout: grokPane }
              : { exitCode: 1, stdout: '', stderr: 'no such pane' },
        }),
      /Failed to apply trust confirmation Enter in ff-2:agent\.0: no such pane/,
    );
  });

  it('classifies auth blockers without assigning an unsafe auto action', () => {
    const pane = 'Authentication expired. Please run cursor-agent login to continue.';
    assert.deepEqual(detectRunnerLaunchBlocker(pane, 'cursor'), {
      kind: 'auth-required',
      summary: 'cursor requires login/authentication before Farmslot can deliver the task prompt.',
      autoAction: null,
    });
  });

  it('classifies real Claude and Codex expired-auth prompts', () => {
    const panes = [
      { runner: 'claude', text: 'OAuth token has expired. Please run /login.' },
      { runner: 'claude', text: 'Invalid API key · please run /login' },
      { runner: 'claude', text: 'Login expired. Please re-authenticate.' },
      { runner: 'codex', text: 'Session expired. Run codex login to reauthenticate.' },
      { runner: 'codex', text: 'Authentication is required to continue.' },
      { runner: 'cursor', text: 'Login is required before starting a session.' },
    ];

    for (const { runner, text } of panes) {
      assert.deepEqual(detectRunnerLaunchBlocker(text, runner), {
        kind: 'auth-required',
        summary: `${runner} requires login/authentication before Farmslot can deliver the task prompt.`,
        autoAction: null,
      });
      assert.equal(readPaneStateFromCapture(text, runner).launchBlocker, 'auth-required');
    }
  });

  it('classifies codex usage-limit banners as launch blockers', () => {
    const pane = [
      '╭──────────────────────────────────────╮',
      "│ You've reached your usage limit.      │",
      '│ Your limit resets at 3:00 PM.         │',
      '╰──────────────────────────────────────╯',
    ].join('\n');
    assert.deepEqual(detectRunnerLaunchBlocker(pane, 'codex'), {
      kind: 'usage-limit',
      summary:
        'codex hit a usage/rate limit — the composer will not accept prompts until the limit resets.',
      autoAction: null,
    });
  });

  it('classifies weekly-limit-reached banners as usage-limit blockers', () => {
    const pane = 'Weekly limit reached. Upgrade or wait for the limit to reset.';
    assert.equal(detectRunnerLaunchBlocker(pane, 'claude')?.kind, 'usage-limit');
  });

  it('does not classify ordinary limit prose as a usage-limit blocker', () => {
    const pane = [
      'Applied rate limiting to the API client with a token bucket.',
      'The session limit config option defaults to 50.',
      'The weekly limit was reached in tests before the fix landed.',
      'The limit resets in cleanup between test cases.',
      "You've reached your desired coverage limit in tests.",
      'Added handling for weekly limit reached errors in the retry path.',
      '› ',
    ].join('\n');
    assert.equal(detectRunnerLaunchBlocker(pane, 'codex'), null);
  });

  it('ignores usage-limit banners that scrolled out of the pane tail', () => {
    const lines = ["You've reached your usage limit."];
    for (let i = 0; i < 25; i++) lines.push(`transcript line ${i}`);
    lines.push('› ');
    assert.equal(detectRunnerLaunchBlocker(lines.join('\n'), 'codex'), null);
  });

  it('does not classify optional MCP login warnings as runner auth blockers', async () => {
    const pane = [
      'MCP startup failed: handshaking with MCP server failed',
      'The sentry MCP server is not logged in. Run `codex mcp login sentry`.',
    ].join('\n');

    assert.equal(detectRunnerLaunchBlocker(pane, 'codex'), null);
  });

  it('does not classify generic unauthorized app output as runner auth blockers', () => {
    const pane = [
      'gh api returned HTTP 401: Unauthorized',
      'app log: session expired for test fixture',
      '❯ ',
    ].join('\n');

    assert.equal(detectRunnerLaunchBlocker(pane, 'codex'), null);
  });

  it('does not combine auth words across unrelated lines of leftover pane prose', () => {
    // Prior worker's recap left on screen: "auth" and "needed" live on separate
    // lines and neither line is itself an auth blocker. Flattening the whole pane
    // used to merge them into one false auth-required match.
    const pane = [
      'writes need auth + hit a hook, and two things stacked:',
      '1. osxkeychain credential helper blocks waiting for keychain access.',
      'Install the observability hooks where needed before launch.',
      '❯ ',
    ].join('\n');

    assert.equal(detectRunnerLaunchBlocker(pane, 'claude'), null);
  });

  it('does not classify shell launch command text with auth.json paths as runner auth blockers', () => {
    const pane = [
      'export DISABLE_OMC=1 DISABLE_OMX=1; ASDF_SHIMS="${ASDF_DATA_DIR:-$HOME/.asdf}/shims"; if [ -d "$ASDF_SHIMS" ]; then export PATH="$ASDF_SHIMS:$PATH"; fi &&',
      "(node '/Users/deeeed/dev/farmslot/scripts/install-runner-observability.mjs' --runner 'codex' --repo '/Users/deeeed/dev/farmslot-wt/farmslot-3' --runtime-dir '.sandbox/farmslot-farm/agent' --slot-id 'macwork-ff-3' || echo '[farmslot-observability] install failed; continuing without hooks' >&2) && unset CLAUDECODE && cd '/Users/deeeed/dev/farmslot-wt/farmslot-3' && if [ -e '/Users/deeeed/dev/farmslot-wt/farmslot-3/.sandbox/farmslot-farm/agent/codex-home/auth.json' ]; then export CODEX_HOME='/Users/deeeed/dev/farmslot-wt/farmslot-3/.sandbox/farmslot-farm/agent/codex-home'; fi && /Users/deeeed/.npm-global/bin/codex --model gpt-5.5",
      '╭───────────────────────────────────────────╮',
      '│ >_ OpenAI Codex (v0.144.0)                │',
      '╰───────────────────────────────────────────╯',
      '• You have 3 usage limit resets available. Run /usage to use one.',
      '› Find and fix a bug in @filename',
    ].join('\n');

    assert.equal(detectRunnerLaunchBlocker(pane, 'codex'), null);
    assert.equal(readPaneStateFromCapture(pane, 'codex').launchBlocker, null);
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

  it('recognizes Claude Effecting progress labels during readiness wait', async () => {
    const message = await dispatchPrompt('temp/tasks/feat/tat-3463-0630-074758/SELF-REVIEW.md');
    const pane = `
❯ Follow the checklist in temp/tasks/feat/tat-3463-0630-074758/SELF-REVIEW.md. After each step, run
  temp/tasks/feat/tat-3463-0630-074758/mark N before continuing.

✻ Effecting… (1m 24s · thought for 2s)

───────────────────────────────────────────────────────────────────────────────
  fs · Opus 4.8 · ctx:5%
`;

    assert.equal(
      runnerPaneShowsTaskAlreadyRunning(pane, message, 'SELF-REVIEW.md', 'claude'),
      true,
    );
  });

  it('recognizes a Codex task already executing (animated "Working (…)" timer) during readiness wait', async () => {
    const message = await dispatchPrompt('temp/tasks/feat/tat-3215-0601-200704/TASK.md');
    const pane = `
• Read temp/tasks/feat/tat-3215-0601-200704/TASK.md
• Explored
  └ Read recipe-quality.md, demo-red-banner.recipe.json
• Working (2m 02s • esc to interrupt)

› Use /skills to list available skills
  gpt-5.5 default · ~/dev/farmslot-wt/farmslot-2
`;

    // Regression: codex was excluded from the progress detector, so the readiness gate
    // never saw "task already running" and falsely timed out against the animated timer.
    assert.equal(runnerPaneShowsTaskAlreadyRunning(pane, message, 'TASK.md', 'codex'), true);
  });

  it('does not flag an idle Codex prompt as a task already running', async () => {
    const message = await dispatchPrompt('temp/tasks/feat/tat-3215-0601-200704/TASK.md');
    const idlePane = `
› Use /skills to list available skills
  gpt-5.5 default · ~/dev/farmslot-wt/farmslot-2
`;

    assert.equal(runnerPaneShowsTaskAlreadyRunning(idlePane, message, 'TASK.md', 'codex'), false);
  });

  it('detects a Codex task already executing so the send-retry loop skips a duplicate send', async () => {
    const message = await dispatchPrompt('temp/tasks/feat/28-0629-224637/TASK.md');
    // Real incident: attempt 1 was accepted (codex Working) but its verify window closed
    // before "Working" rendered, so the loop re-sent and the duplicate landed as a queued
    // draft. The send loop now re-checks this guard before each send.
    const pane = `
• Ran .sandbox/farmslot-farm/worker-task/feat/28-0629-224637/mark 6
• I'm running the baseline recipe now.
• Working (3m 35s • esc to interrupt) · 1 background terminal running
› Follow the checklist in temp/tasks/feat/28-0629-224637/TASK.md. After each step, run mark N before continuing.
  tab to queue message                                                          87% context left
`;
    assert.equal(runnerPaneShowsTaskAlreadyRunning(pane, message, 'TASK.md', 'codex'), true);
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
    const message = await dispatchPrompt(
      'temp/tasks/fix/eval-bf5e8c3f61bd-clean-extension-42435-harness-4d24c9dd-5057557b-0525-022117/SELF-REVIEW-FIX.md',
    );
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

  it('accepts composer-2.5, cursor-grok-4.5-high-fast, and account-specific model names', () => {
    assert.equal(runnerSupportsModel('cursor', DEFAULT_CURSOR_MODEL), true);
    assert.equal(runnerSupportsModel('cursor', 'cursor-grok-4.5-high-fast'), true);
    assert.equal(runnerSupportsModel('cursor', 'sonnet-4-thinking'), true);
    assert.equal(getRunnerDefinition('cursor').acceptsModel?.(null as any), false);
  });
});

describe('pre-task launch blocker resolution', () => {
  it('is only enabled for runners that need argv-prompt blockers cleared before task start', () => {
    assert.equal(runnerResolvesPreTaskLaunchBlockers('cursor'), true);
    assert.equal(runnerResolvesPreTaskLaunchBlockers('codex'), false);
    assert.equal(runnerResolvesPreTaskLaunchBlockers('claude'), false);
    assert.equal(runnerResolvesPreTaskLaunchBlockers('grok'), false);
    assert.equal(runnerResolvesPreTaskLaunchBlockers('opencode'), false);
    assert.equal(runnerResolvesPreTaskLaunchBlockers('none'), false);
  });
});

describe('grok runner', () => {
  it('is registered as an interactive runner with the shared Grok default model', () => {
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

  it('does not treat echoed Grok task text after ❯ as waiting for input', () => {
    assert.equal(
      runnerLineLooksWaiting(
        '❯ Follow the checklist in .sandbox/farmslot-farm/worker-task',
        'grok',
      ),
      false,
    );
  });

  it('treats Grok Starting session as not idle for post-launch prompt delivery', () => {
    const coldStart = `
    ⠋ Starting session… 5.0s

  ╭──────────────────────────────────────────────────────────────────────────╮
  │ ❯                                                                        │
  ╰───────────────────────────────────────────────────────────── Grok Build ─╯
`;
    assert.equal(grokPaneShowsColdStartSession(coldStart, 'grok'), true);
    assert.equal(runnerPaneLooksIdle(coldStart.split('\n'), 'grok'), false);
  });

  it('ignores stale Grok startup lines before the live composer', () => {
    const pane = `
     #1 Reply exactly OK.

    mcp (14/15)
    ⠋ Starting session… 5.0s

     #2 Summarize the previous task.

  ╭──────────────────────────────────────────────────────────────────────────╮
  │ ❯                                                                        │
  ╰───────────────────────────────────────────────────────────── Grok Build ─╯
`;

    assert.equal(detectRunnerLaunchBlocker(pane, 'grok'), null);
    assert.equal(grokPaneShowsColdStartSession(pane, 'grok'), false);
    assert.equal(runnerPaneLooksIdle(pane.split('\n'), 'grok'), true);
  });

  it('still defers Grok prompt delivery while the live session is starting', () => {
    const coldStart = `
     #1 Reply exactly OK.

    mcp (14/15)
    ⠋ Starting session… 5.0s

  ╭──────────────────────────────────────────────────────────────────────────╮
  │ ❯                                                                        │
  ╰───────────────────────────────────────────────────────────── Grok Build ─╯
`;

    assert.equal(detectRunnerLaunchBlocker(coldStart, 'grok')?.kind, 'mcp-init');
    assert.equal(runnerPaneLooksIdle(coldStart.split('\n'), 'grok'), false);
  });

  it('still detects Grok MCP status rendered above transcript history', () => {
    const pane = `
  feat/demo worktree ~/dev/farmslot-wt/farmslot-3 │ ⠼ MCP (14/15) │ 10K / 512K │ +1 │


     #1 Follow the checklist in TASK.md.

  ╭──────────────────────────────────────────────────────────────────────────╮
  │ ❯                                                                        │
  ╰───────────────────────────────────────────────────────────── Grok Build ─╯
`;

    assert.equal(detectRunnerLaunchBlocker(pane, 'grok')?.kind, 'mcp-init');
    assert.equal(runnerPaneLooksIdle(pane.split('\n'), 'grok'), false);
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

  it('does not treat Grok transcript history alone as a pre-send duplicate', () => {
    const message = 'Follow the checklist in TASK.md and mark each step done.';
    const transcriptOnly = `
     #1 Follow the checklist in TASK.md and mark each step done.

  ╭──────────────────────────────────────────────────────────────────────────╮
  │ ❯                                                                        │
  ╰───────────────────────────────────────────── Grok Build ─╯
`;
    assert.equal(runnerPaneShowsSubmittedInstruction(transcriptOnly, message, 'grok'), true);
    assert.equal(
      runnerPaneShowsPreSendDuplicateInstruction(transcriptOnly, message, 'grok'),
      false,
    );
  });

  it('treats Grok progress with the instruction as a pre-send duplicate', () => {
    const message = 'Reply exactly OK and do not edit files.';
    const running = `
     #1 Reply exactly OK and do not edit files.

    ⠋ Starting session… 5.0s

  ╭──────────────────────────────────────────────────────────────────────────╮
  │ ❯                                                                        │
  ╰───────────────────────────────────────────── Grok Build ─╯
`;
    assert.equal(runnerPaneShowsPreSendDuplicateInstruction(running, message, 'grok'), true);
  });

  it('does not treat Claude transcript history alone as a pre-send duplicate', () => {
    const message = 'Follow the checklist in TASK.md and mark each step done.';
    const transcriptOnly = `
❯ Follow the checklist in TASK.md and mark each step done.

✻ Worked for 2m 10s

────────────────────────────────────────────────────────────────────────────────
❯
────────────────────────────────────────────────────────────────────────────────
`;
    assert.equal(runnerPaneShowsSubmittedInstruction(transcriptOnly, message, 'claude'), true);
    assert.equal(
      runnerPaneShowsPreSendDuplicateInstruction(transcriptOnly, message, 'claude'),
      false,
    );
  });

  it('treats Claude progress with the instruction as a pre-send duplicate', () => {
    const message = 'Follow the checklist in TASK.md and mark each step done.';
    const running = `
❯ Follow the checklist in TASK.md and mark each step done.

✻ Working… (esc to interrupt)
`;
    assert.equal(runnerPaneShowsPreSendDuplicateInstruction(running, message, 'claude'), true);
  });
});

describe('custom runner fallback behavior', () => {
  it('uses the raw custom runner name as the process matcher source', () => {
    assert.equal(runnerProcessPatternSource('aider'), 'aider');
  });

  it('uses the broad catch-all when no runner is specified', () => {
    assert.equal(
      runnerProcessPatternSource(undefined),
      'claude|codex|opencode|cursor-agent|grok|scripted-runner',
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
    assert.equal(runnerPersistsSessionFiles('scripted'), false);
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

  it('derives recipe provenance scope from a task file when taskDir is omitted', () => {
    const vars = makeVars({ dispatchCmd: '' });
    const cmd = buildLaunchCommand(vars, 'claude', 'sonnet', PROMPT, {
      taskFile: TASK_FILE,
    });
    assert.match(cmd, /[.]task\/fix\/abc\/inputs\/inherited\/recipe-source[.]json/u);
    assert.match(cmd, /FARMSLOT_RECIPE_SOURCE_TRUST=untrusted/u);
  });

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
      assert.match(cmd, /CODEX_HOME='\/tmp\/repo\/\.agent\/codex-home'/);
      assert.match(
        cmd,
        /codex --disable plugin_hooks --dangerously-bypass-approvals-and-sandbox .*--model gpt-5/,
      );
      assert.match(cmd, /install-runner-observability\.mjs' --runner 'codex'/);
      assertCodexWorkerDoesNotInjectMcpOverrides(cmd);
      assert.match(cmd, /model_reasoning_effort="xhigh"/);
      assert.doesNotMatch(cmd, /'Read TASK\.md and execute\.'/);
    });

    it('routes through expandDispatchCmd when dispatch_cmd is runner-aware via {codex_path}', () => {
      const vars = makeVars({
        dispatchCmd: 'cd {repo} && {codex_path} --model {model}',
      });
      const cmd = buildLaunchCommand(vars, 'codex', 'gpt-5', PROMPT);
      // Isolated home only when provisioned; else fall back to global ~/.codex.
      assert.match(
        cmd,
        /if \[ -e '\/tmp\/repo\/\.agent\/codex-home\/auth\.json' \]; then export CODEX_HOME='\/tmp\/repo\/\.agent\/codex-home'; else .*fi && cd \/tmp\/repo && \/usr\/local\/bin\/codex .*--model gpt-5/,
      );
      // Must never seed (copy/symlink) into or write config back to the global ~/.codex.
      assert.doesNotMatch(cmd, /ln -sf "\$HOME\/\.codex/);
      assert.doesNotMatch(cmd, /cp "\$HOME\/\.codex/);
      assert.doesNotMatch(cmd, /codex-home\/config\.toml/);
      assert.match(cmd, /install-runner-observability\.mjs' --runner 'codex'/);
      assertCodexWorkerDoesNotInjectMcpOverrides(cmd);
      assert.match(cmd, /model_reasoning_effort="xhigh"/);
      assert.doesNotMatch(cmd, /--dangerously-bypass-approvals-and-sandbox/);
      assert.doesNotMatch(cmd, /Read TASK\.md and execute\./);
    });

    it('routes through expandDispatchCmd when dispatch_cmd uses {runner_path}', () => {
      const vars = makeVars({
        dispatchCmd: 'cd {repo} && {runner_path}',
      });
      const cmd = buildLaunchCommand(vars, 'codex', 'gpt-5', PROMPT);
      assert.match(
        cmd,
        /then export CODEX_HOME='\/tmp\/repo\/\.agent\/codex-home'; else .*fi && cd \/tmp\/repo && \/usr\/local\/bin\/codex/,
      );
      assert.match(cmd, /model_reasoning_effort="xhigh"/);
    });

    it('falls back to inline launcher when dispatch_cmd exists but is claude-shaped', () => {
      const vars = makeVars({
        dispatchCmd: 'cd {repo} && {claude_path}',
      });
      const cmd = buildLaunchCommand(vars, 'codex', 'gpt-5', PROMPT, { safetyTier: 'dangerous' });
      assert.match(cmd, /CODEX_HOME='\/tmp\/repo\/\.agent\/codex-home'/);
      assert.match(cmd, /codex --disable plugin_hooks --dangerously-bypass-approvals-and-sandbox/);
    });

    it('exposes hook-file observability provider after Phase 1.5', () => {
      assert.equal(getRunnerDefinition('codex').observabilityScope, 'event-driven');
      assert.ok(getRunnerObservability('codex'));
    });
  });

  describe('ADR-032 phase 2 safe-send timeouts', () => {
    it('uses hook timeout for event-driven runners with observability', () => {
      assert.equal(resolveSafeSendTimeoutMs('claude'), RUNNER_HOOK_SAFE_SEND_TIMEOUT_MS);
      assert.equal(resolveSafeSendTimeoutMs('codex'), RUNNER_HOOK_SAFE_SEND_TIMEOUT_MS);
    });

    it('uses pane timeout for pane-only runners', () => {
      assert.equal(resolveSafeSendTimeoutMs('grok'), RUNNER_PANE_SAFE_SEND_TIMEOUT_MS);
      assert.equal(resolveSafeSendTimeoutMs('cursor'), RUNNER_PANE_SAFE_SEND_TIMEOUT_MS);
    });
  });

  describe('ADR-032 phase 3 pane retirement (intrinsic, no flag)', () => {
    it('retires the pane for Claude unconditionally (hook-capable, no busy-composer poll)', () => {
      // Phase 3: Claude is event-driven with a hook provider and does not require the
      // busy-composer poll, so its send/idle/pending decisions are hook-only — no flag.
      assert.equal(isRunnerPaneRetired('claude'), true);
    });

    it('keeps Codex on the pane-fallback path (requiresBusyComposerPoll)', () => {
      // Codex is event-driven too, but its TUI buffers input and it must poll the pane before
      // sending (requiresBusyComposerPoll: true), so it is never retired.
      assert.equal(isRunnerPaneRetired('codex'), false);
    });

    it('never retires pane-only or observability-less runners', () => {
      // grok/cursor are pane-only (no hook provider); opencode/none have no observability at all.
      assert.equal(isRunnerPaneRetired('grok'), false);
      assert.equal(isRunnerPaneRetired('cursor'), false);
      assert.equal(isRunnerPaneRetired('opencode'), false);
      assert.equal(isRunnerPaneRetired('none'), false);
    });

    it('null/undefined runner is never retired', () => {
      assert.equal(isRunnerPaneRetired(null), false);
      assert.equal(isRunnerPaneRetired(undefined), false);
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
        `${CLEAR_RECIPE_TRUST_ENV}cd '/tmp/repo' && cursor-agent --sandbox enabled --model composer-2.5 'Read TASK.md and execute.'`,
      );
    });

    it('falls back to inline Cursor Agent launcher with composer-2.5 default model', () => {
      const vars = makeVars({ dispatchCmd: '', cursorPath: '/usr/local/bin/cursor-agent' });
      const cmd = buildLaunchCommand(vars, 'cursor', null, PROMPT);
      assert.equal(
        cmd,
        `${CLEAR_RECIPE_TRUST_ENV}cd '/tmp/repo' && /usr/local/bin/cursor-agent --sandbox enabled --model composer-2.5 'Read TASK.md and execute.'`,
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
        `${CLEAR_RECIPE_TRUST_ENV}cd '/tmp/repo' && /opt/cursor/bin/agent --force --sandbox enabled --model sonnet-4 'Read TASK.md and execute.'`,
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
      assert.equal(
        cmd,
        `${CLEAR_RECIPE_TRUST_ENV}cd '/tmp/repo' && grok --effort xhigh --model grok-4.5`,
      );
    });

    it('falls back to inline Grok launcher with grok-4.5 and xhigh effort', () => {
      const vars = makeVars({ dispatchCmd: '', grokPath: '/usr/local/bin/grok' });
      const cmd = buildLaunchCommand(vars, 'grok', null, PROMPT);
      assert.equal(
        cmd,
        `${CLEAR_RECIPE_TRUST_ENV}cd '/tmp/repo' && /usr/local/bin/grok --effort xhigh --model grok-4.5`,
      );
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
        `${CLEAR_RECIPE_TRUST_ENV}cd '/tmp/repo' && /Users/deeeed/.grok/bin/grok --permission-mode auto --effort xhigh --model grok-composer-2.5-fast`,
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
        /cd \/tmp\/repo && \/usr\/local\/bin\/grok --permission-mode bypassPermissions --effort high --model grok-4\.5$/,
      );
      assert.doesNotMatch(cmd, /Read TASK\.md and execute\./);
      assert.doesNotMatch(cmd, /CLAUDECODE/);
    });
  });

  describe('scripted runner', () => {
    it('uses the worker checkout-local CLI and never npx/global farmslot', () => {
      const vars = makeVars({
        dispatchCmd: 'cd {repo} && {claude_path} --model {model}',
        remoteRepo: '/tmp/worker-checkout',
      });
      const cmd = buildLaunchCommand(vars, 'scripted', null, PROMPT, {
        taskDir: TASK_DIR,
        scripted: { mode: 'scenario', scenario: 'success', stepDelayMs: 0 },
      });
      assert.match(
        cmd,
        /cd '\/tmp\/worker-checkout' && FARMSLOT_ROOT="\$PWD" FARMSLOT_ENABLE_SCRIPTED_SCENARIOS=1 node "\$PWD\/packages\/cli\/bin\/farmslot\.mjs" scripted-runner/,
      );
      assert.doesNotMatch(cmd, /FARMSLOT_ROOT='[^']+'/);
      assert.doesNotMatch(cmd, /node '[^']+\/packages\/cli/);
      assert.match(cmd, /--task-dir '\.task\/fix\/abc'/);
      assert.match(cmd, /FARMSLOT_ENABLE_SCRIPTED_SCENARIOS=1/);
      assert.match(cmd, /--mode scenario --scenario success --step-delay-ms 0/);
      assert.doesNotMatch(cmd, /npx farmslot/);
      assert.doesNotMatch(cmd, /(^|\s)farmslot fake-runner/);
    });

    it('passes only resolved project-owned command config for command mode', () => {
      const vars = makeVars();
      const cmd = buildLaunchCommand(vars, 'scripted', null, PROMPT, {
        taskDir: TASK_DIR,
        scripted: { mode: 'command', commandRef: 'smoke' },
        scriptedCommand: { command: 'yarn test:smoke', timeoutMs: 120000, cwd: 'apps/demo' },
      });
      assert.match(cmd, /--mode command --project 'test-project' --command-ref 'smoke'/);
      assert.doesNotMatch(cmd, /--command /);
      assert.doesNotMatch(cmd, /--cwd /);
      assert.match(cmd, /--timeout-ms 120000/);
    });

    it('throws when taskDir or scripted config is missing', () => {
      const vars = makeVars();
      assert.throws(
        () => buildLaunchCommand(vars, 'scripted', null, PROMPT),
        /Runner 'scripted' requires opts.taskDir/,
      );
      assert.throws(
        () => buildLaunchCommand(vars, 'scripted', null, PROMPT, { taskDir: TASK_DIR }),
        /Runner 'scripted' requires opts.scripted/,
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

describe('buildRunnerSessionReloadCommand', () => {
  it('restores task recipe provenance before resuming a persisted runner', () => {
    const vars = makeVars({ dispatchCmd: '', grokPath: '/opt/bin/grok' });
    const cmd = buildRunnerSessionReloadCommand(vars, 'grok', 'grok-code-fast-1', 'session', {
      taskDir: 'temp/tasks/TASK-1',
    });
    assert.match(cmd, /inputs\/inherited\/recipe-source[.]json/);
    assert.match(cmd, /FARMSLOT_RECIPE_SOURCE_TRUST=untrusted/);
    assert.match(cmd, /grok-code-fast-1 --resume 'session'$/);
  });

  it('builds a Claude resume command with observability and safety flags', () => {
    const vars = makeVars({ dispatchCmd: '', claudePath: '/opt/bin/claude' });
    const cmd = buildRunnerSessionReloadCommand(vars, 'claude', 'sonnet', 'session-123', {
      safetyTier: 'dangerous',
      runtimeDir: '.agent',
    });
    assert.match(cmd, /install-runner-observability\.mjs/);
    assert.match(
      cmd,
      /cd '\/tmp\/repo' && unset CLAUDECODE && \/opt\/bin\/claude --dangerously-skip-permissions --model sonnet --resume 'session-123'$/,
    );
  });

  it('builds a Codex resume command inside the isolated CODEX_HOME', () => {
    const vars = makeVars({ dispatchCmd: '', codexPath: '/opt/bin/codex' });
    const cmd = buildRunnerSessionReloadCommand(vars, 'codex', 'gpt-5', 'codex-session', {
      effort: 'high',
      safetyTier: 'full-auto',
      runtimeDir: 'runtime',
    });
    assert.match(cmd, /install-runner-observability\.mjs/);
    assert.match(cmd, /export CODEX_HOME='\/tmp\/repo\/runtime\/codex-home'/);
    assert.match(
      cmd,
      /\/opt\/bin\/codex resume --disable plugin_hooks --sandbox workspace-write --ask-for-approval never --config 'model_reasoning_effort="high"' --model gpt-5 'codex-session'$/,
    );
  });

  it('builds a Grok resume command with permission-mode and effort flags', () => {
    const vars = makeVars({ dispatchCmd: '', grokPath: '/opt/bin/grok' });
    const cmd = buildRunnerSessionReloadCommand(vars, 'grok', 'grok-code-fast-1', 'grok-session', {
      effort: 'xhigh',
      safetyTier: 'dangerous',
    });
    assert.equal(
      cmd,
      `${CLEAR_RECIPE_TRUST_ENV}cd '/tmp/repo' && /opt/bin/grok --permission-mode bypassPermissions --effort xhigh --model grok-code-fast-1 --resume 'grok-session'`,
    );
  });

  it('rejects runners without persisted-session reload support', () => {
    const vars = makeVars({ dispatchCmd: '' });
    assert.throws(
      () => buildRunnerSessionReloadCommand(vars, 'cursor', 'auto', 'session-123'),
      /does not support persisted session reload/,
    );
  });
});

describe('runnerPaneComposerDraftState (ADR-032 Phase 3A fail-closed composer read)', () => {
  it('reports empty for a bare prompt, with or without a trailing ctx status', () => {
    assert.equal(runnerPaneComposerDraftState('❯\n', 'claude'), 'empty');
    assert.equal(runnerPaneComposerDraftState('❯ ctx:12%\n', 'claude'), 'empty');
    assert.equal(runnerPaneComposerDraftState('❯ hello ctx:45%\n', 'claude'), 'draft');
  });

  it('does NOT misread a draft that begins with a ctx token as empty', () => {
    // Regression (finding #1): the old `^ctx:\\d+%` prefix test treated real draft text starting
    // with `ctx:N%` as an empty composer → a fresh type would concatenate onto it.
    assert.equal(runnerPaneComposerDraftState('❯ ctx:50% is my note\n', 'claude'), 'draft');
  });

  it('reports unknown when no prompt marker is present (fail-closed, never proven empty)', () => {
    // A missing marker is ABSENCE of evidence, not proof of an empty composer — callers must hold.
    assert.equal(
      runnerPaneComposerDraftState('some scrollback with no prompt line\n', 'claude'),
      'unknown',
    );
    assert.equal(runnerPaneComposerDraftState('', 'claude'), 'unknown');
  });

  it('reports draft for a busy/queued composer', () => {
    assert.equal(runnerPaneComposerDraftState('· Composing…\n❯\n', 'claude'), 'draft');
  });
});
