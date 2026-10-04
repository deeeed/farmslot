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

  it('checks .js files only where Node treats them as CommonJS', () => {
    const esm = fixturePackage(
      { type: 'module', exports: { '.': './index.js' } },
      { 'index.js': 'export const one = 1;\n' },
    );
    assert.deepEqual(checkCjsEsmExports(esm), []);
    const nested = fixturePackage(
      { type: 'module', exports: { './legacy': './legacy/index.js' } },
      {
        'legacy/package.json': '{"type":"commonjs"}\n',
        'legacy/index.js': 'const o = { two: 2 };\nmodule.exports = { two: o.two, one: 1 };\n',
      },
    );
    assert.deepEqual(checkCjsEsmExports(nested), [
      '@fixture/pkg: ./legacy hides 1 require() export(s) from ESM import: one',
    ]);
  });

  it('resolves subpaths like Node: arrays, condition sugar, condition order and main', () => {
    const hidden = 'const o = { two: 2 };\nmodule.exports = { two: o.two, one: 1 };\n';
    const array = fixturePackage({ exports: { './a': ['./a.cjs'] } }, { 'a.cjs': hidden });
    assert.deepEqual(checkCjsEsmExports(array), [
      '@fixture/pkg: ./a hides 1 require() export(s) from ESM import: one',
    ]);
    const sugar = fixturePackage({ exports: { default: './a.cjs' } }, { 'a.cjs': hidden });
    assert.deepEqual(checkCjsEsmExports(sugar), [
      '@fixture/pkg: . hides 1 require() export(s) from ESM import: one',
    ]);
    const requireOnly = fixturePackage({ exports: { require: './a.cjs' } }, { 'a.cjs': hidden });
    assert.deepEqual(checkCjsEsmExports(requireOnly), []);
    const ordered = fixturePackage(
      { exports: { '.': { default: './clean.cjs', require: './hidden.cjs' } } },
      {
        'clean.cjs': 'function one() {}\nfunction two() {}\nmodule.exports = { one, two };\n',
        'hidden.cjs': hidden,
      },
    );
    assert.deepEqual(checkCjsEsmExports(ordered), []);
    const main = fixturePackage({ main: './lib.cjs' }, { 'lib.cjs': hidden });
    assert.deepEqual(checkCjsEsmExports(main), [
      '@fixture/pkg: . hides 1 require() export(s) from ESM import: one',
    ]);
    const binOnly = fixturePackage(
      { bin: { tool: './bin.cjs' } },
      { 'bin.cjs': 'process.exit(3);\n' },
    );
    assert.deepEqual(checkCjsEsmExports(binOnly), []);
  });

  it('never touches an unbuilt ESM target, but still reports a missing CommonJS one', () => {
    const unbuilt = fixturePackage(
      {
        type: 'module',
        exports: {
          '.': {
            types: './dist/index.d.ts',
            import: './dist/index.js',
            default: './dist/index.js',
          },
          './cli': './dist/cli.mjs',
        },
      },
      {},
    );
    assert.deepEqual(checkCjsEsmExports(unbuilt), []);
    const missingCjs = fixturePackage({ exports: { './a': './dist/a.cjs' } }, {});
    assert.match(
      checkCjsEsmExports(missingCjs).join('\n'),
      /\.\/a does not resolve: Cannot find module/u,
    );
  });

  it('loads an extensionless or directory main the way Node resolves it', () => {
    const clean = fixturePackage(
      { main: './lib' },
      { 'lib/index.js': 'function one() {}\nmodule.exports = { one };\n' },
    );
    assert.deepEqual(checkCjsEsmExports(clean), []);
    const hidden = fixturePackage(
      { main: 'lib' },
      { 'lib.js': 'const o = { two: 2 };\nmodule.exports = { two: o.two, one: 1 };\n' },
    );
    assert.deepEqual(checkCjsEsmExports(hidden), [
      '@fixture/pkg: . hides 1 require() export(s) from ESM import: one',
    ]);
  });

  it('fails a dual package whose ESM side cannot load a dependency subpath', () => {
    const root = fixturePackage(
      { type: 'module', exports: { '.': { import: './index.js', require: './index.cjs' } } },
      {
        'index.js': "import '@fixture/dep/hidden';\nexport const one = 1;\n",
        'index.cjs': 'function one() {}\nmodule.exports = { one };\n',
        'node_modules/@fixture/dep/package.json':
          '{"name":"@fixture/dep","exports":{".":"./index.js"}}\n',
        'node_modules/@fixture/dep/index.js': 'module.exports = {};\n',
      },
    );
    assert.match(
      checkCjsEsmExports(root).join('\n'),
      /^@fixture\/pkg: \. does not load: Package subpath '\.\/hidden' is not defined by "exports"/u,
    );
  });

  it('compares a dual package by what each side loads', () => {
    const complete = fixturePackage(
      { type: 'module', exports: { '.': { import: './index.js', require: './index.cjs' } } },
      {
        'index.js': 'export const one = 1;\nexport const two = 2;\n',
        'index.cjs': 'const o = { two: 2 };\nmodule.exports = { two: o.two, one: 1 };\n',
      },
    );
    assert.deepEqual(checkCjsEsmExports(complete), []);
    const diverged = fixturePackage(
      { type: 'module', exports: { '.': { import: './index.js', require: './index.cjs' } } },
      {
        'index.js': 'export const one = 1;\n',
        'index.cjs': 'module.exports = { one: 1, two: 2 };\n',
      },
    );
    assert.deepEqual(checkCjsEsmExports(diverged), [
      '@fixture/pkg: . hides 1 require() export(s) from ESM import: two',
    ]);
  });

  it('reads the result past stdout noise and fails a run that exits non-zero after loading', () => {
    const noisy = fixturePackage(
      { exports: { './a': './a.cjs' } },
      { 'a.cjs': "console.log('hello');\nfunction one() {}\nmodule.exports = { one };\n" },
    );
    assert.deepEqual(checkCjsEsmExports(noisy), []);
    const late = fixturePackage(
      { exports: { './a': './a.cjs' } },
      {
        'a.cjs':
          "setTimeout(() => { throw new Error('late'); }, 50);\nfunction one() {}\nmodule.exports = { one };\n",
      },
    );
    assert.deepEqual(checkCjsEsmExports(late), ['@fixture/pkg: ./a does not load: late']);
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
    const problems = checkCjsEsmExports(root);
    assert.equal(problems.length, 3);
    assert.match(problems[0], /^@fixture\/pkg: \.\/gone does not resolve: Cannot find module /u);
    assert.deepEqual(problems.slice(1), [
      '@fixture/pkg: ./lib/* is a CommonJS wildcard export; list its subpaths so each can be checked',
      '@fixture/pkg: ./bad does not load: boom',
    ]);
  });
});
