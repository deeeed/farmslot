import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { DEFAULT_CURSOR_MODEL, type SafetyTier } from '@farmslot/protocol';

import {
  buildCodexExecLaunch,
  buildCursorAgentLaunch,
  buildGrokLaunch,
  buildLaunchCommand,
  resolveCodexBinary,
  resolveCursorAgentBinary,
  resolveGrokBinary,
} from './launch-command.js';
import {
  getRunnerDefinition,
  runnerDefaultModel,
  runnerDefaultSafetyTier,
  runnerFlagsForTier,
  runnerLaunchCommandUsesHeadlessPrint,
  runnerSupportsTmuxNudges,
  runnerSupportsTmuxNudgesForLaunch,
  WORKER_ENV_PREFIX,
} from './registry.js';
import { assertCodexWorkerDoesNotInjectMcpOverrides, makeVars } from './test-fixtures.js';

describe('WORKER_ENV_PREFIX', () => {
  it('prepends asdf shims so worker tool calls honor repo .tool-versions', () => {
    assert.match(WORKER_ENV_PREFIX, /DISABLE_OMC=1/);
    assert.match(WORKER_ENV_PREFIX, /DISABLE_OMX=1/);
    assert.match(WORKER_ENV_PREFIX, /ASDF_DATA_DIR:-\$HOME\/\.asdf/);
    assert.match(WORKER_ENV_PREFIX, /PATH="\$ASDF_SHIMS:\$PATH"/);
  });
});

describe('runnerDefaultSafetyTier (ADR-023 §3: policy, not capability)', () => {
  it('every runner intrinsically falls back to sandboxed — higher tiers opt in via project.json', () => {
    // ADR-023 §3: safety tier is a policy decision, not a runner capability.
    // Projects that need the pre-refactor dangerous posture opt in via
    // `default_safety_tier` in project.json; the runner registry itself stays
    // default-safe.
    assert.equal(runnerDefaultSafetyTier('claude'), 'sandboxed');
    assert.equal(runnerDefaultSafetyTier('codex'), 'sandboxed');
    assert.equal(runnerDefaultSafetyTier('opencode'), 'sandboxed');
    assert.equal(runnerDefaultSafetyTier('cursor'), 'sandboxed');
    assert.equal(runnerDefaultSafetyTier('scripted'), 'sandboxed');
    assert.equal(runnerDefaultSafetyTier('none'), 'sandboxed');
  });

  it('unknown runners fall back to sandboxed (default-safe)', () => {
    assert.equal(runnerDefaultSafetyTier('some-future-runner'), 'sandboxed');
    assert.equal(runnerDefaultSafetyTier('cursor'), 'sandboxed');
  });
});

describe('runnerFlagsForTier — unknown runner isolation', () => {
  it('unknown runner + full-auto returns no flags (does not borrow claude --dangerously-skip-permissions)', () => {
    assert.deepEqual(runnerFlagsForTier('aider', 'full-auto'), []);
  });

  it('unknown runner + dangerous returns no flags (does not borrow codex bypass)', () => {
    assert.deepEqual(runnerFlagsForTier('aider', 'dangerous'), []);
  });

  it('unknown runner + sandboxed returns no flags', () => {
    assert.deepEqual(runnerFlagsForTier('aider', 'sandboxed'), []);
  });
});

describe('runnerFlagsForTier', () => {
  it('claude: sandboxed drops the skip-permissions flag', () => {
    assert.deepEqual(runnerFlagsForTier('claude', 'sandboxed'), []);
  });

  it('claude: full-auto and dangerous both emit --dangerously-skip-permissions', () => {
    assert.deepEqual(runnerFlagsForTier('claude', 'full-auto'), ['--dangerously-skip-permissions']);
    assert.deepEqual(runnerFlagsForTier('claude', 'dangerous'), ['--dangerously-skip-permissions']);
  });

  it('codex: sandboxed→none, full-auto→workspace-write without approvals, dangerous→bypass', () => {
    assert.deepEqual(runnerFlagsForTier('codex', 'sandboxed'), []);
    assert.deepEqual(runnerFlagsForTier('codex', 'full-auto'), [
      '--sandbox',
      'workspace-write',
      '--ask-for-approval',
      'never',
    ]);
    assert.deepEqual(runnerFlagsForTier('codex', 'dangerous'), [
      '--dangerously-bypass-approvals-and-sandbox',
    ]);
  });

  it('opencode, scripted, and none emit no flags at any tier', () => {
    for (const runner of ['opencode', 'scripted', 'none'] as const) {
      for (const tier of ['sandboxed', 'full-auto', 'dangerous'] as const) {
        assert.deepEqual(runnerFlagsForTier(runner, tier), []);
      }
    }
  });

  it('omitting tier uses the runner fallback (now sandboxed for every runner)', () => {
    // ADR-023 §3: intrinsic runner fallback is sandboxed. A project or
    // dispatch param has to opt in to any dangerous flag.
    assert.deepEqual(runnerFlagsForTier('codex'), []);
    assert.deepEqual(runnerFlagsForTier('claude'), []);
    assert.deepEqual(runnerFlagsForTier('scripted'), []);
  });
});

describe('buildLaunchCommand — safetyTier selection', () => {
  it('claude inline launch: sandboxed tier omits --dangerously-skip-permissions', () => {
    const vars = makeVars({ dispatchCmd: '' });
    const cmd = buildLaunchCommand(vars, 'claude', 'sonnet', 'prompt', {
      safetyTier: 'sandboxed',
    });
    assert.doesNotMatch(cmd, /--dangerously-skip-permissions/);
    assert.match(cmd, /\/usr\/local\/bin\/claude --model sonnet/);
  });

  it('claude inline launch: full-auto tier keeps the skip-permissions flag', () => {
    const vars = makeVars({ dispatchCmd: '' });
    const cmd = buildLaunchCommand(vars, 'claude', 'sonnet', 'prompt', {
      safetyTier: 'full-auto',
    });
    assert.match(cmd, /--dangerously-skip-permissions --model sonnet/);
  });

  it('claude inline launch: omitting tier uses runner fallback (sandboxed — no dangerously-* flags)', () => {
    const vars = makeVars({ dispatchCmd: '' });
    const cmd = buildLaunchCommand(vars, 'claude', 'sonnet', 'prompt');
    assert.doesNotMatch(cmd, /--dangerously-/);
  });

  it('codex inline fallback: sandboxed tier drops the bypass flag', () => {
    const vars = makeVars({ dispatchCmd: '' });
    const cmd = buildLaunchCommand(vars, 'codex', 'gpt-5', 'Read TASK.md', {
      safetyTier: 'sandboxed',
    });
    assert.doesNotMatch(cmd, /--dangerously-bypass-approvals-and-sandbox/);
    assert.match(cmd, /CODEX_HOME='\/tmp\/repo\/\.agent\/codex-home'/);
    assert.match(cmd, /\/usr\/local\/bin\/codex .*--model gpt-5/);
    assertCodexWorkerDoesNotInjectMcpOverrides(cmd);
    // Omitted effort defaults to xhigh for Codex.
    assert.match(cmd, /model_reasoning_effort="xhigh"/);
  });

  it('codex inline fallback: full-auto tier keeps sandbox with approvals disabled', () => {
    const vars = makeVars({ dispatchCmd: '' });
    const cmd = buildLaunchCommand(vars, 'codex', 'gpt-5', 'p', { safetyTier: 'full-auto' });
    assert.doesNotMatch(cmd, /--dangerously-bypass-approvals-and-sandbox/);
    assert.match(cmd, /CODEX_HOME='\/tmp\/repo\/\.agent\/codex-home'/);
    assert.match(
      cmd,
      /codex "\$FARMSLOT_CODEX_PLUGIN_HOOK_ARG_1" "\$FARMSLOT_CODEX_PLUGIN_HOOK_ARG_2" --sandbox workspace-write --ask-for-approval never .*--model gpt-5/,
    );
    assertCodexWorkerDoesNotInjectMcpOverrides(cmd);
    assert.match(cmd, /model_reasoning_effort="xhigh"/);
  });

  it('codex inline fallback: explicit effort injects a reasoning config override', () => {
    const vars = makeVars({ dispatchCmd: '' });
    const cmd = buildLaunchCommand(vars, 'codex', 'gpt-5', 'p', { effort: 'xhigh' });
    assert.match(cmd, /CODEX_HOME='\/tmp\/repo\/\.agent\/codex-home'/);
    assert.match(
      cmd,
      /codex "\$FARMSLOT_CODEX_PLUGIN_HOOK_ARG_1" "\$FARMSLOT_CODEX_PLUGIN_HOOK_ARG_2" --config 'model_reasoning_effort="xhigh"' .*--model gpt-5/,
    );
    assertCodexWorkerDoesNotInjectMcpOverrides(cmd);
  });

  it('codex inline fallback: auto effort leaves Codex config untouched', () => {
    const vars = makeVars({ dispatchCmd: '' });
    const cmd = buildLaunchCommand(vars, 'codex', 'gpt-5', 'p', { effort: 'auto' });
    assert.match(cmd, /codex .*--model gpt-5/);
    assertCodexWorkerDoesNotInjectMcpOverrides(cmd);
    assert.doesNotMatch(cmd, /model_reasoning_effort/);
  });

  it('codex inline fallback: dangerous tier emits the bypass flag', () => {
    const vars = makeVars({ dispatchCmd: '' });
    const cmd = buildLaunchCommand(vars, 'codex', 'gpt-5', 'p', { safetyTier: 'dangerous' });
    assert.match(cmd, /CODEX_HOME='\/tmp\/repo\/\.agent\/codex-home'/);
    assert.match(
      cmd,
      /codex "\$FARMSLOT_CODEX_PLUGIN_HOOK_ARG_1" "\$FARMSLOT_CODEX_PLUGIN_HOOK_ARG_2" --dangerously-bypass-approvals-and-sandbox/,
    );
  });

  it('codex inline fallback: does not hardcode Homebrew when codexPath is unset', () => {
    // The inline fallback must not hardcode /opt/homebrew/bin/codex on Darwin;
    // unresolved pools fall back to PATH `codex` instead of inferring a
    // Node-sibling binary.
    const vars = makeVars({ dispatchCmd: '', codexPath: '', osType: 'darwin' });
    const cmd = buildLaunchCommand(vars, 'codex', 'gpt-5', 'p', { safetyTier: 'dangerous' });
    assert.doesNotMatch(cmd, /\/opt\/homebrew\/bin\/codex/);
    assert.match(cmd, /CODEX_HOME='\/tmp\/repo\/\.agent\/codex-home'/);
    assert.match(
      cmd,
      /codex "\$FARMSLOT_CODEX_PLUGIN_HOOK_ARG_1" "\$FARMSLOT_CODEX_PLUGIN_HOOK_ARG_2" --dangerously-bypass-approvals-and-sandbox/,
    );
  });

  it('resolveCodexBinary does not infer a node-sibling codex binary', () => {
    assert.equal(resolveCodexBinary(''), 'codex');
  });

  it('resolveCodexBinary falls back to PATH codex when no explicit path exists', () => {
    assert.equal(resolveCodexBinary(''), 'codex');
  });

  it('intrinsic runner default is sandboxed: claude without a tier launches with NO bypass flag', () => {
    // ADR-023 §3: safety tier is a policy, not a runner capability. Claude's
    // intrinsic fallback is sandboxed — pre-refactor dangerous flags are opt-in
    // via project.json `default_safety_tier` (applied at run create time).
    const vars = makeVars({ dispatchCmd: '' });
    const cmd = buildLaunchCommand(vars, 'claude', 'sonnet', 'p');
    assert.doesNotMatch(cmd, /--dangerously-skip-permissions/);
  });

  it('intrinsic runner default is sandboxed: codex without a tier launches with NO bypass flag', () => {
    // Same policy boundary: intrinsic fallback is sandboxed. Pre-refactor dangerous
    // flags are opt-in via project.json `default_safety_tier`.
    const vars = makeVars({ dispatchCmd: '' });
    const cmd = buildLaunchCommand(vars, 'codex', 'gpt-5', 'p');
    assert.doesNotMatch(cmd, /--dangerously-bypass-approvals-and-sandbox/);
  });

  it('explicit full-auto tier re-emits the pre-refactor claude flag (project-default opt-in path)', () => {
    const vars = makeVars({ dispatchCmd: '' });
    const cmd = buildLaunchCommand(vars, 'claude', 'sonnet', 'p', { safetyTier: 'full-auto' });
    assert.match(cmd, /--dangerously-skip-permissions/);
  });

  it('explicit dangerous tier re-emits the pre-refactor codex flag (project-default opt-in path)', () => {
    const vars = makeVars({ dispatchCmd: '' });
    const cmd = buildLaunchCommand(vars, 'codex', 'gpt-5', 'p', { safetyTier: 'dangerous' });
    assert.match(cmd, /--dangerously-bypass-approvals-and-sandbox/);
  });
});

describe('buildLaunchCommand — {safety_flags} placeholder on dispatch path', () => {
  const PROMPT = 'Read TASK.md';

  it('claudeUsesDispatchCmd=true: tier flags substitute into {safety_flags}', () => {
    const vars = makeVars({
      dispatchCmd: 'cd {repo} && {claude_path} {safety_flags}',
    });
    const full = buildLaunchCommand(vars, 'claude', null, PROMPT, {
      claudeUsesDispatchCmd: true,
      safetyTier: 'full-auto',
    });
    assert.match(full, /\/usr\/local\/bin\/claude .*--dangerously-skip-permissions/);
    const sandbox = buildLaunchCommand(vars, 'claude', null, PROMPT, {
      claudeUsesDispatchCmd: true,
      safetyTier: 'sandboxed',
    });
    assert.doesNotMatch(sandbox, /--dangerously-skip-permissions/);
    assert.match(sandbox, /\/usr\/local\/bin\/claude/);
  });

  it('claudeUsesDispatchCmd=true: legacy template keeps its hardcoded flag and receives runtime settings', () => {
    const vars = makeVars({
      dispatchCmd: 'cd {repo} && {claude_path} --dangerously-skip-permissions',
    });
    const cmd = buildLaunchCommand(vars, 'claude', null, PROMPT, {
      claudeUsesDispatchCmd: true,
      safetyTier: 'sandboxed',
    });
    // Hardcoded flag stays put — tier override cannot remove it.
    assert.match(cmd, /\/usr\/local\/bin\/claude .*--dangerously-skip-permissions/);
    assert.match(cmd, /--settings '\/tmp\/repo\/\.agent\/\.observability\/claude-settings\.json'/);
  });

  it('codex runner-aware dispatch_cmd: tier flags substitute into {safety_flags}', () => {
    const vars = makeVars({
      dispatchCmd: 'cd {repo} && {codex_path} {safety_flags} --model {model}',
    });
    const dangerous = buildLaunchCommand(vars, 'codex', 'gpt-5', PROMPT, {
      safetyTier: 'dangerous',
    });
    assert.match(
      dangerous,
      /\/usr\/local\/bin\/codex .*--dangerously-bypass-approvals-and-sandbox --model gpt-5/,
    );
    assertCodexWorkerDoesNotInjectMcpOverrides(dangerous);
    assert.match(dangerous, /model_reasoning_effort="xhigh"/);
    const sandbox = buildLaunchCommand(vars, 'codex', 'gpt-5', PROMPT, {
      safetyTier: 'sandboxed',
    });
    assert.doesNotMatch(sandbox, /--dangerously-bypass-approvals-and-sandbox/);
    assert.match(sandbox, /\/usr\/local\/bin\/codex .*--model gpt-5/);
    assertCodexWorkerDoesNotInjectMcpOverrides(sandbox);
    assert.match(sandbox, /model_reasoning_effort="xhigh"/);
    assert.doesNotMatch(sandbox, /codex {2}--model/);
  });
});

describe('buildLaunchCommand — unknown runner safety isolation', () => {
  it('unknown runner + full-auto + runner-aware template: expands without any --dangerously-* flags', () => {
    const vars = makeVars({
      dispatchCmd: 'cd {repo} && {runner} {safety_flags}',
    });
    const cmd = buildLaunchCommand(vars, 'aider', null, 'Read TASK.md', {
      safetyTier: 'full-auto',
    });
    // Unknown runner gets no flags injected — {safety_flags} collapses to empty
    // and whitespace normalization strips the trailing space.
    assert.doesNotMatch(cmd, /--dangerously-/);
    assert.match(cmd, /aider$/);
  });
});

describe('RunnerDefinition.defaultSafetyTier registry field', () => {
  it('every registry entry exposes sandboxed as the intrinsic fallback (ADR-023 §3)', () => {
    assert.equal(getRunnerDefinition('claude').defaultSafetyTier, 'sandboxed');
    assert.equal(getRunnerDefinition('codex').defaultSafetyTier, 'sandboxed');
    assert.equal(getRunnerDefinition('opencode').defaultSafetyTier, 'sandboxed');
    assert.equal(getRunnerDefinition('cursor').defaultSafetyTier, 'sandboxed');
    assert.equal(getRunnerDefinition('scripted').defaultSafetyTier, 'sandboxed');
    assert.equal(getRunnerDefinition('none').defaultSafetyTier, 'sandboxed');
  });

  it('runnerDefaultSafetyTier reads from the field (not a duplicate switch)', () => {
    // Proven by: mutate the registry entry and confirm the helper tracks it.
    const claude = getRunnerDefinition('claude');
    const original = claude.defaultSafetyTier;
    try {
      (claude as { defaultSafetyTier: SafetyTier }).defaultSafetyTier = 'dangerous';
      assert.equal(runnerDefaultSafetyTier('claude'), 'dangerous');
    } finally {
      (claude as { defaultSafetyTier: SafetyTier }).defaultSafetyTier = original;
    }
  });
});

describe('runnerDefaultModel', () => {
  it('reads defaults from the runner registry', () => {
    assert.equal(runnerDefaultModel('claude'), 'opus');
    assert.equal(runnerDefaultModel('codex'), 'gpt-5.6-sol');
    assert.equal(runnerDefaultModel('cursor'), DEFAULT_CURSOR_MODEL);
    assert.equal(runnerDefaultModel('opencode'), null);
    assert.equal(runnerDefaultModel('unknown-runner'), null);
  });
});

describe('tmux nudge launch policy', () => {
  it('allows normal interactive launches but blocks explicit headless print launches', () => {
    const cursorInteractive =
      "cd /repo && cursor-agent --force --sandbox disabled --model composer-2.5 'Read TASK.md'";
    const cursorHeadless =
      "cd /repo && cursor-agent --print --output-format stream-json --stream-partial-output --trust --force --sandbox disabled --model composer-2.5 'Read TASK.md'";
    const claudeInteractive = 'cd /repo && claude --model sonnet';
    const claudeHeadless = "cd /repo && claude --model sonnet --print 'Read TASK.md'";

    assert.equal(runnerSupportsTmuxNudges('cursor'), true);
    assert.equal(runnerSupportsTmuxNudges('claude'), true);
    assert.equal(runnerLaunchCommandUsesHeadlessPrint('cursor', cursorHeadless), true);
    assert.equal(runnerLaunchCommandUsesHeadlessPrint('claude', claudeHeadless), true);
    assert.equal(runnerSupportsTmuxNudgesForLaunch('cursor', cursorInteractive), true);
    assert.equal(runnerSupportsTmuxNudgesForLaunch('cursor', cursorHeadless), false);
    assert.equal(runnerSupportsTmuxNudgesForLaunch('claude', claudeInteractive), true);
    assert.equal(runnerSupportsTmuxNudgesForLaunch('claude', claudeHeadless), false);
    assert.equal(runnerSupportsTmuxNudgesForLaunch('cursor', undefined), true);
  });

  it('keeps Claude and Codex tmux-nudgeable when no headless launch is recorded', () => {
    assert.equal(runnerSupportsTmuxNudgesForLaunch('claude', undefined), true);
    assert.equal(runnerSupportsTmuxNudgesForLaunch('codex', undefined), true);
  });
});

describe('runnerFlagsForTier — cursor', () => {
  it('maps Cursor safety tiers to explicit Cursor Agent flags', () => {
    assert.deepEqual(runnerFlagsForTier('cursor', 'sandboxed'), ['--sandbox', 'enabled']);
    assert.deepEqual(runnerFlagsForTier('cursor', 'full-auto'), [
      '--force',
      '--sandbox',
      'enabled',
    ]);
    assert.deepEqual(runnerFlagsForTier('cursor', 'dangerous'), [
      '--force',
      '--sandbox',
      'disabled',
    ]);
  });
});

describe('runnerFlagsForTier — grok', () => {
  it('maps Grok safety tiers to explicit permission-mode flags', () => {
    assert.deepEqual(runnerFlagsForTier('grok', 'sandboxed'), []);
    assert.deepEqual(runnerFlagsForTier('grok', 'full-auto'), ['--permission-mode', 'auto']);
    assert.deepEqual(runnerFlagsForTier('grok', 'dangerous'), [
      '--permission-mode',
      'bypassPermissions',
    ]);
  });
});

describe('buildCursorAgentLaunch', () => {
  it('defaults to the registered Cursor model and sandboxed flags with an argv task prompt', () => {
    const cmd = buildCursorAgentLaunch({
      binary: 'cursor-agent',
      model: null,
      prompt: 'hi',
      repo: '/tmp/repo',
    });
    assert.equal(
      cmd,
      `cd '/tmp/repo' && cursor-agent --sandbox enabled --model ${DEFAULT_CURSOR_MODEL} 'hi'`,
    );
  });

  it('shell-quotes prompt text for Cursor argv launch', () => {
    const cmd = buildCursorAgentLaunch({
      binary: 'cursor-agent',
      model: 'composer-2.5',
      prompt: "read Bob's task",
      repo: '/tmp/repo',
    });
    assert.equal(
      cmd,
      "cd '/tmp/repo' && cursor-agent --sandbox enabled --model composer-2.5 'read Bob'\\''s task'",
    );
  });

  it('omits prompt argument when prompt is empty', () => {
    const cmd = buildCursorAgentLaunch({
      binary: 'cursor-agent',
      model: 'composer-2.5',
      prompt: '',
      repo: '/tmp/repo',
    });
    assert.equal(cmd, "cd '/tmp/repo' && cursor-agent --sandbox enabled --model composer-2.5");
  });

  it('resolveCursorAgentBinary falls back to bare `cursor-agent` when no path is configured', () => {
    assert.equal(resolveCursorAgentBinary(''), 'cursor-agent');
    assert.equal(resolveCursorAgentBinary(null), 'cursor-agent');
    assert.equal(resolveCursorAgentBinary('/custom/agent'), '/custom/agent');
  });
});

describe('buildGrokLaunch', () => {
  it('defaults to grok-4.6, xhigh effort, and leaves the task prompt for post-launch delivery', () => {
    const cmd = buildGrokLaunch({
      binary: 'grok',
      model: null,
      prompt: 'hi',
      repo: '/tmp/repo',
    });
    assert.equal(cmd, "cd '/tmp/repo' && grok --effort xhigh --model grok-4.6");
    // Prompt is not argv-injected (post-launch delivery only).
    assert.doesNotMatch(cmd, /\bhi\b/);
  });

  it('passes safety tier, effort, and selected model', () => {
    const cmd = buildGrokLaunch({
      binary: '/Users/deeeed/.grok/bin/grok',
      model: 'grok-composer-2.5-fast',
      effort: 'high',
      prompt: "read Bob's task",
      repo: '/tmp/repo',
      safetyTier: 'dangerous',
    });
    assert.equal(
      cmd,
      "cd '/tmp/repo' && /Users/deeeed/.grok/bin/grok --permission-mode bypassPermissions --effort high --model grok-composer-2.5-fast",
    );
    assert.doesNotMatch(cmd, /Bob/);
  });

  it('resolveGrokBinary falls back to bare `grok` when no path is configured', () => {
    assert.equal(resolveGrokBinary(''), 'grok');
    assert.equal(resolveGrokBinary(null), 'grok');
  });
});

describe('buildCodexExecLaunch — safetyTier', () => {
  it('sandboxed tier produces a clean codex invocation without the bypass flag', () => {
    const cmd = buildCodexExecLaunch({
      binary: 'codex',
      model: 'gpt-5',
      prompt: 'hi',
      repo: '/tmp/repo',
      safetyTier: 'sandboxed',
    });
    assert.doesNotMatch(cmd, /--dangerously-bypass-approvals-and-sandbox/);
    assert.match(cmd, /codex .*--model gpt-5/);
    assertCodexWorkerDoesNotInjectMcpOverrides(cmd);
    assert.match(cmd, /model_reasoning_effort="xhigh"/);
  });

  it('dangerous tier emits the bypass flag', () => {
    const cmd = buildCodexExecLaunch({
      binary: 'codex',
      model: 'gpt-5',
      prompt: 'hi',
      repo: '/tmp/repo',
      safetyTier: 'dangerous',
    });
    assert.match(cmd, /--dangerously-bypass-approvals-and-sandbox/);
    assert.match(cmd, /model_reasoning_effort="xhigh"/);
  });

  it('omitted tier falls back to codex default (sandboxed — no bypass flag)', () => {
    const cmd = buildCodexExecLaunch({
      binary: 'codex',
      model: null,
      prompt: 'hi',
      repo: '/tmp/repo',
    });
    assert.doesNotMatch(cmd, /--dangerously-bypass-approvals-and-sandbox/);
    assert.match(cmd, /model_reasoning_effort="xhigh"/);
  });

  it('omitted effort defaults to xhigh for Codex', () => {
    const cmd = buildCodexExecLaunch({
      binary: 'codex',
      model: null,
      prompt: 'hi',
      repo: '/tmp/repo',
    });
    assert.match(cmd, /--config 'model_reasoning_effort="xhigh"'/);
  });

  it('explicit effort emits a Codex reasoning override', () => {
    const cmd = buildCodexExecLaunch({
      binary: 'codex',
      model: null,
      effort: 'high',
      prompt: 'hi',
      repo: '/tmp/repo',
    });
    assert.match(cmd, /--config 'model_reasoning_effort="high"'/);
  });

  it('rejects unsupported Codex reasoning effort values before launch', () => {
    assert.throws(
      () =>
        buildCodexExecLaunch({
          binary: 'codex',
          model: 'gpt-5',
          effort: 'xxhigh',
          prompt: 'hi',
          repo: '/tmp/repo',
        }),
      /Invalid Codex reasoning effort: xxhigh/,
    );
  });
});
