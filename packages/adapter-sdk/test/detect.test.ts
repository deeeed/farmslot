import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { adapterDetectFromSpec } from '../src/index.js';

function checkout(t: test.TestContext, files: Record<string, string>, dirs: string[] = []): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'adapter-sdk-detect-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const dir of dirs) fs.mkdirSync(path.join(root, dir), { recursive: true });
  for (const [file, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), content);
  }
  return root;
}

test('remote matches when the origin URL contains any entry', () => {
  const detect = adapterDetectFromSpec({ remote: ['va-mmcx-terminal', 'terminal-fork'] });
  assert.equal(detect.remote?.('git@github.com:org/va-mmcx-terminal.git'), true);
  assert.equal(detect.remote?.('https://github.com/me/terminal-fork'), true);
  assert.equal(detect.remote?.('git@github.com:MetaMask/metamask-mobile.git'), false);
  assert.equal(detect.files, undefined);
});

test('files match when every path exists and package.json lists every dependency', (t) => {
  const detect = adapterDetectFromSpec({
    files: ['src/features/perpetuals/', 'yarn.lock'],
    packageDependencies: ['next', 'react'],
  });
  assert.equal(detect.remote, undefined);
  const pkg = JSON.stringify({ dependencies: { next: '15' }, devDependencies: { react: '19' } });
  const match = checkout(t, { 'package.json': pkg, 'yarn.lock': '' }, ['src/features/perpetuals']);
  assert.equal(detect.files?.(match), true);

  // A trailing slash requires a directory; a file of that name does not count.
  const notDir = checkout(t, {
    'package.json': pkg,
    'yarn.lock': '',
    'src/features/perpetuals': '',
  });
  assert.equal(detect.files?.(notDir), false);
  const missingFile = checkout(t, { 'package.json': pkg }, ['src/features/perpetuals']);
  assert.equal(detect.files?.(missingFile), false);
  const missingDep = checkout(
    t,
    { 'package.json': JSON.stringify({ dependencies: { next: '15' } }), 'yarn.lock': '' },
    ['src/features/perpetuals'],
  );
  assert.equal(detect.files?.(missingDep), false);
  const brokenPackage = checkout(t, { 'package.json': '{', 'yarn.lock': '' }, [
    'src/features/perpetuals',
  ]);
  assert.equal(detect.files?.(brokenPackage), false);
});

test('packageDependencies alone is a files predicate; an empty spec detects nothing', (t) => {
  const detect = adapterDetectFromSpec({ packageDependencies: ['next'] });
  const root = checkout(t, { 'package.json': JSON.stringify({ devDependencies: { next: '1' } }) });
  assert.equal(detect.files?.(root), true);
  assert.equal(detect.files?.(checkout(t, {})), false);
  assert.deepEqual(adapterDetectFromSpec({}), {});
  assert.deepEqual(adapterDetectFromSpec({ remote: [], files: [] }), {});
});
