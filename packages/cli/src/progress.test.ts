import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

import { withProgress, withStreamProgress } from './progress.js';

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

/**
 * Capture stderr while forcing `process.stderr.isTTY` true — the spinner path
 * only activates on a TTY, so the under-the-runner (non-TTY) capture above
 * cannot exercise frame rendering, first-byte clearing, or error cleanup.
 */
async function captureTtyStderr(fn: () => Promise<void>): Promise<string> {
  const stream = process.stderr as unknown as { isTTY?: boolean };
  const originalIsTty = stream.isTTY;
  stream.isTTY = true;
  try {
    return await captureStderr(fn);
  } finally {
    stream.isTTY = originalIsTty;
  }
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

test('withProgress renders spinner frames and clears the line on success (TTY)', async () => {
  mock.timers.enable({ apis: ['setInterval'] });
  try {
    let resolveWork: (value: string) => void = () => {};
    const work = new Promise<string>((resolve) => {
      resolveWork = resolve;
    });
    let result: string | undefined;
    const stderr = await captureTtyStderr(async () => {
      const pending = withProgress('Loading runs', () => work, true);
      mock.timers.tick(80);
      mock.timers.tick(80);
      resolveWork('done');
      result = await pending;
    });
    assert.equal(result, 'done');
    assert.match(stderr, /Loading runs/);
    assert.ok(stderr.includes('\x1b[K'), 'clears the spinner line on completion');
  } finally {
    mock.timers.reset();
  }
});

test('withProgress clears the spinner line when work throws (TTY)', async () => {
  mock.timers.enable({ apis: ['setInterval'] });
  try {
    let rejectWork: (err: Error) => void = () => {};
    const work = new Promise<string>((_, reject) => {
      rejectWork = reject;
    });
    let threw = false;
    const stderr = await captureTtyStderr(async () => {
      const pending = withProgress('Loading', () => work, true);
      mock.timers.tick(80);
      rejectWork(new Error('boom'));
      await pending.catch(() => {
        threw = true;
      });
    });
    assert.ok(threw, 'error propagates to the caller');
    assert.ok(stderr.includes('\x1b[K'), 'clears the spinner line on the error path');
  } finally {
    mock.timers.reset();
  }
});

test('withProgress writes nothing when disabled even on a TTY (machine mode)', async () => {
  let result: string | undefined;
  const stderr = await captureTtyStderr(async () => {
    result = await withProgress('Loading', async () => 'x', false);
  });
  assert.equal(result, 'x');
  assert.equal(stderr, '', 'no spinner bytes leak to stderr in machine mode');
});

test('withStreamProgress clears the spinner on the first stream byte (TTY)', async () => {
  mock.timers.enable({ apis: ['setInterval'] });
  try {
    const stderr = await captureTtyStderr(async () => {
      await withStreamProgress(
        'Preparing slot',
        async (onData) => {
          mock.timers.tick(80);
          onData('first line\n');
          return 'ok';
        },
        true,
      );
    });
    assert.match(stderr, /Preparing slot/);
    assert.ok(stderr.includes('\x1b[K'), 'clears on the first stream byte');
    assert.ok(stderr.endsWith('first line\n'), 'stream output flows after the clear');
  } finally {
    mock.timers.reset();
  }
});

test('withStreamProgress clears the spinner when stream work throws (TTY)', async () => {
  mock.timers.enable({ apis: ['setInterval'] });
  try {
    let threw = false;
    const stderr = await captureTtyStderr(async () => {
      await withStreamProgress(
        'Releasing slot',
        async () => {
          mock.timers.tick(80);
          throw new Error('boom');
        },
        true,
      ).catch(() => {
        threw = true;
      });
    });
    assert.ok(threw, 'error propagates to the caller');
    assert.ok(stderr.includes('\x1b[K'), 'clears the spinner line on the error path');
  } finally {
    mock.timers.reset();
  }
});

test('withStreamProgress writes only raw output when disabled on a TTY (machine mode)', async () => {
  const stderr = await captureTtyStderr(async () => {
    await withStreamProgress(
      'Preparing',
      async (onData) => {
        onData('payload');
        return undefined;
      },
      false,
    );
  });
  assert.equal(stderr, 'payload', 'no spinner control bytes in machine mode');
});
