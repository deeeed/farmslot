import assert from 'node:assert/strict';
import test from 'node:test';

import {
  type InputLanding,
  inputSequenceSizeForTests,
  type PaneInputRecord,
  resetInputSequencesForTests,
  runInputInOrder,
  tmuxPaneInputRecord,
  writeSequencedInput,
} from './terminal-input-sequence.js';

type Seq = { stream: string; n: number };
type Outcome = 'ok' | 'local-error' | 'remote-timeout' | 'remote-lost-before-typing';

/** What terminal.worker.input does for one batch: in order, written at most once. */
function writer(
  pane: string,
  typed: string[],
  landing: Omit<InputLanding, 'write'> = {},
  typedOnPane?: Map<string, number>,
) {
  return (data: string, seq?: Seq, outcome: Outcome = 'ok') =>
    runInputInOrder(pane, () =>
      writeSequencedInput(pane, seq, {
        ...landing,
        write: (dispatched) => {
          if (outcome === 'local-error') throw new Error('node mini is not connected');
          if (outcome !== 'ok') dispatched();
          if (outcome === 'remote-lost-before-typing')
            throw new Error('Request tmux.send timed out');
          // A host that types each number once, as a capable node does.
          if (landing.typesOnce && seq && (typedOnPane?.get(seq.stream) ?? 0) >= seq.n) return;
          typed.push(data);
          if (landing.typesOnce && seq) typedOnPane?.set(seq.stream, seq.n);
          if (outcome === 'remote-timeout') throw new Error('Request tmux.send timed out');
        },
      }),
    );
}

/** A pane record held outside the gateway's memory, as tmux holds it. */
function paneRecord(): PaneInputRecord & { recorded: Map<string, number> } {
  const recorded = new Map<string, number>();
  return {
    recorded,
    read: async (stream) => recorded.get(stream) ?? null,
    write: async ({ stream, n }) => {
      recorded.set(stream, n);
    },
  };
}

test('a batch resent after a lost reply is acknowledged without being typed again', async () => {
  resetInputSequencesForTests();
  const typed: string[] = [];
  const write = writer('mini:%19', typed);
  await write('echo ONCE\r', { stream: 'a', n: 1 });
  await write('echo ONCE\r', { stream: 'a', n: 1 });
  await write('pwd\r', { stream: 'a', n: 2 });
  // A new queue (new screen or sign-in) starts its own stream at 1.
  await write('ls\r', { stream: 'b', n: 1 });
  // Input without a sequence (an older client) is written as before.
  await write('x');
  await write('x');
  assert.deepEqual(typed, ['echo ONCE\r', 'pwd\r', 'ls\r', 'x', 'x']);
});

test('a batch that failed before reaching the pane is written by its resend', async () => {
  resetInputSequencesForTests();
  const typed: string[] = [];
  const write = writer('slot:mmt-3', typed);
  await assert.rejects(write('make\r', { stream: 'a', n: 1 }, 'local-error'), /not connected/);
  await write('make\r', { stream: 'a', n: 1 });
  assert.deepEqual(typed, ['make\r']);
});

// A node predating `terminalInputSequence` may have typed the batch even though its answer never
// came back, and nothing can tell: the resend is refused.
test('an older node: a batch whose remote write ended without an answer is not written again', async () => {
  resetInputSequencesForTests();
  const typed: string[] = [];
  const write = writer('mini:%7', typed);
  await assert.rejects(
    write('make deploy\r', { stream: 'a', n: 1 }, 'remote-timeout'),
    /timed out/,
  );
  await assert.rejects(write('make deploy\r', { stream: 'a', n: 1 }), (error: unknown) => {
    assert.equal((error as { code?: string }).code, 'TERMINAL_INPUT_UNCERTAIN');
    return true;
  });
  // The user's explicit resend carries a new number and is written.
  await write('make deploy\r', { stream: 'a', n: 2 });
  assert.deepEqual(typed, ['make deploy\r', 'make deploy\r']);
});

test('a resend that arrives while the original is still being written waits for it', async () => {
  resetInputSequencesForTests();
  const typed: string[] = [];
  let release!: () => void;
  const slow = new Promise<void>((resolve) => (release = resolve));
  const pane = 'mini:%4';
  const original = runInputInOrder(pane, () =>
    writeSequencedInput(
      pane,
      { stream: 'a', n: 1 },
      {
        write: async () => {
          await slow;
          typed.push('echo once\r');
        },
      },
    ),
  );
  const resend = writer(pane, typed)('echo once\r', { stream: 'a', n: 1 });
  release();
  await Promise.all([original, resend]);
  assert.deepEqual(typed, ['echo once\r']);
});

test('a malformed sequence is refused before anything is written', async () => {
  resetInputSequencesForTests();
  const typed: string[] = [];
  const write = writer('mini:%8', typed);
  for (const seq of [
    { stream: '', n: 1 },
    { stream: 'x'.repeat(65), n: 1 },
    { stream: 'a b', n: 1 },
    { stream: 'a', n: Number.POSITIVE_INFINITY },
    { stream: 'a', n: -1 },
    { stream: 'a', n: 1.5 },
  ])
    await assert.rejects(write('x', seq), /seq needs a stream/);
  assert.deepEqual(typed, []);
});

test('remembered streams and panes stay bounded', async () => {
  resetInputSequencesForTests();
  const typed: string[] = [];
  for (let stream = 0; stream < 40; stream++)
    await writer('pane', typed)('k', { stream: `s${stream}`, n: 1 });
  for (let pane = 0; pane < 600; pane++)
    await writer(`p${pane}`, typed)('k', { stream: 'a', n: 1 });
  const size = inputSequenceSizeForTests();
  assert.equal(size.panes, 512);
  assert.ok(size.streams <= 512 + 16);
  // The most recent pane is still remembered; the oldest was forgotten first.
  const before = typed.length;
  await writer('p599', typed)('k', { stream: 'a', n: 1 });
  await writer('p0', typed)('k', { stream: 'a', n: 1 });
  assert.equal(typed.length, before + 1);
});

// The node records each batch on the pane and drops a repeat, so the gateway sends it again.
test('a capable node: a batch whose write ended without an answer is resent, typed once', async () => {
  resetInputSequencesForTests();
  const typed: string[] = [];
  const onPane = new Map<string, number>();
  const write = writer('mini:%7', typed, { typesOnce: true }, onPane);
  await assert.rejects(
    write('make deploy\r', { stream: 'a', n: 1 }, 'remote-timeout'),
    /timed out/,
  );
  await write('make deploy\r', { stream: 'a', n: 1 });
  await write('ls\r', { stream: 'a', n: 2 });
  assert.deepEqual(typed, ['make deploy\r', 'ls\r']);
});

test('a capable node: a batch lost before it was typed is typed by its resend', async () => {
  resetInputSequencesForTests();
  const typed: string[] = [];
  const write = writer('mini:%7', typed, { typesOnce: true }, new Map());
  await assert.rejects(
    write('make\r', { stream: 'a', n: 1 }, 'remote-lost-before-typing'),
    /timed out/,
  );
  await write('make\r', { stream: 'a', n: 1 });
  assert.deepEqual(typed, ['make\r']);
});

// A gateway restart forgets everything in memory; the pane still knows what it was sent.
test('after a restart, a batch the pane recorded is acknowledged without typing', async () => {
  resetInputSequencesForTests();
  const typed: string[] = [];
  const record = paneRecord();
  await writer('slot:mmt-3', typed, { record })('make deploy\r', { stream: 'a', n: 1 });
  resetInputSequencesForTests();
  await writer('slot:mmt-3', typed, { record })('make deploy\r', { stream: 'a', n: 1 });
  await writer('slot:mmt-3', typed, { record })('ls\r', { stream: 'a', n: 2 });
  assert.deepEqual(typed, ['make deploy\r', 'ls\r']);
  assert.equal(record.recorded.get('a'), 2);
});

test('a pane record decides a resend after a remote write ended without an answer', async () => {
  resetInputSequencesForTests();
  const typed: string[] = [];
  const record = paneRecord();
  const write = writer('slot:mmt-4', typed, { record });
  // Typed and recorded on the host, but the answer was lost.
  await assert.rejects(write('make\r', { stream: 'a', n: 1 }, 'remote-timeout'), /timed out/);
  record.recorded.set('a', 1);
  await write('make\r', { stream: 'a', n: 1 });
  // Lost before it was typed: nothing recorded, so the resend types it.
  await assert.rejects(
    write('pwd\r', { stream: 'a', n: 2 }, 'remote-lost-before-typing'),
    /timed out/,
  );
  await write('pwd\r', { stream: 'a', n: 2 });
  assert.deepEqual(typed, ['make\r', 'pwd\r']);
});

test('an unreadable or unwritable pane record never blocks typing', async () => {
  resetInputSequencesForTests();
  const typed: string[] = [];
  const broken: PaneInputRecord = {
    read: async () => {
      throw new Error('node mini is not connected');
    },
    write: async () => {
      throw new Error('node mini is not connected');
    },
  };
  const write = writer('slot:mmt-5', typed, { record: broken });
  await write('ls\r', { stream: 'a', n: 1 });
  await write('ls\r', { stream: 'a', n: 1 });
  assert.deepEqual(typed, ['ls\r']);
});

test('the tmux pane record reads, writes and prunes pane user options', async () => {
  const commands: string[] = [];
  const stale = Array.from({ length: 17 }, (_, i) => `@farmslot-input-s${i} 1:${100 + i}`);
  const record = tmuxPaneInputRecord('dev:0', async (command) => {
    commands.push(command.split('\n').at(-1)!);
    const stdout = command.includes('-pqv')
      ? '3:1700000000000\n'
      : command.includes('show-options -p')
        ? `${stale.join('\n')}\n`
        : '';
    return { exitCode: 0, stdout, stderr: '' };
  });
  assert.equal(await record.read('q1'), 3);
  await record.write({ stream: 'q1', n: 4 });
  assert.match(commands[0]!, /show-options -pqv -t 'dev:0' '@farmslot-input-q1'$/);
  assert.match(
    commands[1]!,
    /set-option -p -t 'dev:0' '@farmslot-input-q1' '4:\d+' && "\$TMUX_BIN" show-options -p -t 'dev:0'$/,
  );
  // The least recently written of 17 records goes.
  assert.deepEqual(commands.slice(2), [
    `"$TMUX_BIN" set-option -p -u -t 'dev:0' '@farmslot-input-s0'`,
  ]);
  const failing = tmuxPaneInputRecord('dev:0', async () => ({
    exitCode: 1,
    stdout: '',
    stderr: "can't find pane: dev:0",
  }));
  await assert.rejects(failing.read('q1'), /can't find pane/);
});
