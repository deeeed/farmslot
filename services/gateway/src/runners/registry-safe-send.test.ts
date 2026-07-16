import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

import type { SlotVars } from '../core/config.js';

import type { ObservabilityReading, RunnerActivity } from './observability-types.js';
import { makeVars } from './test-fixtures.js';

const vars = makeVars();
const target = 'test-1:dev';
const message = 'Read and execute TASK.md in /tmp/repo/tasks/foo';

let activityReading: ObservabilityReading<RunnerActivity> | null = {
  value: 'idle',
  source: 'hook',
  confidence: 'high',
  observedAt: Date.now(),
};
let promptAcceptedReading: ObservabilityReading<boolean> | null = {
  value: true,
  source: 'hook',
  confidence: 'high',
  observedAt: Date.now(),
};

const callOrder: string[] = [];
let paneText = '❯\nctx:12%\n';
let paneCaptureCount = 0;
let paneClearsAfterSubmit = true;
let handoffRequirePromptDigestValues: Array<boolean | undefined> = [];

mock.module('./claude-observability.js', {
  namedExports: {
    claudeHookObservability: {
      async getActivity() {
        callOrder.push('obs:getActivity');
        return activityReading;
      },
      async getContextPct() {
        return null;
      },
      async activeTool() {
        return null;
      },
      async lastTurnCompletedAt() {
        return null;
      },
      async promptAccepted() {
        callOrder.push('obs:promptAccepted');
        return promptAcceptedReading;
      },
    },
  },
});

mock.module('../core/exec.js', {
  namedExports: {
    isLocal: () => true,
    execLocal: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    execOnSlot: async (_slotVars: SlotVars, cmd: string) => {
      if (cmd.includes('capture-pane')) {
        callOrder.push('pane:capture');
        paneCaptureCount += 1;
        // Captures 1-2 show the scenario pane (decision + submit pre-check);
        // later captures model the composer clearing after a submit key —
        // unless a test pins paneClearsAfterSubmit=false to model a stuck buffer.
        if (paneCaptureCount > 2 && paneClearsAfterSubmit) {
          return { exitCode: 0, stdout: '❯\nctx:12%\n', stderr: '' };
        }
        return { exitCode: 0, stdout: paneText, stderr: '' };
      }
      if (cmd.includes('list-windows')) {
        return { exitCode: 0, stdout: '1 rev-codex\n2 self-review\n3 dev\n', stderr: '' };
      }
      if (cmd.includes('send-keys') || cmd.includes('send-text')) {
        callOrder.push('tmux:send');
        // A literal payload (-l) is the message being TYPED; a bare send is a
        // key like Enter. The distinction is what separates fresh-send from
        // submit-existing in assertions.
        if (cmd.includes(' -l ')) callOrder.push('tmux:send-literal');
        return { exitCode: 0, stdout: '', stderr: '' };
      }
      if (cmd.includes('python3 -')) {
        callOrder.push('sentinel:write');
        return { exitCode: 0, stdout: '', stderr: '' };
      }
      if (cmd.includes('hooks.jsonl') || cmd.includes('stat -')) {
        return { exitCode: 0, stdout: '0', stderr: '' };
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    },
  },
});

mock.module('./prompt-delivery-evidence.js', {
  namedExports: {
    probeRunnerHandoffAck: async (
      _slotVars: SlotVars,
      _target: string,
      _message: string,
      _sinceMs: number,
      opts: { requirePromptDigest?: boolean } = {},
    ) => {
      handoffRequirePromptDigestValues.push(opts.requirePromptDigest);
      return { accepted: false, reason: 'mocked handoff miss' };
    },
  },
});

const { resolvePrimaryWorkerTarget, sendRunnerInstructionSafely, sendRunnerPostLaunchPrompt } =
  await import('./registry.js');

test('sendRunnerInstructionSafely consults observability before pane on hook-authoritative idle', async () => {
  callOrder.length = 0;
  paneCaptureCount = 0;
  activityReading = {
    value: 'idle',
    source: 'hook',
    confidence: 'high',
    observedAt: Date.now(),
  };
  promptAcceptedReading = {
    value: true,
    source: 'hook',
    confidence: 'high',
    observedAt: Date.now(),
  };
  paneText = '❯\nctx:12%\n';

  const sent = await sendRunnerInstructionSafely(
    vars,
    target,
    'claude',
    message,
    '[test]',
    10_000,
    { forceBusyPoll: true },
  );

  assert.equal(sent, true);
  const obsPromptIdx = callOrder.indexOf('obs:promptAccepted');
  const obsActivityIdx = callOrder.indexOf('obs:getActivity');
  const firstPaneIdx = callOrder.indexOf('pane:capture');
  assert.ok(obsPromptIdx >= 0, `expected obs:promptAccepted in ${callOrder.join(',')}`);
  assert.ok(obsActivityIdx >= 0, `expected obs:getActivity in ${callOrder.join(',')}`);
  assert.ok(
    obsPromptIdx < firstPaneIdx,
    `obs promptAccepted should precede first pane capture; order=${callOrder.join(',')}`,
  );
});

test('resolvePrimaryWorkerTarget skips reviewer windows when falling back to session scan', async () => {
  const workerTarget = await resolvePrimaryWorkerTarget(vars);
  assert.equal(workerTarget, 'test-1:3');
});

test('sendRunnerPostLaunchPrompt only requires prompt digest when caller opts in', async () => {
  handoffRequirePromptDigestValues = [];
  paneCaptureCount = 0;
  paneText = '❯\nctx:12%\n';
  promptAcceptedReading = {
    value: true,
    source: 'hook',
    confidence: 'high',
    observedAt: Date.now(),
  };

  await sendRunnerPostLaunchPrompt(vars, target, 'claude', message, 'TASK.md', '[test]', {
    readyTimeoutMs: 100,
    stabilityPolls: 1,
    pollIntervalMs: 0,
    verifyWaitMs: 0,
    maxAttempts: 1,
  });

  assert.ok(
    handoffRequirePromptDigestValues.every((value) => value !== true),
    `dispatch-style sends must not require digest by default: ${handoffRequirePromptDigestValues.join(',')}`,
  );

  handoffRequirePromptDigestValues = [];
  paneCaptureCount = 0;

  await sendRunnerPostLaunchPrompt(vars, target, 'claude', message, 'SELF-REVIEW.md', '[test]', {
    readyTimeoutMs: 100,
    stabilityPolls: 1,
    pollIntervalMs: 0,
    verifyWaitMs: 0,
    maxAttempts: 1,
    requirePromptDigest: true,
  });

  assert.ok(
    handoffRequirePromptDigestValues.some((value) => value === true),
    'self-review sends can require prompt digest explicitly',
  );
});

test('sendRunnerInstructionSafely skips pane busy scrape when hook reports composing', async () => {
  callOrder.length = 0;
  paneCaptureCount = 0;
  activityReading = {
    value: 'composing',
    source: 'hook',
    confidence: 'high',
    observedAt: Date.now(),
  };
  promptAcceptedReading = {
    value: true,
    source: 'hook',
    confidence: 'high',
    observedAt: Date.now(),
  };

  const sent = await sendRunnerInstructionSafely(vars, target, 'codex', message, '[test]', 50, {
    forceBusyPoll: true,
  });

  assert.equal(sent, false);
  assert.ok(callOrder.includes('obs:promptAccepted'));
  assert.ok(callOrder.includes('obs:getActivity'));
  assert.equal(
    callOrder.indexOf('sentinel:write'),
    -1,
    `hook-busy path must not fresh-send; order=${callOrder.join(',')}`,
  );
});

test('sendRunnerInstructionSafely prefers live pane over stale hook acceptance', async () => {
  callOrder.length = 0;
  paneCaptureCount = 0;
  activityReading = {
    value: 'idle',
    source: 'hook',
    confidence: 'high',
    observedAt: Date.now(),
  };
  promptAcceptedReading = {
    value: true,
    source: 'hook',
    confidence: 'high',
    observedAt: Date.now(),
  };
  const needle = message.slice(0, 80);
  paneText = `❯ ${needle}\nctx:12%\n`;

  const sent = await sendRunnerInstructionSafely(vars, target, 'claude', message, '[test]');

  assert.equal(sent, true);
  assert.ok(callOrder.includes('obs:promptAccepted'));
  assert.ok(callOrder.includes('pane:capture'));
  assert.ok(callOrder.includes('tmux:send'));
  assert.equal(
    callOrder.indexOf('sentinel:write'),
    -1,
    `stale hook acceptance must submit-existing, not fresh send; order=${callOrder.join(',')}`,
  );
});

test('sendRunnerInstructionSafely falls back to pane when hook activity is unknown', async () => {
  callOrder.length = 0;
  paneCaptureCount = 0;
  activityReading = {
    value: 'unknown',
    source: 'hook',
    confidence: 'high',
    observedAt: Date.now(),
  };
  promptAcceptedReading = {
    value: true,
    source: 'hook',
    confidence: 'high',
    observedAt: Date.now(),
  };
  paneText = '❯\nctx:12%\n';

  const sent = await sendRunnerInstructionSafely(
    vars,
    target,
    'claude',
    message,
    '[test]',
    10_000,
    { forceBusyPoll: true },
  );

  assert.equal(sent, true);
  assert.ok(callOrder.includes('pane:capture'));
  assert.ok(callOrder.includes('obs:getActivity'));
});

test('sendRunnerInstructionSafely types the message when hook says not-accepted and the composer is empty', async () => {
  callOrder.length = 0;
  paneCaptureCount = 0;
  activityReading = { value: 'idle', source: 'hook', confidence: 'high', observedAt: Date.now() };
  promptAcceptedReading = {
    value: false,
    source: 'hook',
    confidence: 'high',
    observedAt: Date.now(),
  };
  paneText = '❯\nctx:12%\n'; // empty composer — nothing buffered

  const sent = await sendRunnerInstructionSafely(vars, target, 'claude', message, '[test]');

  assert.equal(sent, true);
  assert.ok(callOrder.includes('pane:capture'), 'must check the pane before trusting pending');
  assert.ok(
    callOrder.includes('tmux:send-literal'),
    `an authoritative not-accepted reading with an EMPTY composer must TYPE the message — a bare Enter reports success while the instruction was never delivered; order=${callOrder.join(',')}`,
  );
});

test('sendRunnerInstructionSafely submits the buffered instruction when the pane shows it', async () => {
  callOrder.length = 0;
  paneCaptureCount = 0;
  activityReading = { value: 'idle', source: 'hook', confidence: 'high', observedAt: Date.now() };
  promptAcceptedReading = {
    value: false,
    source: 'hook',
    confidence: 'high',
    observedAt: Date.now(),
  };
  paneText = `❯ ${message.slice(0, 80)}\nctx:12%\n`;

  const sent = await sendRunnerInstructionSafely(vars, target, 'claude', message, '[test]');

  assert.equal(sent, true);
  assert.ok(callOrder.includes('tmux:send'));
  assert.equal(
    callOrder.indexOf('tmux:send-literal'),
    -1,
    `a genuinely buffered instruction submits with Enter only — retyping would double the text; order=${callOrder.join(',')}`,
  );
});

test('loop path (forceBusyPoll) types the message when nothing is buffered', async () => {
  callOrder.length = 0;
  paneCaptureCount = 0;
  activityReading = { value: 'idle', source: 'hook', confidence: 'high', observedAt: Date.now() };
  promptAcceptedReading = {
    value: false,
    source: 'hook',
    confidence: 'high',
    observedAt: Date.now(),
  };
  paneText = '❯\nctx:12%\n';

  const sent = await sendRunnerInstructionSafely(vars, target, 'claude', message, '[test]', 5000, {
    forceBusyPoll: true,
  });

  assert.equal(sent, true);
  assert.ok(
    callOrder.includes('tmux:send-literal'),
    `busy-aware loop with an empty composer must TYPE the message; order=${callOrder.join(',')}`,
  );
});

test('loop path (forceBusyPoll) submits a genuinely buffered instruction without retyping', async () => {
  callOrder.length = 0;
  paneCaptureCount = 0;
  activityReading = { value: 'idle', source: 'hook', confidence: 'high', observedAt: Date.now() };
  promptAcceptedReading = {
    value: false,
    source: 'hook',
    confidence: 'high',
    observedAt: Date.now(),
  };
  paneText = `❯ ${message.slice(0, 80)}\nctx:12%\n`;

  const sent = await sendRunnerInstructionSafely(vars, target, 'claude', message, '[test]', 5000, {
    forceBusyPoll: true,
  });

  assert.equal(sent, true);
  assert.ok(callOrder.includes('tmux:send'));
  assert.equal(
    callOrder.indexOf('tmux:send-literal'),
    -1,
    `buffered instruction on the loop path submits with Enter only; order=${callOrder.join(',')}`,
  );
});

test('a transcript echo with an empty live composer gets the message typed fresh', async () => {
  callOrder.length = 0;
  paneCaptureCount = 0;
  paneClearsAfterSubmit = true;
  activityReading = { value: 'idle', source: 'hook', confidence: 'high', observedAt: Date.now() };
  promptAcceptedReading = {
    value: false,
    source: 'hook',
    confidence: 'high',
    observedAt: Date.now(),
  };
  // The instruction sits in transcript history (outside the 12-line pending
  // tail) above an empty prompt: contains=true, pending=false, buffered=false.
  const filler = Array.from({ length: 14 }, (_, i) => `transcript line ${i}`).join('\n');
  paneText = `❯ ${message.slice(0, 80)}\n${filler}\n❯\n`;

  const sent = await sendRunnerInstructionSafely(vars, target, 'claude', message, '[test]');

  assert.equal(sent, true);
  assert.ok(
    callOrder.includes('tmux:send-literal'),
    `transcript echo must not satisfy delivery — type the message; order=${callOrder.join(',')}`,
  );
});

test('a persistently buffered composer fails loudly instead of concatenating a retype', async () => {
  callOrder.length = 0;
  paneCaptureCount = 0;
  paneClearsAfterSubmit = false; // submit keys never clear the buffer
  activityReading = { value: 'idle', source: 'hook', confidence: 'high', observedAt: Date.now() };
  // Non-authoritative observability routes through the fallback path into
  // sendRunnerInstructionWhenPaneClear — the branch whose stuck-guard this
  // test pins (the hook-authoritative fast path returns directly and would
  // pass even on the pre-fix concatenating behavior).
  promptAcceptedReading = null;
  paneText = `❯ ${message.slice(0, 80)}\nctx:12%\n`;

  const sent = await sendRunnerInstructionSafely(vars, target, 'claude', message, '[test]');

  paneClearsAfterSubmit = true;
  assert.equal(sent, false, 'a stuck buffer is a delivery failure, not a success');
  assert.equal(
    callOrder.indexOf('tmux:send-literal'),
    -1,
    `never retype over a stuck buffer — the text would concatenate; order=${callOrder.join(',')}`,
  );
});

// --- ADR-032 Phase 3A pane-retirement flag ---

test('flag-on claude hook-idle send never captures pane before the send decision', async () => {
  callOrder.length = 0;
  paneCaptureCount = 0;
  activityReading = { value: 'idle', source: 'hook', confidence: 'high', observedAt: Date.now() };
  // Not a high-confidence digest match → not "already delivered"; the loop should fresh-send.
  promptAcceptedReading = {
    value: false,
    source: 'hook',
    confidence: 'medium',
    observedAt: Date.now(),
  };
  process.env.FARMSLOT_OBS_PANE_RETIRED = '1';
  try {
    const sent = await sendRunnerInstructionSafely(
      vars,
      target,
      'claude',
      message,
      '[test]',
      10_000,
      {
        forceBusyPoll: true,
      },
    );
    assert.equal(sent, true);
    const sendIdx = callOrder.indexOf('tmux:send');
    const firstPaneIdx = callOrder.indexOf('pane:capture');
    assert.ok(sendIdx >= 0, `expected a send; order=${callOrder.join(',')}`);
    assert.ok(
      callOrder.includes('obs:getActivity'),
      `expected hook read; order=${callOrder.join(',')}`,
    );
    // Decision consulted hooks only: no pane capture happened before the send-keys.
    assert.ok(
      firstPaneIdx === -1 || firstPaneIdx > sendIdx,
      `pane must not be consulted before the hook-only send; order=${callOrder.join(',')}`,
    );
  } finally {
    delete process.env.FARMSLOT_OBS_PANE_RETIRED;
  }
});

test('flag-on claude degraded (hook unknown) holds the send instead of pane fallback', async () => {
  callOrder.length = 0;
  paneCaptureCount = 0;
  activityReading = {
    value: 'unknown',
    source: 'hook',
    confidence: 'high',
    observedAt: Date.now(),
  };
  promptAcceptedReading = null;
  paneText = '❯\nctx:12%\n';
  process.env.FARMSLOT_OBS_PANE_RETIRED = '1';
  try {
    // Small timeout so the degraded hold resolves fast.
    const sent = await sendRunnerInstructionSafely(vars, target, 'claude', message, '[test]', 20, {
      forceBusyPoll: true,
    });
    assert.equal(sent, false);
    assert.equal(
      callOrder.indexOf('tmux:send'),
      -1,
      `degraded hold must not send into a blind composer; order=${callOrder.join(',')}`,
    );
    assert.ok(callOrder.includes('obs:getActivity'));
  } finally {
    delete process.env.FARMSLOT_OBS_PANE_RETIRED;
  }
});

test('flag-on claude with high-confidence digest match reports already-delivered without resending', async () => {
  callOrder.length = 0;
  paneCaptureCount = 0;
  activityReading = { value: 'idle', source: 'hook', confidence: 'high', observedAt: Date.now() };
  promptAcceptedReading = {
    value: true,
    source: 'hook',
    confidence: 'high',
    observedAt: Date.now(),
  };
  process.env.FARMSLOT_OBS_PANE_RETIRED = '1';
  try {
    const sent = await sendRunnerInstructionSafely(
      vars,
      target,
      'claude',
      message,
      '[test]',
      10_000,
      {
        forceBusyPoll: true,
      },
    );
    assert.equal(sent, true);
    assert.equal(
      callOrder.indexOf('tmux:send'),
      -1,
      `already-delivered must not resend; order=${callOrder.join(',')}`,
    );
  } finally {
    delete process.env.FARMSLOT_OBS_PANE_RETIRED;
  }
});
