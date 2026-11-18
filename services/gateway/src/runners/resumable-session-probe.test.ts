// Codex r1 on #2347: runtime recovery relaunched a runner at a saved session
// path without proving the transcript was still there. pi does not fail on a
// missing or empty file — it starts a *new* conversation at that name — so the
// liveness check that follows reports the old session as reloaded with none of
// its work in it. Recovery now runs this command on the slot first, so what it
// accepts and refuses is the gate.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import {
  resumableSessionContentProbeCommand,
  resumableSessionProbeCommand,
} from './session-process.js';

const run = promisify(execFile);

/** The probe as the slot runs it: a shell, its exit code the whole answer. */
async function probe(command: string): Promise<number> {
  try {
    await run('/bin/sh', ['-c', command]);
    return 0;
  } catch (error) {
    return typeof (error as { code?: unknown }).code === 'number'
      ? (error as { code: number }).code
      : 1;
  }
}

test('the content probe accepts a transcript and refuses one that is gone or empty', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'resumable-session-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const saved = path.join(root, '2026-11-18T03-34-24-255Z_01a1ecb8.jsonl');
  const empty = path.join(root, 'empty.jsonl');
  const missing = path.join(root, 'gone.jsonl');
  const directory = path.join(root, 'grok-session');
  await writeFile(saved, '{"role":"user","content":"hello"}\n');
  await writeFile(empty, '');
  await mkdir(directory, { recursive: true });

  assert.equal(await probe(resumableSessionContentProbeCommand(saved)), 0, 'a real transcript');
  assert.equal(
    await probe(resumableSessionContentProbeCommand(directory)),
    0,
    'a session directory (Grok) only has to be readable',
  );
  assert.notEqual(
    await probe(resumableSessionContentProbeCommand(missing)),
    0,
    'a missing transcript must refuse: the runner would start a new conversation there',
  );
  assert.notEqual(
    await probe(resumableSessionContentProbeCommand(empty)),
    0,
    'an empty transcript is the same new conversation with the old name',
  );
  // The existence-only form is what let the empty file through.
  assert.equal(await probe(resumableSessionProbeCommand(empty)), 0);
});

test('the content probe survives a path with spaces and quotes', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "resumable session's "));
  t.after(() => rm(root, { recursive: true, force: true }));
  const saved = path.join(root, 'a b.jsonl');
  await writeFile(saved, 'x\n');

  assert.equal(await probe(resumableSessionContentProbeCommand(saved)), 0);
});
