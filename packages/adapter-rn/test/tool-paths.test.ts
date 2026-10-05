import assert from 'node:assert/strict';
import { realpathSync } from 'node:fs';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it, mock } from 'node:test';

import { clearMobileToolPathCache, resolveMobileToolPath } from '../src/tool-paths.js';

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  mock.restoreAll();
  clearMobileToolPathCache();
  while (cleanups.length > 0) await cleanups.pop()!();
});

async function fakeExecutable(dir: string, name: string): Promise<string> {
  const p = path.join(dir, name);
  await writeFile(p, '#!/bin/sh\necho fake\n');
  await chmod(p, 0o755);
  return p;
}

async function tempBinDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'tool-paths-'));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

describe('tool-paths', () => {
  it('RECIPE_RN_ADB_PATH override is honoured and exported back to process.env after resolution', async () => {
    const dir = await tempBinDir();
    const fakeAdb = await fakeExecutable(dir, 'adb');

    const original = process.env.RECIPE_RN_ADB_PATH;
    process.env.RECIPE_RN_ADB_PATH = fakeAdb;
    cleanups.push(() => {
      if (original === undefined) {
        delete process.env.RECIPE_RN_ADB_PATH;
      } else {
        process.env.RECIPE_RN_ADB_PATH = original;
      }
    });

    const resolved = resolveMobileToolPath('adb');
    // realpathSync resolves macOS /var → /private/var symlinks; compare resolved forms.
    assert.equal(resolved, realpathSync(fakeAdb), 'should use the env-var override');
    assert.equal(
      process.env.RECIPE_RN_ADB_PATH,
      realpathSync(fakeAdb),
      'should export the resolved path back to process.env',
    );
  });

  it('a non-executable candidate is skipped', async () => {
    const dir = await tempBinDir();
    // Write a file that exists but is NOT executable.
    const nonExec = path.join(dir, 'adb');
    await writeFile(nonExec, '#!/bin/sh\necho non-exec\n');
    // chmod 0o644 → readable, not executable.
    await chmod(nonExec, 0o644);

    const original = process.env.RECIPE_RN_ADB_PATH;
    process.env.RECIPE_RN_ADB_PATH = nonExec;
    cleanups.push(() => {
      if (original === undefined) {
        delete process.env.RECIPE_RN_ADB_PATH;
      } else {
        process.env.RECIPE_RN_ADB_PATH = original;
      }
    });

    // The non-executable override is rejected; resolveMobileToolPath continues
    // to PATH and hardcoded fallbacks. The key invariant is that nonExec itself
    // is never returned.
    const resolved = resolveMobileToolPath('adb');
    assert.notEqual(resolved, nonExec, 'non-executable candidate should be skipped');
    assert.notEqual(
      resolved,
      realpathSync(nonExec),
      'non-executable candidate should not be returned even after realpath',
    );
  });

  it('required: true with nothing found throws the recovery text', async () => {
    const originalPath = process.env.PATH;
    const originalAndroid = process.env.ANDROID_HOME;
    const originalAndroidSdk = process.env.ANDROID_SDK_ROOT;
    const originalAdbEnv = process.env.RECIPE_RN_ADB_PATH;

    process.env.PATH = '';
    delete process.env.ANDROID_HOME;
    delete process.env.ANDROID_SDK_ROOT;
    delete process.env.RECIPE_RN_ADB_PATH;

    cleanups.push(() => {
      process.env.PATH = originalPath;
      if (originalAndroid !== undefined) process.env.ANDROID_HOME = originalAndroid;
      if (originalAndroidSdk !== undefined) process.env.ANDROID_SDK_ROOT = originalAndroidSdk;
      if (originalAdbEnv !== undefined) process.env.RECIPE_RN_ADB_PATH = originalAdbEnv;
    });

    // Redirect os.homedir() so the hardcoded ~/Library/Android/sdk fallback
    // points at a non-existent directory instead of the real SDK.
    const emptyHome = await mkdtemp(path.join(os.tmpdir(), 'tool-paths-home-'));
    cleanups.push(() => rm(emptyHome, { recursive: true, force: true }));
    mock.method(os, 'homedir', () => emptyHome);

    assert.throws(
      () => resolveMobileToolPath('adb', { required: true }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.ok(
          error.message.includes('brew install android-platform-tools'),
          `error message should contain recovery text, got: ${error.message}`,
        );
        return true;
      },
    );
  });
});
