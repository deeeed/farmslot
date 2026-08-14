import assert from 'node:assert/strict';
import { mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { watchFile } from './fs-watch.js';

test('watchFile remains attached across repeated atomic replacements', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'farmslot-fs-watch-'));
  const target = path.join(dir, 'SIGNAL.json');
  await writeFile(target, 'initial');

  const observed: string[] = [];
  let wake: (() => void) | null = null;
  const watcher = watchFile(target, (content) => {
    observed.push(content);
    wake?.();
  });

  const replaceAndWait = async (content: string): Promise<void> => {
    const replacement = `${target}.next`;
    const observedReplacement = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`watcher missed ${content}`)), 2_000);
      wake = () => {
        if (!observed.includes(content)) return;
        clearTimeout(timer);
        wake = null;
        resolve();
      };
    });
    await writeFile(replacement, content);
    await rename(replacement, target);
    await observedReplacement;
  };

  try {
    await replaceAndWait('first');
    await replaceAndWait('second');
    assert.deepEqual(observed, ['first', 'second']);
  } finally {
    watcher.stop();
    await rm(dir, { recursive: true, force: true });
  }
});
