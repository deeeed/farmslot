import assert from 'node:assert/strict';
import test from 'node:test';

import {
  type LaunchPreludeOptions,
  recreationOwnershipViolation,
  runLaunchPreludeAndSend,
} from './launch-clear.js';

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

const FULL_SEQUENCE = (target: string): string[] => [
  `send-keys -t '${target}' C-c C-u`,
  `send-keys -t '${target}' C-c C-u`,
  `send-keys -t '${target}' -l 'export DISABLE_OMC=1 && cursor-agent …'`,
  `send-keys -t '${target}' Enter`,
];

test('happy path runs the full sequence once on the original target', async () => {
  const h = harness({});
  const { target } = await runLaunchPreludeAndSend(h.prelude);
  assert.equal(target, 'ff-2:1');
  assert.equal(h.reensured, 0);
  assert.deepEqual(h.commands, FULL_SEQUENCE('ff-2:1'));
  assert.deepEqual(h.sleeps, [700, 150]);
});

test('a session lost mid-prelude restarts the WHOLE sequence on the fresh target', async () => {
  const h = harness({
    exec: (tmuxCommand, ctx) => {
      if (tmuxCommand.startsWith('has-session')) {
        return { exitCode: 1, stdout: '', stderr: "can't find session: ff-2" };
      }
      // The post-clear on the ORIGINAL target fails: session died mid-prelude.
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
  // Fenced twice: before recreation, and again after it to close the
  // check/recreate TOCTOU window.
  assert.equal(h.ownershipChecks, 2);
  // Full restart: the fresh shell gets its own pre-clear + DA wait + post-clear,
  // never a resumed mid-sequence send that fresh-shell DA output could poison.
  assert.deepEqual(h.commands.slice(-4), FULL_SEQUENCE('ff-2:worker'));
  assert.deepEqual(h.sleeps, [700, 1200, 700, 150]);
});

test('an ownership violation appearing only after recreation destroys the resurrected session', async () => {
  let checks = 0;
  const h = harness({
    exec: (tmuxCommand) => {
      if (tmuxCommand.startsWith('has-session')) return { exitCode: 1, stdout: '' };
      if (tmuxCommand === "send-keys -t 'ff-2:1' C-c C-u") {
        return { exitCode: 1, stdout: '', stderr: "can't find session: ff-2" };
      }
      return { exitCode: 0, stdout: '' };
    },
    assertOwnership: async () => {
      checks += 1;
      // First check passes (teardown had not marked state yet); the re-check
      // after recreation observes the release that raced us.
      if (checks >= 2) {
        throw new Error(
          'Not recreating session ff-2: slot is releasing; the session teardown is intentional',
        );
      }
    },
  });
  await assert.rejects(
    () => runLaunchPreludeAndSend(h.prelude),
    /teardown is intentional \(detected after recreation; recreated session destroyed\)/,
  );
  assert.equal(h.reensured, 1);
  assert.equal(h.commands.at(-1), "kill-session -t 'ff-2'");
});

test('a session lost at the launch-line send restarts from the pre-clear, not mid-sequence', async () => {
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
  assert.deepEqual(h.commands.slice(-4), FULL_SEQUENCE('ff-2:worker'));
});

test('a session lost at the Enter submit also restarts the full sequence (line is retyped)', async () => {
  const h = harness({
    exec: (tmuxCommand) => {
      if (tmuxCommand.startsWith('has-session')) return { exitCode: 1, stdout: '' };
      if (tmuxCommand === "send-keys -t 'ff-2:1' Enter") {
        return { exitCode: 1, stdout: '', stderr: "can't find session: ff-2" };
      }
      return { exitCode: 0, stdout: '' };
    },
  });
  const { target } = await runLaunchPreludeAndSend(h.prelude);
  assert.equal(target, 'ff-2:worker');
  // The launch line is retyped before the fresh Enter — never a bare Enter
  // submitting an empty prompt.
  assert.deepEqual(h.commands.slice(-4), FULL_SEQUENCE('ff-2:worker'));
});

test('the ownership fence blocks recreation after an intentional teardown', async () => {
  const h = harness({
    exec: (tmuxCommand) =>
      tmuxCommand.startsWith('has-session')
        ? { exitCode: 1, stdout: '' }
        : { exitCode: 1, stdout: '', stderr: "can't find session: ff-2" },
    assertOwnership: async () => {
      throw new Error(
        'Not recreating session ff-2: slot is releasing; the session teardown is intentional',
      );
    },
  });
  await assert.rejects(() => runLaunchPreludeAndSend(h.prelude), /teardown is intentional/);
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

test('a second session loss after recreation fails the dispatch honestly', async () => {
  const h = harness({
    exec: (tmuxCommand) =>
      tmuxCommand.startsWith('has-session')
        ? { exitCode: 1, stdout: '' }
        : { exitCode: 1, stdout: '', stderr: "can't find session: ff-2" },
  });
  await assert.rejects(
    () => runLaunchPreludeAndSend(h.prelude),
    /disappeared mid-launch .* again after recreation; failing the dispatch/,
  );
  assert.equal(h.reensured, 1);
});

// ─── recreation fence predicate ───

const activeRun = { id: 'run-1', status: 'dispatching', slotId: 'macwork-ff-2' };

test('recreationOwnershipViolation allows recovery for a live busy claim', () => {
  assert.equal(
    recreationOwnershipViolation({
      run: activeRun,
      hasRunContext: true,
      slotId: 'macwork-ff-2',
      slotLifecycle: 'busy',
      slotPhase: 'dispatching',
    }),
    null,
  );
});

test('recreationOwnershipViolation blocks terminal, moved, and context-less dispatches', () => {
  assert.match(
    recreationOwnershipViolation({
      run: { ...activeRun, status: 'cancelled' },
      hasRunContext: true,
      slotId: 'macwork-ff-2',
      slotLifecycle: 'busy',
      slotPhase: 'dispatching',
    }) ?? '',
    /run is cancelled; the session teardown was intentional/,
  );
  assert.match(
    recreationOwnershipViolation({
      run: { ...activeRun, slotId: 'macwork-ff-3' },
      hasRunContext: true,
      slotId: 'macwork-ff-2',
      slotLifecycle: 'busy',
      slotPhase: 'dispatching',
    }) ?? '',
    /run is bound to slot macwork-ff-3, not macwork-ff-2/,
  );
  // Strict equality: a detached run (slotId null) has no authority either.
  assert.match(
    recreationOwnershipViolation({
      run: { ...activeRun, slotId: null },
      hasRunContext: true,
      slotId: 'macwork-ff-2',
      slotLifecycle: 'busy',
      slotPhase: 'dispatching',
    }) ?? '',
    /run is bound to slot none, not macwork-ff-2/,
  );
  assert.match(
    recreationOwnershipViolation({
      run: null,
      hasRunContext: true,
      slotId: 'macwork-ff-2',
      slotLifecycle: 'busy',
      slotPhase: 'dispatching',
    }) ?? '',
    /run disappeared/,
  );
  assert.match(
    recreationOwnershipViolation({
      run: null,
      hasRunContext: false,
      slotId: 'macwork-ff-2',
      slotLifecycle: 'busy',
      slotPhase: 'dispatching',
    }) ?? '',
    /no run context/,
  );
});

test('recreationOwnershipViolation blocks slot teardown states (release ordering makes them visible)', () => {
  assert.match(
    recreationOwnershipViolation({
      run: activeRun,
      hasRunContext: true,
      slotId: 'macwork-ff-2',
      slotLifecycle: 'busy',
      slotPhase: 'releasing',
    }) ?? '',
    /slot is releasing/,
  );
  assert.match(
    recreationOwnershipViolation({
      run: activeRun,
      hasRunContext: true,
      slotId: 'macwork-ff-2',
      slotLifecycle: 'ready',
      slotPhase: null,
    }) ?? '',
    /claim on macwork-ff-2 is gone/,
  );
});
