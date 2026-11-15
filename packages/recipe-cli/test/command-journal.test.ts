import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
  readCommandJournal,
  readLatestProofJournal,
  recordCommandEvidence,
  withCommandJournal,
} from '../src/harness/command-journal.js';
import { configureHarnessHost, harnessHost } from '../src/harness/host.js';

const originalStdoutWrite = process.stdout.write;
const originalStderrWrite = process.stderr.write;

test('later lifecycle commands retain the last proof under the resolved checkout journal', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'project-journal-'));
  const previous = harnessHost();
  t.after(() => {
    configureHarnessHost(previous);
    fs.rmSync(root, { recursive: true, force: true });
  });
  configureHarnessHost({ ...previous, journaledCommands: ['run', 'stop'] });
  const context = { target: root, runtimeDir: 'runtime' };
  const evidence = path.join(root, 'artifacts');
  await withCommandJournal(
    'run',
    ['run', 'smoke'],
    async () => {
      recordCommandEvidence(evidence);
      return 0;
    },
    context,
  );
  await withCommandJournal(
    'run',
    ['run', 'smoke', '--plan'],
    async () => {
      recordCommandEvidence(path.join(root, 'plan'));
      return 0;
    },
    context,
  );
  await withCommandJournal('stop', ['stop'], async () => 0, context);
  assert.equal(readCommandJournal(root, 'runtime').record?.command, 'stop');
  const proof = readLatestProofJournal(root, 'runtime');
  assert.equal(proof.record?.command, 'run');
  assert.deepEqual(proof.record?.args, ['smoke']);
  assert.deepEqual(proof.record?.evidencePaths, [evidence]);
});

// Live run c45c0781 left 14 of 15 operation logs at 0 bytes: every `run`,
// `doctor` and `prepare` had a record with a verdict and an empty log, the two
// failed runs included. Only `verify` logged, because its work is a spawned
// `mm-harness` child and the spawn path records what it captures. A command
// that does its work in process and prints to its own stdout reached nothing,
// so the log kept the empty file the operation created.
test('an operation logs what the command printed, not only what it spawned', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'operation-log-'));
  const previous = harnessHost();
  t.after(() => {
    configureHarnessHost(previous);
    fs.rmSync(root, { recursive: true, force: true });
  });
  configureHarnessHost({ ...previous, journaledCommands: ['run'] });

  const exitCode = await withCommandJournal(
    'run',
    ['run', 'smoke'],
    async () => {
      process.stdout.write('validating assert_json\n');
      process.stderr.write('assert_output failed: expected 1 got 0\n');
      return 1;
    },
    { target: root, runtimeDir: 'runtime' },
  );
  assert.equal(exitCode, 1);

  const { record } = readCommandJournal(root, 'runtime');
  assert.equal(record?.verdict, 'fail');
  const operations = path.join(root, 'runtime', 'operations');
  const logs = fs.readdirSync(operations).filter((entry) => entry.endsWith('.log'));
  assert.equal(logs.length, 1, 'the operation wrote exactly one log');
  const log = fs.readFileSync(path.join(operations, logs[0]!), 'utf8');
  assert.match(log, /validating assert_json/);
  assert.match(log, /assert_output failed: expected 1 got 0/, 'a failed run must not log nothing');

  // The command's own writers are back, by identity rather than by name.
  assert.equal(process.stdout.write, originalStdoutWrite);
  assert.equal(process.stderr.write, originalStderrWrite);
});

// Restoration has to survive the paths a run actually takes: a command that
// throws, and a journaled command inside another.
test('an operation restores the writers through a throw and through nesting', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'operation-log-restore-'));
  const previous = harnessHost();
  t.after(() => {
    configureHarnessHost(previous);
    fs.rmSync(root, { recursive: true, force: true });
  });
  configureHarnessHost({ ...previous, journaledCommands: ['run', 'stop'] });
  const context = { target: root, runtimeDir: 'runtime' };

  await assert.rejects(
    withCommandJournal(
      'run',
      ['run', 'boom'],
      async () => {
        process.stdout.write('before the throw\n');
        throw new Error('leaf exploded');
      },
      context,
    ),
    /leaf exploded/,
  );
  assert.equal(process.stdout.write, originalStdoutWrite, 'a throw still restores');
  assert.equal(process.stderr.write, originalStderrWrite);

  // Nested: the inner operation logs its own line, and unwinding returns the
  // outer tee first and the real writer last.
  let innerWriter: unknown;
  await withCommandJournal(
    'run',
    ['run', 'outer'],
    async () => {
      const outerWriter = process.stdout.write;
      assert.notEqual(outerWriter, originalStdoutWrite, 'the outer operation is teeing');
      await withCommandJournal(
        'stop',
        ['stop'],
        async () => {
          innerWriter = process.stdout.write;
          process.stdout.write('inner line\n');
          return 0;
        },
        context,
      );
      assert.equal(process.stdout.write, outerWriter, 'the outer tee is back');
      return 0;
    },
    context,
  );
  assert.notEqual(innerWriter, originalStdoutWrite);
  assert.equal(process.stdout.write, originalStdoutWrite, 'nesting unwinds to the real writer');

  const operations = path.join(root, 'runtime', 'operations');
  const logs = fs
    .readdirSync(operations)
    .filter((entry) => entry.endsWith('.log'))
    .map((entry) => fs.readFileSync(path.join(operations, entry), 'utf8'));
  assert.equal(
    logs.filter((text) => text.includes('before the throw')).length,
    1,
    'the output before a throw is kept',
  );
  // The inner line reaches both logs: the operator saw it during both.
  assert.equal(logs.filter((text) => text.includes('inner line')).length, 2);
});

// Grok r1 on #2228: JsonStreamWriter binds its output in the constructor, and
// the farmslot CLI constructs it before the journal exists (recipe-project.ts,
// doctor.ts), then calls isolateStdout() so stray stdout goes to stderr and the
// stream stays parseable. The writer therefore holds the real stdout and
// bypasses the operation tee, so --json-stream's NDJSON — the whole in-process
// transcript of run, doctor and launch — reached the terminal and never the log.
test('a json stream built before the journal still reaches the operation log', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'operation-log-stream-'));
  const previous = harnessHost();
  t.after(() => {
    configureHarnessHost(previous);
    fs.rmSync(root, { recursive: true, force: true });
  });
  configureHarnessHost({ ...previous, journaledCommands: ['run'] });

  // The CLI's order: writer first, then the journal.
  const { JsonStreamWriter } = await import('../src/harness/json-stream.js');
  const stream = new JsonStreamWriter('run', true);
  await withCommandJournal(
    'run',
    ['run', 'smoke'],
    async () => {
      stream.emit('phase', { phase: 'validate' });
      return 0;
    },
    { target: root, runtimeDir: 'runtime' },
  );

  const operations = path.join(root, 'runtime', 'operations');
  const logs = fs.readdirSync(operations).filter((entry) => entry.endsWith('.log'));
  const log = fs.readFileSync(path.join(operations, logs[0]!), 'utf8');
  assert.match(log, /"event":"phase"/, 'the NDJSON transcript is in the log');
  assert.match(log, /"phase":"validate"/);
  // Recorded once, not twice: the writer records only what the tee cannot see.
  assert.equal(log.split('"event":"phase"').length - 1, 1);
});

// The lead's cap, before this reaches a farm node: a verbose run now writes
// everything it prints, where it used to write nothing.
test('an operation log stops at its cap and says what it dropped', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'operation-log-cap-'));
  const previous = harnessHost();
  t.after(() => {
    configureHarnessHost(previous);
    fs.rmSync(root, { recursive: true, force: true });
  });
  configureHarnessHost({ ...previous, journaledCommands: ['run'] });
  const cap = 2 * 1024 * 1024;
  const line = `${'x'.repeat(64 * 1024 - 1)}\n`;

  await withCommandJournal(
    'run',
    ['run', 'verbose'],
    async () => {
      // Comfortably past the cap, in whole chunks.
      for (let written = 0; written < cap + 512 * 1024; written += line.length)
        process.stdout.write(line);
      return 0;
    },
    { target: root, runtimeDir: 'runtime' },
  );

  const operations = path.join(root, 'runtime', 'operations');
  const logs = fs.readdirSync(operations).filter((entry) => entry.endsWith('.log'));
  const log = fs.readFileSync(path.join(operations, logs[0]!), 'utf8');
  const marker = log.match(/\[log truncated at (\d+) bytes; (\d+) further bytes dropped\]/g) ?? [];
  assert.equal(marker.length, 1, 'exactly one truncation marker');
  const [, limit, dropped] = /\[log truncated at (\d+) bytes; (\d+) further bytes dropped\]/.exec(
    log,
  )!;
  assert.equal(Number(limit), cap);
  assert.ok(Number(dropped) > 0, 'the marker reports what was withheld');
  // The payload stays under the cap; only the marker is written past it.
  assert.ok(log.length <= cap + 128, `log is ${log.length} bytes`);
  // Nothing is lost silently: what was kept plus what was dropped is everything.
  assert.ok(log.includes('x'.repeat(1024)), 'the kept output is real output');
});
