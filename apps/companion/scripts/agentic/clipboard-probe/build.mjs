#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const source = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(source, '../../..');
const output = process.argv[2];
assert(output && path.isAbsolute(output));
mkdirSync(output, { mode: 0o700 });
for (const name of ['classes', 'dex']) mkdirSync(path.join(output, name));
const sdk = process.env.ANDROID_HOME;
const java = process.env.JAVA_HOME;
assert(sdk && java);
const tools = path.join(sdk, 'build-tools/36.0.0');
const framework = path.join(sdk, 'platforms/android-34/android.jar');
const run = (binary, args, cwd = output) => execFileSync(binary, args, { cwd, stdio: 'inherit' });
run(path.join(java, 'bin/javac'), [
  '-source',
  '8',
  '-target',
  '8',
  '-bootclasspath',
  framework,
  '-d',
  path.join(output, 'classes'),
  path.join(source, 'ClipboardProbeActivity.java'),
]);
const classes = path.join(output, 'classes/net/siteed/farmslot/viewlinkprobe/development');
run(path.join(tools, 'd8'), [
  '--lib',
  framework,
  '--min-api',
  '24',
  '--output',
  path.join(output, 'dex'),
  ...readdirSync(classes)
    .filter((name) => name.endsWith('.class'))
    .map((name) => path.join(classes, name)),
]);
run(path.join(tools, 'aapt2'), [
  'link',
  '-o',
  path.join(output, 'unsigned.apk'),
  '--manifest',
  path.join(source, 'AndroidManifest.xml'),
  '-I',
  framework,
]);
run('/usr/bin/zip', [
  '-j',
  path.join(output, 'unsigned.apk'),
  path.join(output, 'dex/classes.dex'),
]);
run(path.join(tools, 'zipalign'), [
  '4',
  path.join(output, 'unsigned.apk'),
  path.join(output, 'aligned.apk'),
]);
run(path.join(tools, 'apksigner'), [
  'sign',
  '--ks',
  path.join(appRoot, 'android/app/debug.keystore'),
  '--ks-key-alias',
  'androiddebugkey',
  '--ks-pass',
  'pass:android',
  '--key-pass',
  'pass:android',
  '--out',
  path.join(output, 'clipboard-probe.apk'),
  path.join(output, 'aligned.apk'),
]);
run(path.join(tools, 'apksigner'), ['verify', path.join(output, 'clipboard-probe.apk')]);
const files = ['ClipboardProbeActivity.java', 'AndroidManifest.xml', 'build.mjs'].map((name) => ({
  path: path.join(source, name),
  sha256: createHash('sha256')
    .update(readFileSync(path.join(source, name)))
    .digest('hex'),
}));
const receipt = {
  files,
  apk: path.join(output, 'clipboard-probe.apk'),
  apkSha256: createHash('sha256')
    .update(readFileSync(path.join(output, 'clipboard-probe.apk')))
    .digest('hex'),
  clipboardAccess: 'read-only',
};
writeFileSync(path.join(output, 'build.json'), JSON.stringify(receipt, null, 2) + '\n', {
  flag: 'wx',
  mode: 0o600,
});
console.log(JSON.stringify(receipt));
