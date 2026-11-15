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

  // The streams are the command's own again once the operation ends.
  assert.equal(process.stdout.write.name, originalStdoutWrite.name);
});
