import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { test } from 'node:test';
import { promisify } from 'node:util';

import { createTerminalInputWriter, requireInputSequence } from './terminal-input.js';

const execFileAsync = promisify(execFile);

/** tmux as the writer drives it: keys typed per pane, and pane user options. */
function fakeTmux() {
  const typed: string[] = [];
  const options = new Map<string, Map<string, string>>();
  let failRecord = false;
  const run = async (args: string[]): Promise<string> => {
    const [command, ...rest] = args;
    const pane = rest[rest.indexOf('-t') + 1]!;
    const paneOptions = options.get(pane) ?? new Map<string, string>();
    options.set(pane, paneOptions);
    if (command === 'send-keys') {
      typed.push(`${pane} ${rest[2]}`);
      return '';
    }
    if (command === 'show-options' && rest[0] === '-pqv')
      return paneOptions.get(rest.at(-1)!) ?? '';
    if (command === 'show-options')
      return [...paneOptions].map(([name, value]) => `${name} ${value}\n`).join('');
    if (command === 'set-option') {
      if (failRecord) throw new Error('set-option failed');
      if (rest.includes('-u')) paneOptions.delete(rest.at(-1)!);
      else paneOptions.set(rest.at(-2)!, rest.at(-1)!);
      return '';
    }
    throw new Error(`unexpected tmux ${command}`);
  };
  let clock = 0;
  return {
    typed,
    options,
    run,
    now: () => ++clock,
    failRecords: () => (failRecord = true),
  };
}

test('a batch sent again after a lost reply is acknowledged without typing', async () => {
  const tmux = fakeTmux();
  const sendOnce = createTerminalInputWriter(tmux.run, tmux.now);
  assert.equal(await sendOnce('%7', 'make deploy\r', false, { stream: 'q1', n: 1 }), true);
  assert.equal(await sendOnce('%7', 'make deploy\r', false, { stream: 'q1', n: 1 }), false);
  assert.equal(await sendOnce('%7', 'ls\r', false, { stream: 'q1', n: 2 }), true);
  // Another stream, or another pane, keeps its own numbers.
  assert.equal(await sendOnce('%7', 'pwd\r', false, { stream: 'q2', n: 1 }), true);
  assert.equal(await sendOnce('%8', 'pwd\r', false, { stream: 'q1', n: 1 }), true);
  assert.deepEqual(tmux.typed, ['%7 make deploy\r', '%7 ls\r', '%7 pwd\r', '%8 pwd\r']);
});

// The record lives on the pane, so a node or gateway restart between the write and its resend
// still finds it.
test('a restarted writer finds the batch recorded on the pane', async () => {
  const tmux = fakeTmux();
  await createTerminalInputWriter(tmux.run, tmux.now)('%7', 'make deploy\r', false, {
    stream: 'q1',
    n: 1,
  });
  const restarted = createTerminalInputWriter(tmux.run, tmux.now);
  assert.equal(await restarted('%7', 'make deploy\r', false, { stream: 'q1', n: 1 }), false);
  assert.deepEqual(tmux.typed, ['%7 make deploy\r']);
});

test('a resend that arrives while the original is being typed waits for it', async () => {
  const tmux = fakeTmux();
  let release!: () => void;
  const slow = new Promise<void>((resolve) => (release = resolve));
  const run = async (args: string[]) => {
    if (args[0] === 'send-keys') await slow;
    return tmux.run(args);
  };
  const sendOnce = createTerminalInputWriter(run, tmux.now);
  const original = sendOnce('%7', 'echo once\r', false, { stream: 'q1', n: 1 });
  const resend = sendOnce('%7', 'echo once\r', false, { stream: 'q1', n: 1 });
  release();
  assert.deepEqual(await Promise.all([original, resend]), [true, false]);
  assert.deepEqual(tmux.typed, ['%7 echo once\r']);
});

test('keys typed but not recorded still report typed', async () => {
  const tmux = fakeTmux();
  const sendOnce = createTerminalInputWriter(tmux.run, tmux.now);
  tmux.failRecords();
  assert.equal(await sendOnce('%7', 'ls\r', false, { stream: 'q1', n: 1 }), true);
  assert.deepEqual(tmux.typed, ['%7 ls\r']);
});

test('a pane keeps records for its 16 most recently written streams', async () => {
  const tmux = fakeTmux();
  const sendOnce = createTerminalInputWriter(tmux.run, tmux.now);
  for (let stream = 0; stream < 20; stream++)
    await sendOnce('%7', 'k', false, { stream: `s${stream}`, n: 1 });
  await sendOnce('%7', 'k', false, { stream: 's0', n: 2 });
  const kept = [...tmux.options.get('%7')!.keys()].sort();
  assert.equal(kept.length, 16);
  assert.ok(kept.includes('@farmslot-input-s0'), 'rewritten stream kept');
  assert.ok(!kept.includes('@farmslot-input-s1'), 'least recently written dropped');
  assert.ok(kept.includes('@farmslot-input-s19'));
});

test('a malformed seq is refused', () => {
  for (const seq of [
    null,
    { stream: '', n: 1 },
    { stream: 'a b', n: 1 },
    { stream: 'x'.repeat(65), n: 1 },
    { stream: 'a', n: -1 },
    { stream: 'a', n: 1.5 },
  ])
    assert.throws(() => requireInputSequence(seq), /seq needs a stream/);
  assert.deepEqual(requireInputSequence({ stream: 'mfx1-ab', n: 3 }), { stream: 'mfx1-ab', n: 3 });
});

// Real tmux only on the test runner's private server (scripts/quality/run-tsx-tests.mjs).
const tmuxSandbox =
  !process.env.TMUX &&
  process.env.TMUX_TMPDIR &&
  process.env.FARMSLOT_TMUX_SANDBOX ===
    `${process.env.TMUX_TMPDIR}/tmux-${process.getuid?.() ?? 0}/default`
    ? process.env.FARMSLOT_TMUX_SANDBOX
    : null;

test('real tmux types a resent batch once and keeps the record on the pane', async (t) => {
  if (!tmuxSandbox) {
    t.skip('needs the test runner tmux sandbox (FARMSLOT_TMUX_SANDBOX)');
    return;
  }
  const tmux = async (args: string[]) =>
    (await execFileAsync('tmux', ['-S', tmuxSandbox, ...args], { timeout: 2000 })).stdout;
  try {
    await tmux(['-V']);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      t.skip('tmux is not installed');
      return;
    }
    throw error;
  }
  const session = `farmslot_input_once_${process.pid}_${Date.now()}`;
  await tmux(['new-session', '-d', '-s', session, 'cat']);
  try {
    const pane = (await tmux(['display-message', '-p', '-t', session, '#{pane_id}'])).trim();
    const sendOnce = createTerminalInputWriter(tmux);
    assert.equal(await sendOnce(pane, 'ONCE', false, { stream: 'q1', n: 1 }), true);
    assert.equal(
      await createTerminalInputWriter(tmux)(pane, 'ONCE', false, { stream: 'q1', n: 1 }),
      false,
    );
    assert.equal(await sendOnce(pane, 'NEXT', false, { stream: 'q1', n: 2 }), true);
    // NEXT went in after any second ONCE would have, so once it shows, ONCE has its final count.
    let screen = '';
    for (let tries = 0; tries < 100 && !screen.includes('NEXT'); tries++) {
      screen = await tmux(['capture-pane', '-p', '-t', pane]);
      if (!screen.includes('NEXT')) await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(screen.match(/ONCE/g)?.length, 1, screen);
    assert.match(
      await tmux(['show-options', '-pqv', '-t', pane, '@farmslot-input-q1']),
      /^2:\d+\n?$/,
    );
  } finally {
    await tmux(['kill-session', '-t', session]);
  }
});
