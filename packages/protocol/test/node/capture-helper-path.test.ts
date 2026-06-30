import assert from 'node:assert/strict';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  captureHelperPath,
  resolveNativeCaptureHelperPath,
} from '../../src/node/capture-helper-path.js';

function withEnv(env: Record<string, string | undefined>, fn: () => void): void {
  const previous = new Map<string, string | undefined>();
  for (const key of Object.keys(env)) {
    previous.set(key, process.env[key]);
    if (env[key] === undefined) delete process.env[key];
    else process.env[key] = env[key];
  }
  try {
    fn();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('resolves native helper when env points at an npm wrapper shim', () => {
  const dir = mkdtempSync(join(tmpdir(), 'farmslot-capture-helper-'));
  const packageRoot = join(dir, 'lib/node_modules/@siteed/capture-helper');
  const binDir = join(packageRoot, 'bin');
  const nativeDir = join(packageRoot, 'native');
  const globalBin = join(dir, 'bin');
  mkdirSync(binDir, { recursive: true });
  mkdirSync(nativeDir, { recursive: true });
  mkdirSync(globalBin, { recursive: true });
  const jsShim = join(binDir, 'capture-helper.js');
  const native = join(nativeDir, 'capture-helper');
  const shim = join(globalBin, 'capture-helper');
  writeFileSync(jsShim, '#!/usr/bin/env node\n');
  writeFileSync(native, '#!/usr/bin/env bash\n');
  chmodSync(jsShim, 0o755);
  chmodSync(native, 0o755);
  symlinkSync(jsShim, shim);

  withEnv(
    { CAPTURE_HELPER_PATH: shim, SITEED_CAPTURE_HELPER_BIN: undefined, PATH: '', HOME: dir },
    () => {
      const expected = realpathSync(native);
      assert.equal(resolveNativeCaptureHelperPath(), expected);
      assert.equal(captureHelperPath(), expected);
    },
  );
});

test('falls back to capture-helper command when no native package binary exists', () => {
  withEnv(
    { CAPTURE_HELPER_PATH: undefined, SITEED_CAPTURE_HELPER_BIN: undefined, PATH: '', HOME: '' },
    () => {
      assert.equal(resolveNativeCaptureHelperPath(), null);
      assert.equal(captureHelperPath(), 'capture-helper');
    },
  );
});
