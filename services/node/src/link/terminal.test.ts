import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { openNodeLinkTerminal } from './terminal.js';

test('real node PTY starts, streams, resizes and confirms cancelled attachment closeout', async (t) => {
  const cwd = await realpath(await mkdtemp(path.join(tmpdir(), 'node-link-pty-')));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const controller = new AbortController();
  t.after(() => controller.abort());
  const updates: string[] = [];
  let dimensions!: () => void;
  const resized = new Promise<void>((resolve) => {
    dimensions = resolve;
  });
  const terminal = await openNodeLinkTerminal(
    {
      argv: [
        process.execPath,
        '-e',
        'process.stdout.write("START"); process.on("SIGWINCH", () => process.stdout.write("SIZE="+process.stdout.columns)); setInterval(()=>{},1000)',
      ],
      cwd,
      timeoutMs: 5000,
      maxOutputBytes: 64 * 1024,
      terminal: { cols: 80, rows: 24 },
    },
    controller.signal,
    async (update) => {
      updates.push(update.kind === 'started' ? 'STARTED' : update.text);
      if (updates.join('').includes('START') && update.kind !== 'started')
        terminal.resize({ cols: 110, rows: 30 });
      if (updates.join('').includes('SIZE=110')) dimensions();
    },
  );
  await resized;
  assert.equal(updates[0], 'STARTED');
  controller.abort();
  const result = await terminal.result;
  assert.equal(result.exitCode, 130);
  assert.throws(() => terminal.resize({ cols: 80, rows: 24 }), { code: 'TERMINAL_CLOSED' });
});

test('stalled PTY consumer cannot prevent cancellation and confirmed closeout', async (t) => {
  const controller = new AbortController();
  t.after(() => controller.abort());
  let stalled!: () => void;
  const awaitingCredit = new Promise<void>((resolve) => {
    stalled = resolve;
  });
  const terminal = await openNodeLinkTerminal(
    {
      argv: [
        process.execPath,
        '-e',
        'process.stdout.write("x".repeat(100000));setInterval(()=>{},1000)',
      ],
      cwd: tmpdir(),
      timeoutMs: 5000,
      maxOutputBytes: 1024 * 1024,
      terminal: { cols: 80, rows: 24 },
    },
    controller.signal,
    async (update, signal) => {
      if (update.kind === 'started') return;
      stalled();
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        if (signal.aborted) reject(signal.reason);
      });
    },
  );
  await awaitingCredit;
  controller.abort();
  assert.equal((await terminal.result).exitCode, 130);
});
