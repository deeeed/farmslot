import assert from 'node:assert/strict';
import fs, { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';

import { DEFAULT_RUN_BUNDLE_RETENTION, runBundleRetentionSettings } from './retained.js';

function fixture(t: TestContext) {
  const home = mkdtempSync(path.join(tmpdir(), 'bundle-settings-'));
  const file = path.join(home, 'run-bundle-retention.json');
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return { home, file };
}

function observeReads(t: TestContext, file: string) {
  const original = fs.readFileSync;
  let reads = 0;
  t.mock.method(fs, 'readFileSync', (...args: Parameters<typeof original>) => {
    if (String(args[0]) === file) reads++;
    return original(...args);
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  return () => reads;
}

function settleClock(t: TestContext) {
  const now = Date.now() + 10_000;
  t.mock.method(Date, 'now', () => now);
}

test('unchanged settled retention settings are read once and policies remain caller-owned', (t) => {
  const { home, file } = fixture(t);
  writeFileSync(file, JSON.stringify({ runBundleRetention: { maxStoreBytes: 123 } }));
  const reads = observeReads(t, file);
  settleClock(t);
  const first = runBundleRetentionSettings(home);
  first.policy.maxStoreBytes = 999;
  for (let i = 0; i < 20; i++) {
    assert.equal(runBundleRetentionSettings(home).policy.maxStoreBytes, 123);
  }
  assert.equal(reads(), 1, 'unchanged settings must not be read and parsed for every store open');
});

test('retention settings see edits, atomic replacement, removal and recreation immediately', (t) => {
  const { home, file } = fixture(t);
  settleClock(t);
  assert.deepEqual(runBundleRetentionSettings(home), { policy: DEFAULT_RUN_BUNDLE_RETENTION });
  writeFileSync(file, JSON.stringify({ runBundleRetention: { maxStoreBytes: 100 } }));
  assert.equal(runBundleRetentionSettings(home).policy.maxStoreBytes, 100);
  writeFileSync(file, JSON.stringify({ runBundleRetention: { maxStoreBytes: 2000 } }));
  assert.equal(runBundleRetentionSettings(home).policy.maxStoreBytes, 2000);
  writeFileSync(`${file}.next`, JSON.stringify({ runBundleRetention: { maxStoreBytes: 3000 } }));
  renameSync(`${file}.next`, file);
  assert.equal(runBundleRetentionSettings(home).policy.maxStoreBytes, 3000);
  rmSync(file);
  assert.deepEqual(runBundleRetentionSettings(home), { policy: DEFAULT_RUN_BUNDLE_RETENTION });
  writeFileSync(file, JSON.stringify({ runBundleRetention: { maxStoreBytes: 4000 } }));
  assert.equal(runBundleRetentionSettings(home).policy.maxStoreBytes, 4000);
});

test('recent stamps are re-read until a settled read can be trusted', (t) => {
  const { home, file } = fixture(t);
  writeFileSync(file, JSON.stringify({ runBundleRetention: { maxStoreBytes: 123 } }));
  const reads = observeReads(t, file);
  const changedAt = fs.statSync(file).ctimeMs;
  t.mock.method(Date, 'now', () => changedAt);
  runBundleRetentionSettings(home);
  runBundleRetentionSettings(home);
  assert.equal(reads(), 2);
  t.mock.method(Date, 'now', () => changedAt + 10_000);
  runBundleRetentionSettings(home);
  runBundleRetentionSettings(home);
  assert.equal(reads(), 3, 'the first settled read, rather than a previously racy read, is cached');
});

test('invalid and unreadable settings never fall back to a previously cached policy', (t) => {
  const { home, file } = fixture(t);
  settleClock(t);
  writeFileSync(file, JSON.stringify({ runBundleRetention: { maxStoreBytes: 123 } }));
  assert.equal(runBundleRetentionSettings(home).policy.maxStoreBytes, 123);
  writeFileSync(file, '{');
  assert.throws(() => runBundleRetentionSettings(home), SyntaxError);
  writeFileSync(file, JSON.stringify({ runBundleRetention: [] }));
  assert.throws(() => runBundleRetentionSettings(home), /Invalid runBundleRetention settings/);
  writeFileSync(file, JSON.stringify({ runBundleRetention: { maxStoreBytes: 'wrong' } }));
  assert.throws(() => runBundleRetentionSettings(home), /Invalid runBundleRetention.maxStoreBytes/);
  writeFileSync(file, JSON.stringify({ runBundleRetention: { storeRoot: 'relative' } }));
  assert.throws(() => runBundleRetentionSettings(home), /must be absolute/);
  rmSync(file);
  mkdirSync(file);
  assert.throws(() => runBundleRetentionSettings(home), { code: 'EISDIR' });
  rmSync(file, { recursive: true });
  writeFileSync(file, JSON.stringify({ runBundleRetention: { maxStoreBytes: 456 } }));
  assert.equal(runBundleRetentionSettings(home).policy.maxStoreBytes, 456);
});

test('retention settings keep distinct homes and migrated layouts separate', (t) => {
  const first = fixture(t);
  const second = fixture(t);
  mkdirSync(path.join(second.home, 'config'));
  writeFileSync(path.join(second.home, 'config/instance.json'), JSON.stringify({ layout: 2 }));
  const secondFile = path.join(second.home, 'config/run-bundle-retention.json');
  writeFileSync(first.file, JSON.stringify({ runBundleRetention: { maxStoreBytes: 123 } }));
  writeFileSync(secondFile, JSON.stringify({ runBundleRetention: { maxStoreBytes: 456 } }));
  settleClock(t);
  for (let i = 0; i < 2; i++) {
    assert.equal(runBundleRetentionSettings(first.home).policy.maxStoreBytes, 123);
    assert.equal(runBundleRetentionSettings(second.home).policy.maxStoreBytes, 456);
  }
  mkdirSync(path.join(first.home, 'config'));
  writeFileSync(path.join(first.home, 'config/instance.json'), JSON.stringify({ layout: 2 }));
  writeFileSync(
    path.join(first.home, 'config/run-bundle-retention.json'),
    JSON.stringify({ runBundleRetention: { maxStoreBytes: 789 } }),
  );
  assert.equal(runBundleRetentionSettings(first.home).policy.maxStoreBytes, 789);
});
