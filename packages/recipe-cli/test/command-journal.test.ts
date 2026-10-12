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
