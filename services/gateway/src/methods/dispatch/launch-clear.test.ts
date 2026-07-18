import assert from 'node:assert/strict';
import test from 'node:test';

import { type LaunchPreludeOptions, runLaunchPreludeAndSend } from './launch-clear.js';

interface Harness {
  commands: string[];
  sleeps: number[];
  reensured: number;
  ownershipChecks: number;
  prelude: LaunchPreludeOptions;
}

function harness(overrides: {
  exec?: (tmuxCommand: string, h: Harness) => { exitCode: number; stdout: string; stderr?: string };
  assertOwnership?: () => Promise<void>;
}): Harness {
  const h: Harness = {
    commands: [],
    sleeps: [],
    reensured: 0,
    ownershipChecks: 0,
    prelude: {
      runner: 'cursor',
      target: 'ff-2:1',
      session: 'ff-2',
      launchCommand: 'export DISABLE_OMC=1 && cursor-agent …',
      waits: { daWaitMs: 700, settleMs: 150, recreateSettleMs: 1200 },
      exec: async (tmuxCommand) => {
        h.commands.push(tmuxCommand);
        return overrides.exec?.(tmuxCommand, h) ?? { exitCode: 0, stdout: '' };
      },
      assertOwnership:
        overrides.assertOwnership ??
        (async () => {
          h.ownershipChecks += 1;
        }),
      reensureTarget: async () => {
        h.reensured += 1;
        return 'ff-2:worker';
      },
      sleep: async (ms) => {
        h.sleeps.push(ms);
      },
    },
  };
  return h;
}

test('happy path sends pre-clear, post-clear, launch line, and Enter on the original target', async () => {
  const h = harness({});
  const { target } = await runLaunchPreludeAndSend(h.prelude);
  assert.equal(target, 'ff-2:1');
  assert.equal(h.reensured, 0);
  assert.deepEqual(h.commands, [
    "send-keys -t 'ff-2:1' C-c C-u",
    "send-keys -t 'ff-2:1' C-c C-u",
    "send-keys -t 'ff-2:1' -l 'export DISABLE_OMC=1 && cursor-agent …'",
    "send-keys -t 'ff-2:1' Enter",
  ]);
  assert.deepEqual(h.sleeps, [700, 150]);
});

test('a session lost at post-clear is recreated once and every later send uses the fresh target', async () => {
  const h = harness({
    exec: (tmuxCommand, ctx) => {
      if (tmuxCommand.startsWith('has-session')) {
        return { exitCode: 1, stdout: '', stderr: "can't find session: ff-2" };
      }
      // Second clear on the ORIGINAL target fails (session died mid-prelude).
      const isSecondClearOnStale =
        tmuxCommand === "send-keys -t 'ff-2:1' C-c C-u" &&
        ctx.commands.filter((c) => c === "send-keys -t 'ff-2:1' C-c C-u").length === 2;
      return isSecondClearOnStale
        ? { exitCode: 1, stdout: '', stderr: "can't find session: ff-2" }
        : { exitCode: 0, stdout: '' };
    },
  });
  const { target } = await runLaunchPreludeAndSend(h.prelude);
  assert.equal(target, 'ff-2:worker');
  assert.equal(h.reensured, 1);
  assert.equal(h.ownershipChecks, 1);
  // The fresh-shell settle ran between recreation and the retried clear.
  assert.deepEqual(h.sleeps, [700, 1200, 150]);
  assert.deepEqual(h.commands.slice(-3), [
    "send-keys -t 'ff-2:worker' C-c C-u",
    "send-keys -t 'ff-2:worker' -l 'export DISABLE_OMC=1 && cursor-agent …'",
    "send-keys -t 'ff-2:worker' Enter",
  ]);
});

test('a session lost at the launch-line send recovers and retypes on the fresh target', async () => {
  const h = harness({
    exec: (tmuxCommand) => {
      if (tmuxCommand.startsWith('has-session')) return { exitCode: 1, stdout: '' };
      if (tmuxCommand.startsWith("send-keys -t 'ff-2:1' -l")) {
        return { exitCode: 1, stdout: '', stderr: "can't find session: ff-2" };
      }
      return { exitCode: 0, stdout: '' };
    },
  });
  const { target } = await runLaunchPreludeAndSend(h.prelude);
  assert.equal(target, 'ff-2:worker');
  assert.ok(
    h.commands.includes("send-keys -t 'ff-2:worker' -l 'export DISABLE_OMC=1 && cursor-agent …'"),
  );
  assert.equal(h.commands.at(-1), "send-keys -t 'ff-2:worker' Enter");
});

test('the ownership fence blocks recreation after an intentional teardown', async () => {
  const h = harness({
    exec: (tmuxCommand) =>
      tmuxCommand.startsWith('has-session')
        ? { exitCode: 1, stdout: '' }
        : { exitCode: 1, stdout: '', stderr: "can't find session: ff-2" },
    assertOwnership: async () => {
      throw new Error(
        'Run 664660cf is cancelled; session ff-2 teardown was intentional — not recreating',
      );
    },
  });
  await assert.rejects(
    () => runLaunchPreludeAndSend(h.prelude),
    /teardown was intentional — not recreating/,
  );
  assert.equal(h.reensured, 0);
});

test('a send failure with the session still alive throws without recreating', async () => {
  const h = harness({
    exec: (tmuxCommand) =>
      tmuxCommand.startsWith('has-session')
        ? { exitCode: 0, stdout: '' }
        : { exitCode: 1, stdout: '', stderr: 'pane is dead' },
  });
  await assert.rejects(
    () => runLaunchPreludeAndSend(h.prelude),
    /Failed to clear launch input \(pre-clear\) for cursor in ff-2:1: pane is dead/,
  );
  assert.equal(h.reensured, 0);
  assert.equal(h.ownershipChecks, 0);
});

test('a retry that still fails after recreation reports the recreation context', async () => {
  const h = harness({
    exec: (tmuxCommand) =>
      tmuxCommand.startsWith('has-session')
        ? { exitCode: 1, stdout: '' }
        : { exitCode: 1, stdout: '', stderr: 'send failed' },
  });
  await assert.rejects(
    () => runLaunchPreludeAndSend(h.prelude),
    /Failed to clear launch input \(pre-clear\) for cursor in ff-2:worker: send failed \(after session recreation\)/,
  );
});

test('a failed Enter submit throws without any recovery attempt', async () => {
  const h = harness({
    exec: (tmuxCommand) =>
      tmuxCommand.endsWith(' Enter')
        ? { exitCode: 1, stdout: '', stderr: "can't find session: ff-2" }
        : { exitCode: 0, stdout: '' },
  });
  await assert.rejects(
    () => runLaunchPreludeAndSend(h.prelude),
    /Failed to submit launch line for cursor in ff-2:1: can't find session: ff-2/,
  );
  assert.equal(h.reensured, 0);
});
