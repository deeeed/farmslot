import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

import type { AgentContext, Run } from '@farmslot/protocol';

// mock.module replaces a module wholesale, so the real namespaces are spread in
// and only the slot, run-store and process probes these tests drive are faked.
import * as realCore from '../core/index.js';
import * as realRunStore from '../runs/store.js';

import * as realSessionProcess from './session-process.js';

const RUN_ID = 'run-owned-stop';
const SLOT_ID = 'macwork-mmt-3';

let run: Run;
interface FakePane {
  session: string;
  panePid: string;
  runnerPid: string;
  runnerLive: boolean;
  /** False for a runner that ignores the exit command. */
  exitsOnRequest: boolean;
}
/** Live panes by pane id. */
let panes: Map<string, FakePane>;
let commands: string[];
/** Runs when the pane is set to remain on exit: between the ownership check and the send. */
let onPreserve: (() => void) | null;

mock.module('../core/index.js', {
  namedExports: {
    ...realCore,
    loadSlotVars: async () => ({ slotId: SLOT_ID, remoteRepo: '/slot', host: 'localhost' }),
    readSlotRow: async () => ({ current_run_id: RUN_ID, slot_epoch: 1 }),
    execOnSlot: async (_vars: unknown, cmd: string) => {
      commands.push(cmd);
      const display = /display-message -p -t '?(%\d+)/.exec(cmd);
      if (display) {
        const pane = panes.get(display[1]);
        return pane
          ? { stdout: `${pane.session}\t${display[1]}\t${pane.panePid}\n`, stderr: '', exitCode: 0 }
          : { stdout: '', stderr: "can't find pane", exitCode: 1 };
      }
      if (cmd.includes('remain-on-exit on')) onPreserve?.();
      const send = /send-keys -t '?(%\d+)'? -l '?\/exit/.exec(cmd);
      const pane = send && panes.get(send[1]);
      if (pane?.exitsOnRequest) pane.runnerLive = false;
      return { stdout: '', stderr: '', exitCode: 0 };
    },
  },
});
mock.module('../runs/store.js', {
  namedExports: { ...realRunStore, getRun: () => run },
});
mock.module('./session-process.js', {
  namedExports: {
    ...realSessionProcess,
    probeRunnerDescendantPid: async (_vars: unknown, panePid: string) => {
      const pane = [...panes.values()].find((p) => p.panePid === panePid && p.runnerLive);
      return pane ? { state: 'present', pid: pane.runnerPid } : { state: 'absent' };
    },
  },
});

const { stopRunOwnedTmuxWorkers } = await import('./owned-stop.js');

/** TAT-4091's shape: a dev worker whose conversation id was never captured, plus a reviewer. */
type Publication = 'published_ready' | 'published_draft';

function tat4091Run(publicationStatus?: Publication, runner = 'codex'): Run {
  const dev = {
    id: 'dev',
    role: 'dev',
    label: 'Dev',
    status: 'complete',
    runner,
    runId: RUN_ID,
    slotId: SLOT_ID,
    target: { session: 'mmt-3', window: 'dev', pane: '1', paneId: '%75', target: 'mmt-3:dev' },
    runnerSessionId: null,
    runnerSessionPath: null,
  } as AgentContext;
  const reviewer = {
    id: 'rev-codex',
    role: 'self-review',
    label: 'rev-codex',
    status: 'complete',
    runner: 'codex',
    runId: RUN_ID,
    slotId: SLOT_ID,
    target: { session: 'mmt-3', window: 'rev-codex', pane: '%88', target: '@88' },
    runnerSessionId: 'session-1',
    runnerSessionPath: '/sessions/rollout.jsonl',
  } as AgentContext;
  return {
    id: RUN_ID,
    slotId: SLOT_ID,
    status: 'done',
    agentContexts: [dev, reviewer],
    engineState: publicationStatus ? { publishGate: { publicationStatus } } : {},
  } as unknown as Run;
}

function setup(publicationStatus?: Publication, runner = 'codex'): void {
  run = tat4091Run(publicationStatus, runner);
  // The reviewer pane already closed; the idle dev worker still holds the slot.
  panes = new Map([
    [
      '%75',
      {
        session: 'mmt-3',
        panePid: '62888',
        runnerPid: '4242',
        runnerLive: true,
        exitsOnRequest: true,
      },
    ],
  ]);
  commands = [];
  onPreserve = null;
}

const exitsSentTo = (paneId: string) =>
  commands.filter((cmd) => cmd.includes(`send-keys -t '${paneId}' -l '/exit'`)).length;

test('a published run exits its idle worker even without a saved conversation id', async () => {
  setup('published_ready');

  assert.equal(await stopRunOwnedTmuxWorkers(run), null);
  assert.equal(exitsSentTo('%75'), 1);
  assert.ok(commands.some((cmd) => cmd.includes("set-option -p -t '%75' remain-on-exit on")));
  assert.equal(panes.get('%75')!.runnerLive, false);
  // The reviewer's exact pane is read from `pane`, so it no longer defers cleanup.
  assert.ok(commands.some((cmd) => /display-message -p -t '?%88/.test(cmd)));
});

test('an unpublished run keeps a worker it cannot resume', async () => {
  setup();

  assert.match(
    (await stopRunOwnedTmuxWorkers(run)) ?? '',
    /Worker dev cannot be stopped without its exact saved conversation identity/,
  );
  assert.equal(exitsSentTo('%75'), 0);
  assert.equal(panes.get('%75')!.runnerLive, true);
});

test('a published run never exits a pane another session now holds', async () => {
  setup('published_ready');
  panes.get('%75')!.session = 'other-session';

  assert.match((await stopRunOwnedTmuxWorkers(run)) ?? '', /pane ownership changed/);
  assert.equal(exitsSentTo('%75'), 0);
});

test('a pane moved to another session after the check gets no exit', async () => {
  setup('published_ready');
  onPreserve = () => {
    panes.get('%75')!.session = 'other-session';
  };

  assert.match(
    (await stopRunOwnedTmuxWorkers(run)) ?? '',
    /Worker dev stop was not confirmed: the worker pane changed before the exit was sent/,
  );
  assert.equal(exitsSentTo('%75'), 0);
  assert.equal(panes.get('%75')!.runnerLive, true);
});

test('a runner replaced in the pane after the check gets no exit', async () => {
  setup('published_ready');
  onPreserve = () => {
    panes.get('%75')!.runnerPid = '5151';
  };

  assert.match(
    (await stopRunOwnedTmuxWorkers(run)) ?? '',
    /the worker runner changed before the exit was sent/,
  );
  assert.equal(exitsSentTo('%75'), 0);
});

test('a draft publication also frees the worker', async () => {
  setup('published_draft');

  assert.equal(await stopRunOwnedTmuxWorkers(run), null);
  assert.equal(exitsSentTo('%75'), 1);
});

test('a published worker whose runner has no graceful exit is left alone', async () => {
  setup('published_ready', 'pi');

  assert.match(
    (await stopRunOwnedTmuxWorkers(run)) ?? '',
    /runner 'pi' has no graceful exit capability/,
  );
  assert.ok(!commands.some((cmd) => cmd.includes('send-keys')));
});

test('a worker that ignores the exit is reported once the ceiling passes', async () => {
  setup('published_ready');
  panes.get('%75')!.exitsOnRequest = false;

  assert.match(
    (await stopRunOwnedTmuxWorkers(run, { exitTimeoutMs: 300 })) ?? '',
    /runner did not exit within 300ms/,
  );
  assert.equal(exitsSentTo('%75'), 1);
});
