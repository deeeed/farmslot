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
  captureHelperPathInfo,
  resolveNativeCaptureHelperPath,
} from '../../src/node/capture-helper-path.js';

function makeExecutable(path: string, contents = '#!/usr/bin/env bash\n'): void {
  writeFileSync(path, contents);
  chmodSync(path, 0o755);
}

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
      assert.deepEqual(captureHelperPathInfo(), {
        path: expected,
        source: 'env:CAPTURE_HELPER_PATH',
      });
    },
  );
});

test('reports env:SITEED_CAPTURE_HELPER_BIN as the source', () => {
  const dir = mkdtempSync(join(tmpdir(), 'farmslot-capture-helper-'));
  const native = join(dir, 'capture-helper');
  makeExecutable(native);
  withEnv(
    { CAPTURE_HELPER_PATH: undefined, SITEED_CAPTURE_HELPER_BIN: native, PATH: '', HOME: '' },
    () => {
      assert.deepEqual(captureHelperPathInfo(), {
        path: native,
        source: 'env:SITEED_CAPTURE_HELPER_BIN',
      });
    },
  );
});

test('reports npm-global (HOME/.npm-global) as the source', () => {
  const dir = mkdtempSync(join(tmpdir(), 'farmslot-capture-helper-'));
  const nativeDir = join(dir, '.npm-global/lib/node_modules/@siteed/capture-helper/native');
  mkdirSync(nativeDir, { recursive: true });
  const native = join(nativeDir, 'capture-helper');
  makeExecutable(native);
  withEnv(
    { CAPTURE_HELPER_PATH: undefined, SITEED_CAPTURE_HELPER_BIN: undefined, PATH: '', HOME: dir },
    () => {
      assert.deepEqual(captureHelperPathInfo(), { path: native, source: 'npm-global' });
    },
  );
});

test('reports npm-root (npm root -g) as the source', () => {
  const dir = mkdtempSync(join(tmpdir(), 'farmslot-capture-helper-'));
  const npmBin = join(dir, 'bin');
  const globalRoot = join(dir, 'node_modules');
  const nativeDir = join(globalRoot, '@siteed/capture-helper/native');
  mkdirSync(npmBin, { recursive: true });
  mkdirSync(nativeDir, { recursive: true });
  const native = join(nativeDir, 'capture-helper');
  makeExecutable(native);
  // Fake `npm` that prints the global root regardless of args (npm root -g).
  // Absolute shebang: the test PATH holds only npmBin, so `env bash` would not resolve.
  makeExecutable(join(npmBin, 'npm'), `#!/bin/sh\necho '${globalRoot}'\n`);
  withEnv(
    {
      CAPTURE_HELPER_PATH: undefined,
      SITEED_CAPTURE_HELPER_BIN: undefined,
      PATH: npmBin,
      HOME: '',
    },
    () => {
      assert.deepEqual(captureHelperPathInfo(), { path: native, source: 'npm-root' });
    },
  );
});

test('reports PATH as the source for a bare capture-helper on PATH', () => {
  const dir = mkdtempSync(join(tmpdir(), 'farmslot-capture-helper-'));
  const native = join(dir, 'capture-helper');
  makeExecutable(native);
  withEnv(
    { CAPTURE_HELPER_PATH: undefined, SITEED_CAPTURE_HELPER_BIN: undefined, PATH: dir, HOME: '' },
    () => {
      assert.deepEqual(captureHelperPathInfo(), { path: native, source: 'PATH' });
    },
  );
});

test('falls back to capture-helper command when no native package binary exists', () => {
  withEnv(
    { CAPTURE_HELPER_PATH: undefined, SITEED_CAPTURE_HELPER_BIN: undefined, PATH: '', HOME: '' },
    () => {
      assert.equal(resolveNativeCaptureHelperPath(), null);
      assert.equal(captureHelperPath(), 'capture-helper');
      assert.deepEqual(captureHelperPathInfo(), { path: 'capture-helper', source: 'fallback' });
    },
  );
});
