import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import { checkCjsEsmExports } from './check-cjs-esm-exports.mjs';

const roots = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

// A throwaway package: `files` maps relative paths to contents.
function fixturePackage(pkg, files) {
  const root = mkdtempSync(path.join(tmpdir(), 'cjs-esm-exports-'));
  roots.push(root);
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: '@fixture/pkg', ...pkg }));
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), content);
  }
  return root;
}

describe('checkCjsEsmExports', () => {
  it('passes shorthand export literals and a literal re-export', () => {
    const root = fixturePackage(
      { exports: { './a': './a.cjs', './b': './b.cjs' } },
      {
        'a.cjs': 'function one() {}\nfunction two() {}\nmodule.exports = { one, two };\n',
        'b.cjs': "module.exports = require('./a.cjs');\n",
      },
    );
    assert.deepEqual(checkCjsEsmExports(root), []);
  });

  it('reports the names a member expression in the export literal hides from ESM', () => {
    const root = fixturePackage(
      { exports: { './a': './a.cjs' } },
      {
        'a.cjs':
          'const other = { two() {} };\nfunction one() {}\nfunction three() {}\nmodule.exports = { one, two: other.two, three };\n',
      },
    );
    assert.deepEqual(checkCjsEsmExports(root), [
      '@fixture/pkg: ./a hides 1 require() export(s) from ESM import: three',
    ]);
  });

  it('reports a computed require re-export, which ESM sees as empty', () => {
    const root = fixturePackage(
      { exports: { './a': './a.cjs', './b': { default: './b.cjs' } } },
      {
        'a.cjs': 'function one() {}\nmodule.exports = { one };\n',
        'b.cjs': "const target = './a.cjs';\nmodule.exports = require(target);\n",
      },
    );
    assert.deepEqual(checkCjsEsmExports(root), [
      '@fixture/pkg: ./b hides 1 require() export(s) from ESM import: one',
    ]);
  });

  it('checks .js files only in CommonJS packages and follows the require condition', () => {
    const esm = fixturePackage(
      { type: 'module', exports: { '.': './index.js' } },
      { 'index.js': 'export const one = 1;\n' },
    );
    assert.deepEqual(checkCjsEsmExports(esm), []);
    const dual = fixturePackage(
      { type: 'module', exports: { '.': { import: './index.js', require: './index.cjs' } } },
      {
        'index.js': 'export const one = 1;\n',
        'index.cjs': 'const o = { one: 1 };\nmodule.exports = { a: o.one, one: 1 };\n',
      },
    );
    assert.deepEqual(checkCjsEsmExports(dual), [
      '@fixture/pkg: . hides 1 require() export(s) from ESM import: one',
    ]);
  });

  it('only resolves entry-only subpaths and fails a stale entry-only listing', () => {
    const root = fixturePackage(
      { exports: { './run': './run.cjs' } },
      { 'run.cjs': 'process.exit(2);\n' },
    );
    const entryOnlyExports = { '@fixture/pkg': ['./run', './gone'] };
    assert.deepEqual(checkCjsEsmExports(root, { entryOnlyExports }), [
      '@fixture/pkg: entry-only ./gone is not a CommonJS export any more',
    ]);
    assert.deepEqual(checkCjsEsmExports(root), ['@fixture/pkg: ./run does not load: exit 2']);
  });

  it('reports missing files, load failures and CommonJS wildcard exports', () => {
    const root = fixturePackage(
      { exports: { './gone': './gone.cjs', './bad': './bad.cjs', './lib/*': './lib/*.cjs' } },
      { 'bad.cjs': "throw new Error('boom');\n" },
    );
    assert.deepEqual(checkCjsEsmExports(root), [
      '@fixture/pkg: ./gone points at a missing file',
      '@fixture/pkg: ./lib/* is a CommonJS wildcard export; list its subpaths so each can be checked',
      '@fixture/pkg: ./bad does not load: boom',
    ]);
  });
});
