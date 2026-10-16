import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  inputSourceSnapshot,
  withRetainedSourceProvenance,
} from '../src/harness/execution-provenance.js';

test('verified task pins fingerprint file aliases and retain the ordinary-source refusal', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'retained-source-links-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const library = path.join(root, 'library');
  fs.mkdirSync(library);
  const target = path.join(library, 'action.ts');
  fs.writeFileSync(target, 'export const value: number = 1;\n');
  fs.symlinkSync('action.ts', path.join(library, 'action.mjs'));
  assert.throws(() => inputSourceSnapshot(library), /must not be a symbolic link/);
  await withRetainedSourceProvenance(root, async () => {
    const before = inputSourceSnapshot(library).sourceFingerprint;
    assert.equal(inputSourceSnapshot(library).sourceFingerprint, before);
    fs.writeFileSync(target, 'export const value: number = 2;\n');
    assert.notEqual(inputSourceSnapshot(library).sourceFingerprint, before);
  });
  assert.throws(() => inputSourceSnapshot(library), /must not be a symbolic link/);
});

test('verified task provenance still refuses a link outside its pin', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'retained-source-escape-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const pin = path.join(root, 'pin');
  fs.mkdirSync(pin);
  fs.writeFileSync(path.join(root, 'outside.ts'), 'export default 1;\n');
  fs.symlinkSync('../outside.ts', path.join(pin, 'action.mjs'));
  await withRetainedSourceProvenance(pin, async () => {
    assert.throws(() => inputSourceSnapshot(pin), /must not be a symbolic link/);
  });
});
