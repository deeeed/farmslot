'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const {
  isPathInside,
  isProtocolSourceModule,
  resolveOriginPath,
  tryRealpath,
} = require('./metro-protocol-source.cjs');

const companionRoot = __dirname;
const monorepoRoot = path.resolve(companionRoot, '../..');
const protocolRoot = path.resolve(monorepoRoot, 'packages/protocol');
const bases = [companionRoot, monorepoRoot, protocolRoot, process.cwd()];

function assertTrue(value, message) {
  assert.strictEqual(value, true, message);
}

function assertFalse(value, message) {
  assert.strictEqual(value, false, message);
}

// --- isPathInside ---
assertTrue(isPathInside(protocolRoot, path.join(protocolRoot, 'src/recipe/digest.ts')));
assertFalse(isPathInside(protocolRoot, monorepoRoot));
assertFalse(isPathInside(path.join(protocolRoot, 'src'), path.join(protocolRoot, 'node_modules')));

// --- absolute protocol source ---
const digestAbs = path.join(protocolRoot, 'src/recipe/digest.ts');
assertTrue(
  isProtocolSourceModule(digestAbs, protocolRoot, bases),
  'absolute protocol source should match',
);

// --- nested dep must NOT match (the @noble/hashes failure mode) ---
const nobleUtils = path.join(protocolRoot, 'node_modules/@noble/hashes/esm/utils.js');
if (fs.existsSync(nobleUtils)) {
  assertFalse(
    isProtocolSourceModule(nobleUtils, protocolRoot, bases),
    'nested node_modules under protocol must not rewrite',
  );
} else {
  // Still exercise the path logic even if install layout differs
  assertFalse(
    isProtocolSourceModule(nobleUtils, protocolRoot, bases),
    'nested node_modules under protocol must not rewrite (missing file ok)',
  );
}

// --- workspace symlink path collapses via realpath ---
const workspaceLink = path.join(monorepoRoot, 'node_modules/@farmslot/protocol/src/index.ts');
if (fs.existsSync(workspaceLink)) {
  assertTrue(
    isProtocolSourceModule(workspaceLink, protocolRoot, bases),
    'workspace symlink into protocol source should match',
  );
}

// --- relative paths work from monorepo-style and package-style origins ---
assertTrue(
  isProtocolSourceModule('packages/protocol/src/recipe/digest.ts', protocolRoot, bases),
  'relative monorepo path should resolve',
);
assertTrue(
  isProtocolSourceModule('src/recipe/digest.ts', protocolRoot, [protocolRoot, ...bases]),
  'relative path from protocol package root should resolve',
);

// --- relative path must not match when only present under wrong base ---
assertFalse(
  isProtocolSourceModule('src/recipe/digest.ts', protocolRoot, [companionRoot]),
  'protocol-relative path must not resolve against companion root alone',
);

// --- unrelated package ---
assertFalse(
  isProtocolSourceModule(
    path.join(monorepoRoot, 'packages/theme/src/index.ts'),
    protocolRoot,
    bases,
  ),
  'other workspace packages are not protocol source',
);

// --- cwd-independent: resolveOriginPath with temp cwd still finds absolute ---
const prevCwd = process.cwd();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'metro-protocol-'));
try {
  process.chdir(tmp);
  assertTrue(
    isProtocolSourceModule(digestAbs, protocolRoot, [
      companionRoot,
      monorepoRoot,
      protocolRoot,
      process.cwd(),
    ]),
    'absolute origin still matches after chdir',
  );
  // Relative monorepo path still works via monorepoRoot base, not cwd
  assertTrue(
    isProtocolSourceModule('packages/protocol/src/recipe/digest.ts', protocolRoot, [
      companionRoot,
      monorepoRoot,
      protocolRoot,
      process.cwd(),
    ]),
    'relative monorepo path should not depend on process.cwd()',
  );
} finally {
  process.chdir(prevCwd);
  fs.rmSync(tmp, { recursive: true, force: true });
}

// --- resolveOriginPath prefers existing candidates ---
const resolved = resolveOriginPath('packages/protocol/src/recipe/digest.ts', bases);
assert.strictEqual(tryRealpath(resolved), tryRealpath(digestAbs));

console.log('ok - metro-protocol-source path detection is cwd-safe');
