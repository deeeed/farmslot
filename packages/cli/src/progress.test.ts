import assert from 'node:assert/strict';
import { test } from 'node:test';

import { withStreamProgress } from './progress.js';

/** Capture everything written to process.stderr for the duration of `fn`. */
async function captureStderr(fn: () => Promise<void>): Promise<string> {
  const original = process.stderr.write.bind(process.stderr);
  let captured = '';
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    captured += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    return true;
  }) as typeof process.stderr.write;
  try {
    await fn();
  } finally {
    process.stderr.write = original;
  }
  return captured;
}

test('withStreamProgress streams output to stderr and returns the work result', async () => {
  let result: string | undefined;
  const stderr = await captureStderr(async () => {
    result = await withStreamProgress(
      'Working',
      async (onData) => {
        onData('step one\n');
        onData('step two\n');
        return 'done';
      },
      // stderr is not a TTY under the test runner, so no spinner path either way.
      true,
    );
  });
  assert.equal(result, 'done');
  assert.equal(stderr, 'step one\nstep two\n');
});

test('withStreamProgress with enabled=false still streams output', async () => {
  const stderr = await captureStderr(async () => {
    await withStreamProgress(
      'Working',
      async (onData) => {
        onData('raw output');
        return undefined;
      },
      false,
    );
  });
  assert.equal(stderr, 'raw output');
});

test('withStreamProgress writes no spinner frame when no output arrives on a non-TTY', async () => {
  const stderr = await captureStderr(async () => {
    await withStreamProgress('Silent work', async () => 'ok', true);
  });
  assert.equal(stderr, '');
});
