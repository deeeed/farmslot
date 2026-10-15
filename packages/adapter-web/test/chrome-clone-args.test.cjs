'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { disableMacCodeSignClone } = require('../src/chrome-args.cjs');

test('macOS clone suppression merges all disabled features into one switch', () => {
  const args = [
    '--disable-features=ExtensionContentVerification,DisableLoadExtensionCommandLineSwitch',
    '--user-data-dir=/tmp/profile',
    '--disable-features=AnotherFeature,ExtensionContentVerification',
    'about:blank',
  ];
  const original = [...args];
  const result = disableMacCodeSignClone(args, 'darwin');
  const switches = result.filter((arg) => arg.startsWith('--disable-features='));
  assert.equal(switches.length, 1);
  assert.deepEqual(switches[0].split('=')[1].split(','), [
    'MacAppCodeSignClone',
    'ExtensionContentVerification',
    'DisableLoadExtensionCommandLineSwitch',
    'AnotherFeature',
  ]);
  assert.deepEqual(result.slice(1), ['--user-data-dir=/tmp/profile', 'about:blank']);
  assert.deepEqual(args, original);
});

test('macOS launches disable clone creation even without other feature flags', () => {
  assert.deepEqual(disableMacCodeSignClone(['about:blank'], 'darwin'), [
    '--disable-features=MacAppCodeSignClone',
    'about:blank',
  ]);
});

test('other platforms retain their existing feature switches', () => {
  const args = ['--disable-features=ExistingFeature', 'about:blank'];
  assert.deepEqual(disableMacCodeSignClone(args, 'linux'), args);
});
