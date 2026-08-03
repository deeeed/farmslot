import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
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
  exactPromptMatch: true,
};
const callOrder: string[] = [];
let paneText = '❯\nctx:12%\n';
let paneCaptureCount = 0;
let paneClearsAfterSubmit = true;
let paneTextByCapture: string[] | null = null;
let paneTextAfterLiteralSend: string | null = null;
let paneTextAfterBareSend: string | null = null;
let activityReadingAfterLiteralSend: ObservabilityReading<RunnerActivity> | null = null;
let handoffRequirePromptDigestValues: Array<boolean | undefined> = [];
let acceptDigestHandoff = false;
let launchAckSnapshotReads = 0;
let grokPromptAcceptedCalls = 0;
let grokPromptAcceptedAfterCall = Number.POSITIVE_INFINITY;
let grokPromptAcceptedAtMs = Number.POSITIVE_INFINITY;
let grokPromptAcceptanceBaselineMs = Date.now();
let grokActivityReads = 0;
let grokActivitySequence: RunnerActivity[] = ['idle'];

mock.module('./claude-observability.js', {
  namedExports: {
    claudeHookObservability: {
      promptAcceptanceMode: 'hook-digest',
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
      async getSessionDeliveryState() {
        return null;
      },
    },
  },
});

mock.module('./grok-observability.js', {
  namedExports: {
    grokLogObservability: {
      promptAcceptanceMode: 'native-text',
      async getActivity() {
        const index = Math.min(grokActivityReads, grokActivitySequence.length - 1);
        grokActivityReads += 1;
        return {
          value: grokActivitySequence[index] ?? 'idle',
          source: 'signal',
          confidence: 'high',
          observedAt: Date.now(),
        };
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
      async capturePromptAcceptanceBaseline() {
        callOrder.push('grok:baseline');
        return grokPromptAcceptanceBaselineMs;
      },
      async promptAccepted(
        _vars: SlotVars,
        _target: string,
        _promptDigest: string,
        sinceMs: number,
      ) {
        grokPromptAcceptedCalls += 1;
        const accepted =
          grokPromptAcceptedCalls >= grokPromptAcceptedAfterCall &&
          grokPromptAcceptedAtMs >= sinceMs;
        return {
          value: accepted,
          source: 'signal',
          confidence: accepted ? 'high' : 'medium',
          observedAt: accepted ? grokPromptAcceptedAtMs : Date.now(),
          exactPromptMatch: accepted,
        };
      },
      async getSessionDeliveryState() {
        return null;
      },
    },
  },
});

mock.module('../core/exec.js', {
  namedExports: {
    isLocal: () => true,
    execLocal: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    // Reached transitively via methods/git.ts; kept consistent with execLocal above.
    execArgvOnSlot: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    execFileArgv: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    execOnSlot: async (_slotVars: SlotVars, cmd: string) => {
      if (cmd.includes('capture-pane')) {
        callOrder.push('pane:capture');
        paneCaptureCount += 1;
        const scriptedPane = paneTextByCapture?.[paneCaptureCount - 1];
        if (scriptedPane !== undefined) {
          return { exitCode: 0, stdout: scriptedPane, stderr: '' };
        }
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
        if (cmd.includes(' -l ')) {
          callOrder.push('tmux:send-literal');
          if (paneTextAfterLiteralSend !== null) paneText = paneTextAfterLiteralSend;
          if (activityReadingAfterLiteralSend !== null) {
            activityReading = activityReadingAfterLiteralSend;
          }
        } else if (paneTextAfterBareSend !== null) {
          paneText = paneTextAfterBareSend;
        }
        return { exitCode: 0, stdout: '', stderr: '' };
      }
      if (cmd.includes("python3 - <<'PY'")) {
        callOrder.push('python:write');
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
    readLaunchAckSignalSnapshot: async () => {
      launchAckSnapshotReads += 1;
      return { raw: null, status: null, mtimeNs: '0' };
    },
    probeRunnerHandoffAck: async (
      _slotVars: SlotVars,
      _target: string,
      _message: string,
      _sinceMs: number,
      opts: { requirePromptDigest?: boolean } = {},
    ) => {
      handoffRequirePromptDigestValues.push(opts.requirePromptDigest);
      if (acceptDigestHandoff && opts.requirePromptDigest) {
        return {
          accepted: true,
          reason: 'mocked exact prompt digest',
          source: 'hook-digest',
        };
      }
      return { accepted: false, reason: 'mocked handoff miss' };
    },
  },
});

const {
  resolvePrimaryWorkerTarget,
  runnerHasDurablePromptHandoff,
  sendRunnerInstructionSafely,
  sendRunnerPostLaunchPrompt,
} = await import('./registry.js');

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
    exactPromptMatch: false,
  };
  paneText = '›\nContext 88%\n';

  // Codex owns the pane-fallback decision path (Claude is hook-only per ADR-032 Phase 3): it
  // consults observability first, then the pane.
  const sent = await sendRunnerInstructionSafely(vars, target, 'codex', message, '[test]', 10_000, {
    forceBusyPoll: true,
  });

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
  acceptDigestHandoff = true;

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
  acceptDigestHandoff = false;
});

test('sendRunnerPostLaunchPrompt honors an explicit null launch-ack baseline', async () => {
  launchAckSnapshotReads = 0;
  promptAcceptedReading = {
    value: true,
    source: 'hook',
    confidence: 'high',
    observedAt: Date.now(),
  };

  await sendRunnerPostLaunchPrompt(vars, target, 'claude', message, 'TASK.md', '[test]', {
    launchAckSignalPath: '/tmp/SIGNAL.json',
    launchAckBaseline: null,
    readyTimeoutMs: 100,
    stabilityPolls: 1,
    pollIntervalMs: 0,
    verifyWaitMs: 0,
    maxAttempts: 1,
  });

  assert.equal(launchAckSnapshotReads, 0);
});

test('sendRunnerPostLaunchPrompt rechecks delayed Grok acceptance before retrying', async () => {
  callOrder.length = 0;
  paneCaptureCount = 0;
  paneClearsAfterSubmit = false;
  paneText = '';
  grokPromptAcceptedCalls = 0;
  grokPromptAcceptedAtMs = Number.POSITIVE_INFINITY;
  paneTextByCapture = null;
  // First pre-send probe and first post-send verification miss. The retry probe sees
  // the delayed native prompt-history record and must not type the task a second time.
  grokPromptAcceptedAfterCall = 4;

  await sendRunnerPostLaunchPrompt(vars, target, 'grok', message, 'TASK.md', '[test]', {
    readyTimeoutMs: 100,
    stabilityPolls: 1,
    pollIntervalMs: 0,
    verifyWaitMs: 0,
    maxAttempts: 2,
  });

  assert.equal(
    callOrder.filter((entry) => entry === 'tmux:send-literal').length,
    1,
    `delayed native acceptance must prevent duplicate typing; order=${callOrder.join(',')}`,
  );
  assert.equal(grokPromptAcceptedCalls, 4, 'the second attempt must observe native acceptance');
  paneClearsAfterSubmit = true;
  grokPromptAcceptedAfterCall = Number.POSITIVE_INFINITY;
  grokPromptAcceptedAtMs = Number.POSITIVE_INFINITY;
});

test('sendRunnerPostLaunchPrompt does not treat native idle state as exact delivery', async () => {
  callOrder.length = 0;
  paneCaptureCount = 0;
  paneClearsAfterSubmit = false;
  paneText = '';
  paneTextByCapture = null;
  grokPromptAcceptedCalls = 0;
  grokPromptAcceptedAtMs = Number.POSITIVE_INFINITY;
  grokPromptAcceptedAfterCall = 3;

  await sendRunnerPostLaunchPrompt(vars, target, 'grok', message, 'TASK.md', '[test]', {
    readyTimeoutMs: 100,
    stabilityPolls: 1,
    pollIntervalMs: 0,
    verifyWaitMs: 0,
    maxAttempts: 1,
  });

  assert.equal(
    callOrder.filter((entry) => entry === 'tmux:send-literal').length,
    1,
    `native idle state must not substitute for exact prompt acceptance; order=${callOrder.join(',')}`,
  );
  paneTextByCapture = null;
  paneClearsAfterSubmit = true;
  grokPromptAcceptedAfterCall = Number.POSITIVE_INFINITY;
  grokPromptAcceptedAtMs = Number.POSITIVE_INFINITY;
});

test('sendRunnerPostLaunchPrompt submits a buffered Codex retry before waiting for idle', async () => {
  callOrder.length = 0;
  paneCaptureCount = 0;
  activityReading = { value: 'idle', source: 'hook', confidence: 'high', observedAt: Date.now() };
  promptAcceptedReading = null;
  const readyPane = '›\nContext 88%\n';
  const bufferedPane = `› ${message}\ngpt-5.6-sol xhigh\n`;
  const workingPane = `${message}\n• Working (2s • esc to interrupt)\n›\ngpt-5.6-sol xhigh\n`;
  paneText = readyPane;
  paneTextByCapture = null;
  paneClearsAfterSubmit = false;
  paneTextAfterLiteralSend = bufferedPane;
  paneTextAfterBareSend = workingPane;
  activityReadingAfterLiteralSend = {
    value: 'composing',
    source: 'hook',
    confidence: 'high',
    observedAt: Date.now(),
  };

  await sendRunnerPostLaunchPrompt(vars, target, 'codex', message, 'SELF-REVIEW.md', '[test]', {
    readyTimeoutMs: 50,
    stabilityPolls: 1,
    pollIntervalMs: 1,
    verifyWaitMs: 0,
    maxAttempts: 2,
  });

  assert.equal(
    callOrder.filter((entry) => entry === 'tmux:send-literal').length,
    1,
    `the retry must submit the existing buffer without retyping; order=${callOrder.join(',')}`,
  );
  assert.equal(
    callOrder.filter((entry) => entry === 'tmux:send').length,
    2,
    `expected one initial send and one submit-only retry; order=${callOrder.join(',')}`,
  );
  paneTextByCapture = null;
  paneTextAfterLiteralSend = null;
  paneTextAfterBareSend = null;
  activityReadingAfterLiteralSend = null;
  paneClearsAfterSubmit = true;
});

test('sendRunnerPostLaunchPrompt submits a long marker-only Codex retry before waiting for idle', async () => {
  callOrder.length = 0;
  paneCaptureCount = 0;
  activityReading = { value: 'idle', source: 'hook', confidence: 'high', observedAt: Date.now() };
  promptAcceptedReading = null;
  const longMessage = `${'Detailed review instructions. '.repeat(20)}Read SELF-REVIEW.md now.`;
  const readyPane = '›\nContext 88%\n';
  const truncatedBufferedPane = '› … Read SELF-REVIEW.md now.\ngpt-5.6-sol xhigh\n';
  const workingPane =
    'Read SELF-REVIEW.md now.\n• Working (2s • esc to interrupt)\n›\ngpt-5.6-sol xhigh\n';
  paneText = readyPane;
  paneTextByCapture = null;
  paneClearsAfterSubmit = false;
  paneTextAfterLiteralSend = truncatedBufferedPane;
  paneTextAfterBareSend = workingPane;
  activityReadingAfterLiteralSend = {
    value: 'composing',
    source: 'hook',
    confidence: 'high',
    observedAt: Date.now(),
  };

  await sendRunnerPostLaunchPrompt(vars, target, 'codex', longMessage, 'SELF-REVIEW.md', '[test]', {
    readyTimeoutMs: 50,
    stabilityPolls: 1,
    pollIntervalMs: 1,
    verifyWaitMs: 0,
    maxAttempts: 2,
  });

  assert.equal(callOrder.filter((entry) => entry === 'tmux:send-literal').length, 1);
  assert.equal(callOrder.filter((entry) => entry === 'tmux:send').length, 2);
  paneTextByCapture = null;
  paneTextAfterLiteralSend = null;
  paneTextAfterBareSend = null;
  activityReadingAfterLiteralSend = null;
  paneClearsAfterSubmit = true;
});

test('sendRunnerInstructionSafely stops after exact native Grok acceptance', async () => {
  callOrder.length = 0;
  paneCaptureCount = 0;
  paneTextByCapture = null;
  grokPromptAcceptedCalls = 0;
  grokPromptAcceptedAfterCall = 1;
  grokPromptAcceptanceBaselineMs = 10_000;
  grokPromptAcceptedAtMs = 10_001;

  const delivered = await sendRunnerInstructionSafely(vars, target, 'grok', message, '[test]', 50);

  assert.equal(delivered, true);
  assert.ok(grokPromptAcceptedCalls >= 1);
  assert.equal(
    callOrder.filter((entry) => entry === 'tmux:send-literal').length,
    0,
    `an exact native match must not resend the instruction; order=${callOrder.join(',')}`,
  );
  grokPromptAcceptedAfterCall = Number.POSITIVE_INFINITY;
  grokPromptAcceptedAtMs = Number.POSITIVE_INFINITY;
  grokPromptAcceptanceBaselineMs = Date.now();
});

test('sendRunnerInstructionSafely does not suppress an intentional identical Grok resend', async () => {
  callOrder.length = 0;
  paneCaptureCount = 0;
  paneTextByCapture = null;
  paneText = '';
  grokPromptAcceptedCalls = 0;
  grokPromptAcceptedAfterCall = 1;
  grokPromptAcceptanceBaselineMs = 10_000;
  grokPromptAcceptedAtMs = 9_000;

  const delivered = await sendRunnerInstructionSafely(vars, target, 'grok', message, '[test]', 50);

  assert.equal(delivered, true);
  assert.ok(
    callOrder.includes('tmux:send-literal'),
    `acceptance before this send call must not swallow an intentional resend; order=${callOrder.join(',')}`,
  );
  grokPromptAcceptedAfterCall = Number.POSITIVE_INFINITY;
  grokPromptAcceptedAtMs = Number.POSITIVE_INFINITY;
  grokPromptAcceptanceBaselineMs = Date.now();
});

test('sendRunnerInstructionSafely uses the remote Grok clock baseline', async () => {
  callOrder.length = 0;
  paneCaptureCount = 0;
  paneTextByCapture = null;
  grokPromptAcceptedCalls = 0;
  grokPromptAcceptedAfterCall = 1;
  grokPromptAcceptanceBaselineMs = 1_000;
  grokPromptAcceptedAtMs = 1_001;

  const delivered = await sendRunnerInstructionSafely(vars, target, 'grok', message, '[test]', 50);

  assert.equal(delivered, true);
  assert.ok(callOrder.includes('grok:baseline'));
  assert.equal(
    callOrder.filter((entry) => entry === 'tmux:send-literal').length,
    0,
    `remote acceptance after the remote baseline must prevent a duplicate send; order=${callOrder.join(',')}`,
  );
  grokPromptAcceptedAfterCall = Number.POSITIVE_INFINITY;
  grokPromptAcceptedAtMs = Number.POSITIVE_INFINITY;
  grokPromptAcceptanceBaselineMs = Date.now();
});

test('sendRunnerInstructionSafely bounds native Grok probes while the composer stays busy', async () => {
  callOrder.length = 0;
  paneCaptureCount = 0;
  paneTextByCapture = null;
  paneText = '';
  grokPromptAcceptedCalls = 0;
  grokPromptAcceptedAfterCall = Number.POSITIVE_INFINITY;
  grokPromptAcceptanceBaselineMs = 10_000;
  grokPromptAcceptedAtMs = Number.POSITIVE_INFINITY;
  grokActivityReads = 0;
  grokActivitySequence = ['tool-running'];

  const delivered = await sendRunnerInstructionSafely(vars, target, 'grok', message, '[test]', 50);

  assert.equal(delivered, false);
  assert.equal(grokPromptAcceptedCalls, 1, 'busy polling must not repeatedly scan Grok history');
  assert.equal(callOrder.includes('tmux:send-literal'), false);
  grokPromptAcceptanceBaselineMs = Date.now();
});

test('sendRunnerInstructionSafely honors native Grok acceptance after a busy wait', async () => {
  callOrder.length = 0;
  paneCaptureCount = 0;
  paneTextByCapture = null;
  paneText = '';
  grokPromptAcceptedCalls = 0;
  grokPromptAcceptedAfterCall = 2;
  grokPromptAcceptanceBaselineMs = 10_000;
  grokPromptAcceptedAtMs = 10_001;
  grokActivityReads = 0;
  grokActivitySequence = ['tool-running', 'idle'];

  const delivered = await sendRunnerInstructionSafely(
    vars,
    target,
    'grok',
    message,
    '[test]',
    2_000,
  );

  assert.equal(delivered, true);
  assert.equal(grokPromptAcceptedCalls, 2);
  assert.equal(
    callOrder.includes('tmux:send-literal'),
    false,
    `the final native recheck must stop a duplicate send; order=${callOrder.join(',')}`,
  );
  paneTextByCapture = null;
  grokPromptAcceptedAfterCall = Number.POSITIVE_INFINITY;
  grokPromptAcceptedAtMs = Number.POSITIVE_INFINITY;
  grokPromptAcceptanceBaselineMs = Date.now();
});

test('sendRunnerInstructionSafely keeps checking a buffered Cursor composer', async () => {
  callOrder.length = 0;
  paneCaptureCount = 0;
  paneTextByCapture = null;
  paneText = `❯ ${message}`;

  const delivered = await sendRunnerInstructionSafely(
    vars,
    target,
    'cursor',
    message,
    '[test]',
    50,
    { forceBusyPoll: true },
  );

  assert.equal(delivered, true);
  assert.equal(
    callOrder.includes('tmux:send-literal'),
    false,
    `buffered Cursor text must be submitted, not duplicated; order=${callOrder.join(',')}`,
  );
  paneText = '❯\nctx:12%\n';
});

test('digest-required recovery still accepts native Grok prompt evidence', async () => {
  handoffRequirePromptDigestValues = [];
  grokPromptAcceptedCalls = 0;
  grokPromptAcceptedAfterCall = 1;
  grokPromptAcceptedAtMs = 5_001;

  const accepted = await runnerHasDurablePromptHandoff(vars, target, 'grok', message, Date.now(), {
    requirePromptDigest: true,
    promptAcceptanceBaselineMs: 5_000,
  });

  assert.equal(accepted.accepted, true);
  assert.equal(accepted.source, 'native-signal');
  assert.deepEqual(handoffRequirePromptDigestValues, [true]);
  grokPromptAcceptedAfterCall = Number.POSITIVE_INFINITY;
  grokPromptAcceptedAtMs = Number.POSITIVE_INFINITY;
});

test('digest-required recovery rejects hook activity without an exact digest', async () => {
  handoffRequirePromptDigestValues = [];
  promptAcceptedReading = {
    value: true,
    source: 'hook',
    confidence: 'high',
    observedAt: Date.now(),
  };

  const handoff = await runnerHasDurablePromptHandoff(vars, target, 'claude', message, Date.now(), {
    requirePromptDigest: true,
  });

  assert.equal(handoff.accepted, false);
  assert.match(handoff.reason, /digest-required handoff rejected/);
  assert.equal(callOrder.includes('obs:promptAccepted'), true);
  assert.deepEqual(handoffRequirePromptDigestValues, [true]);
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
    callOrder.indexOf('python:write'),
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
  // Codex-format buffered composer (`›` marker + model line). Codex owns the pane-fallback path.
  paneText = `› ${needle}\ngpt-5-codex\n`;

  const sent = await sendRunnerInstructionSafely(vars, target, 'codex', message, '[test]');

  assert.equal(sent, true);
  assert.ok(callOrder.includes('obs:promptAccepted'));
  assert.ok(callOrder.includes('pane:capture'));
  assert.ok(callOrder.includes('tmux:send'));
  assert.equal(
    callOrder.indexOf('python:write'),
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
  paneText = '›\nContext 88%\n';

  // Codex owns the pane-fallback path: an unknown hook activity falls back to the pane.
  const sent = await sendRunnerInstructionSafely(vars, target, 'codex', message, '[test]', 10_000, {
    forceBusyPoll: true,
  });

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

test('historical Grok progress does not suppress an identical new fix-pass prompt', async () => {
  callOrder.length = 0;
  paneCaptureCount = 0;
  paneClearsAfterSubmit = true;
  paneTextByCapture = null;
  grokPromptAcceptedCalls = 0;
  grokPromptAcceptedAfterCall = Number.POSITIVE_INFINITY;
  grokPromptAcceptedAtMs = Number.POSITIVE_INFINITY;
  grokActivityReads = 0;
  grokActivitySequence = ['idle'];
  paneText = [
    `#1 ${message}`,
    'Read SELF-REVIEW-FIX.md',
    'Implemented the previous review findings.',
    '',
    '╭────────────────╮',
    '│ ❯              │',
    '╰────────────────╯',
  ].join('\n');

  const sent = await sendRunnerInstructionSafely(vars, target, 'grok', message, '[test]');

  assert.equal(sent, true);
  assert.ok(
    callOrder.includes('tmux:send-literal'),
    `an old identical turn must not satisfy this delivery generation; order=${callOrder.join(',')}`,
  );
  grokPromptAcceptedAfterCall = Number.POSITIVE_INFINITY;
  grokPromptAcceptedAtMs = Number.POSITIVE_INFINITY;
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

// --- ADR-032 Phase 3 claude hook-only send path ---

test('claude (hook-only) hook-idle with an EMPTY composer proves-empty then types the message', async () => {
  callOrder.length = 0;
  paneCaptureCount = 0;
  activityReading = { value: 'idle', source: 'hook', confidence: 'high', observedAt: Date.now() };
  // Not a high-confidence digest match → not "already delivered". The pending selector treats an
  // authoritative not-accepted reading as possibly-buffered, so the loop MUST prove the composer
  // is empty (submit-existing → not-buffered) before typing fresh — never a blind concat.
  promptAcceptedReading = {
    value: false,
    source: 'hook',
    confidence: 'medium',
    observedAt: Date.now(),
  };
  paneText = '❯\nctx:12%\n'; // empty composer — nothing buffered
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
  // The idle/pending DECISION was resolved from hooks only.
  assert.ok(
    callOrder.includes('obs:getActivity') && callOrder.includes('obs:promptAccepted'),
    `expected hook reads to drive the decision; order=${callOrder.join(',')}`,
  );
  // Composer proven empty → the message is TYPED fresh (a bare Enter would report a false
  // delivery success for an instruction that was never sent).
  assert.ok(
    callOrder.includes('tmux:send-literal'),
    `an empty composer must get the message typed; order=${callOrder.join(',')}`,
  );
});

test('claude (hook-only) hook-idle with a BUFFERED composer submits it without retyping (no concat)', async () => {
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
  paneText = `❯ ${message.slice(0, 80)}\nctx:12%\n`; // the instruction is buffered in the composer
  const sent = await sendRunnerInstructionSafely(vars, target, 'claude', message, '[test]', 5000, {
    forceBusyPoll: true,
  });
  assert.equal(sent, true);
  assert.ok(callOrder.includes('tmux:send'), `expected a submit key; order=${callOrder.join(',')}`);
  assert.equal(
    callOrder.indexOf('tmux:send-literal'),
    -1,
    `a genuinely buffered instruction submits with Enter only — retyping would double the text; order=${callOrder.join(',')}`,
  );
});

test('claude (hook-only) hook-idle fails loudly on a stuck buffer instead of retyping', async () => {
  callOrder.length = 0;
  paneCaptureCount = 0;
  paneClearsAfterSubmit = false; // submit keys never clear the buffer → stuck
  activityReading = { value: 'idle', source: 'hook', confidence: 'high', observedAt: Date.now() };
  promptAcceptedReading = {
    value: false,
    source: 'hook',
    confidence: 'high',
    observedAt: Date.now(),
  };
  paneText = `❯ ${message.slice(0, 80)}\nctx:12%\n`;
  try {
    const sent = await sendRunnerInstructionSafely(
      vars,
      target,
      'claude',
      message,
      '[test]',
      5000,
      {
        forceBusyPoll: true,
      },
    );
    assert.equal(sent, false, 'a stuck buffer is a delivery failure, not a success');
    assert.equal(
      callOrder.indexOf('tmux:send-literal'),
      -1,
      `never retype over a stuck buffer — the text would concatenate; order=${callOrder.join(',')}`,
    );
  } finally {
    paneClearsAfterSubmit = true;
  }
});

test('claude (hook-only) degraded (hook unknown) holds the send instead of pane fallback', async () => {
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
});

test('claude (hook-only) holds instead of concatenating onto FOREIGN composer draft', async () => {
  // Finding #1: the pending selector only knows whether OUR message is buffered. An operator draft
  // (foreign text the hook signal cannot see) sitting in the composer returns not-buffered, and the
  // pre-fix loop would type the message straight into the occupied composer → concatenation. The
  // composer-empty guard must hold instead.
  callOrder.length = 0;
  paneCaptureCount = 0;
  paneClearsAfterSubmit = false; // foreign draft persists across captures
  activityReading = { value: 'idle', source: 'hook', confidence: 'high', observedAt: Date.now() };
  promptAcceptedReading = {
    value: false,
    source: 'hook',
    confidence: 'high',
    observedAt: Date.now(),
  };
  // Draft text that is NOT our instruction and NOT an idle/busy marker.
  paneText = '❯ wait, let me double check the deploy first\nctx:12%\n';
  try {
    const sent = await sendRunnerInstructionSafely(vars, target, 'claude', message, '[test]', 20, {
      forceBusyPoll: true,
    });
    assert.equal(sent, false, 'foreign composer draft must hold the send, not concatenate');
    assert.equal(
      callOrder.indexOf('tmux:send-literal'),
      -1,
      `never type into a composer holding foreign draft text; order=${callOrder.join(',')}`,
    );
  } finally {
    paneClearsAfterSubmit = true;
  }
});

test('claude (hook-only) degraded hold with a run context persists an ADR-031 audit record', async (t) => {
  // Finding #4: a degraded hold must reach the intelligence-action audit (persisted to disk), not
  // just a console warning, whenever the caller supplies a runId.
  const previous = process.env.FARMSLOT_INTELLIGENCE_AUDIT_DIR;
  const auditDir = mkdtempSync(path.join(tmpdir(), 'farmslot-obs-degraded-audit-'));
  process.env.FARMSLOT_INTELLIGENCE_AUDIT_DIR = auditDir;
  t.after(async () => {
    if (previous === undefined) delete process.env.FARMSLOT_INTELLIGENCE_AUDIT_DIR;
    else process.env.FARMSLOT_INTELLIGENCE_AUDIT_DIR = previous;
    await rm(auditDir, { recursive: true, force: true });
  });

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
  const sent = await sendRunnerInstructionSafely(vars, target, 'claude', message, '[test]', 20, {
    forceBusyPoll: true,
    recovery: { runId: 'run-audit-xyz' },
  });
  assert.equal(sent, false);
  // Compute the audit path directly (do NOT import audit-writer at module scope — that would
  // transitively load the real gateway modules before mock.module() applies and poison the mocks).
  const day = new Date().toISOString().slice(0, 10);
  const auditPath = path.join(auditDir, `${day}.ndjson`);
  const raw = await readFile(auditPath, 'utf8');
  const record = raw
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .find((entry) => entry.runId === 'run-audit-xyz');
  assert.ok(record, `expected a persisted degraded-hold audit record in ${auditPath}`);
  assert.equal(record.verdict?.patternId, 'observability-degraded-hold');
  assert.equal(record.tier, 'deterministic');
});

test('claude (hook-only) holds when the composer state is UNKNOWN (no prompt marker), never fresh-sends', async () => {
  // Finding #1: a pane with no prompt marker cannot be POSITIVELY confirmed empty. The pre-fix
  // `runnerPaneComposerHasDraft` returned false (= no draft = safe) for a missing marker, so the
  // loop would fresh-type into an unseen buffer. The three-state read must hold instead.
  callOrder.length = 0;
  paneCaptureCount = 0;
  paneClearsAfterSubmit = false; // marker-less pane persists across captures
  activityReading = { value: 'idle', source: 'hook', confidence: 'high', observedAt: Date.now() };
  promptAcceptedReading = {
    value: false,
    source: 'hook',
    confidence: 'high',
    observedAt: Date.now(),
  };
  paneText = 'scrollback with no prompt line\nstill no marker here\n';
  try {
    const sent = await sendRunnerInstructionSafely(vars, target, 'claude', message, '[test]', 20, {
      forceBusyPoll: true,
    });
    assert.equal(sent, false, 'an unknown composer state must hold, not fresh-send');
    assert.equal(
      callOrder.indexOf('tmux:send-literal'),
      -1,
      `never type into a composer whose state is unknown; order=${callOrder.join(',')}`,
    );
  } finally {
    paneClearsAfterSubmit = true;
  }
});

test('claude (hook-only) foreign-draft hold records a composer-draft audit cause, not a hook lapse', async (t) => {
  // Finding #5: a healthy-hook foreign-draft hold must record its own audit cause
  // (`composer-draft-hold`), distinct from a hook lapse (`observability-degraded-hold`).
  const previous = process.env.FARMSLOT_INTELLIGENCE_AUDIT_DIR;
  const auditDir = mkdtempSync(path.join(tmpdir(), 'farmslot-composer-draft-audit-'));
  process.env.FARMSLOT_INTELLIGENCE_AUDIT_DIR = auditDir;
  t.after(async () => {
    if (previous === undefined) delete process.env.FARMSLOT_INTELLIGENCE_AUDIT_DIR;
    else process.env.FARMSLOT_INTELLIGENCE_AUDIT_DIR = previous;
    await rm(auditDir, { recursive: true, force: true });
  });

  callOrder.length = 0;
  paneCaptureCount = 0;
  paneClearsAfterSubmit = false; // foreign draft persists across captures
  activityReading = { value: 'idle', source: 'hook', confidence: 'high', observedAt: Date.now() };
  promptAcceptedReading = {
    value: false,
    source: 'hook',
    confidence: 'high',
    observedAt: Date.now(),
  };
  paneText = '❯ wait, let me double check the deploy first\nctx:12%\n';
  try {
    const sent = await sendRunnerInstructionSafely(vars, target, 'claude', message, '[test]', 20, {
      forceBusyPoll: true,
      recovery: { runId: 'run-composer-draft' },
    });
    assert.equal(sent, false);
    const day = new Date().toISOString().slice(0, 10);
    const auditPath = path.join(auditDir, `${day}.ndjson`);
    const raw = await readFile(auditPath, 'utf8');
    const record = raw
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .find((entry) => entry.runId === 'run-composer-draft');
    assert.ok(record, `expected a persisted composer-draft-hold audit record in ${auditPath}`);
    assert.equal(
      record.verdict?.patternId,
      'composer-draft-hold',
      'a healthy-hook composer hold must not be recorded as a hook lapse',
    );
  } finally {
    paneClearsAfterSubmit = true;
  }
});

test('claude (hook-only) with high-confidence digest match reports already-delivered without resending', async () => {
  callOrder.length = 0;
  paneCaptureCount = 0;
  activityReading = { value: 'idle', source: 'hook', confidence: 'high', observedAt: Date.now() };
  promptAcceptedReading = {
    value: true,
    source: 'hook',
    confidence: 'high',
    observedAt: Date.now(),
  };
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
});
