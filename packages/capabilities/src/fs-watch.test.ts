import assert from 'node:assert/strict';
import * as realFs from 'node:fs/promises';
import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { mock, test } from 'node:test';

interface HeldRead {
  file: string;
  content: string;
  captured(): void;
  wait: Promise<void>;
}
let heldRead: HeldRead | undefined;
mock.module('node:fs/promises', {
  namedExports: {
    ...realFs,
    readFile: async (...args: Parameters<typeof realFs.readFile>) => {
      const value = await realFs.readFile(...args);
      const held = heldRead;
      if (held && args[0] === held.file && value === held.content) {
        held.captured();
        await held.wait;
      }
      return value;
    },
  },
});
const { watchFile } = await import('./fs-watch.js');
import type { FileWatchUnavailable } from '@farmslot/protocol';

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

test(
  'file observations distinguish removal, read errors and identical-content recovery',
  { timeout: 5000 },
  async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'farmslot-fs-states-'));
    const file = path.join(dir, 'CHECKLIST.md');
    await writeFile(file, 'same contents', { mode: 0o600 });
    const values: string[] = [];
    const unavailable: FileWatchUnavailable[] = [];
    let changed: (() => void) | undefined;
    const handle = watchFile(
      file,
      (content) => {
        values.push(content);
        changed?.();
      },
      {
        onUnavailable: (value) => {
          unavailable.push(value);
          changed?.();
        },
      },
    );
    const expectChange = async (write: () => Promise<void>, ready: () => boolean) => {
      const observed = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error('File state transition was not observed')),
          3000,
        );
        changed = () => {
          if (ready()) {
            clearTimeout(timer);
            resolve();
          }
        };
      });
      await write();
      await observed;
    };
    try {
      await expectChange(
        () => rm(file),
        () => unavailable.at(-1)?.kind === 'deleted',
      );
      await expectChange(
        () => writeFile(file, 'same contents', { mode: 0o600 }),
        () => values.length === 1,
      );
      await expectChange(
        async () => {
          await rm(file);
          await mkdir(file);
        },
        () => unavailable.at(-1)?.kind === 'error',
      );
      const failure = unavailable.at(-1);
      assert(failure?.kind === 'error' && failure.error.code === 'EISDIR');
      await expectChange(
        async () => {
          await rm(file, { recursive: true });
          await writeFile(file, 'same contents');
        },
        () => values.length === 2,
      );
      assert.deepEqual(values, ['same contents', 'same contents']);
      const before = values.length;
      handle.stop();
      await writeFile(file, 'after stop');
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(values.length, before);
    } finally {
      handle.stop();
      await rm(dir, { recursive: true, force: true });
    }
  },
);

test(
  'a late file read cannot overwrite a newer event or publish after stop',
  { timeout: 5000 },
  async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'farmslot-fs-read-order-'));
    const file = path.join(dir, 'state.md');
    await writeFile(file, 'initial');
    const replace = async (content: string) => {
      // Keep this ordering test independent of writeFile's observable truncate window.
      await writeFile(`${file}.next`, content);
      await rename(`${file}.next`, file);
    };
    const values: string[] = [];
    let wake: (() => void) | undefined;
    const handle = watchFile(file, (value) => {
      values.push(value);
      wake?.();
    });
    let release!: () => void;
    const hold = (content: string) => {
      let captured!: () => void;
      const seen = new Promise<void>((resolve) => {
        captured = resolve;
      });
      const wait = new Promise<void>((resolve) => {
        release = resolve;
      });
      heldRead = { file, content, captured, wait };
      return seen;
    };
    try {
      const oldCaptured = hold('old');
      await replace('old');
      await oldCaptured;
      const latest = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error('The latest file value was not delivered')),
          3000,
        );
        wake = () => {
          if (values.includes('new')) {
            clearTimeout(timer);
            resolve();
          }
        };
      });
      await replace('new');
      await latest;
      release();
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(values, ['new']);
      const capturedBeforeStop = hold('stopped');
      await replace('stopped');
      await capturedBeforeStop;
      handle.stop();
      release();
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(values, ['new']);
    } finally {
      release?.();
      heldRead = undefined;
      handle.stop();
      await rm(dir, { recursive: true, force: true });
    }
  },
);

test('observation watches refuse a missing parent instead of admitting an inactive source', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'farmslot-fs-missing-parent-'));
  try {
    assert.throws(
      () =>
        watchFile(path.join(dir, 'missing', 'state.md'), () => {}, {
          onUnavailable: () => assert.fail('inactive watch must be refused before admission'),
        }),
      { code: 'ENOENT' },
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
