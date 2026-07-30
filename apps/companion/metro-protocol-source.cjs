'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Path helpers for companion Metro's @farmslot/protocol .js → .ts rewrite.
 * Anchored to the protocol package root (via metro.config.js __dirname), not process.cwd(),
 * so resolution behaves the same when launched from companion, monorepo root, or a worktree.
 */

function tryRealpath(filePath) {
  try {
    return fs.realpathSync.native(filePath);
  } catch {
    return path.normalize(filePath);
  }
}

/** True when `child` is `parent` or a descendant of `parent` (after realpath). */
function isPathInside(parent, child) {
  const parentReal = tryRealpath(parent);
  const childReal = tryRealpath(child);
  const rel = path.relative(parentReal, childReal);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

/**
 * Resolve an origin module path that Metro may hand us as absolute, relative to
 * project root, monorepo root, or cwd.
 */
function resolveOriginPath(modulePath, bases) {
  if (!modulePath) return null;
  if (path.isAbsolute(modulePath)) return tryRealpath(modulePath);

  for (const base of bases) {
    if (!base) continue;
    const candidate = path.resolve(base, modulePath);
    try {
      if (fs.existsSync(candidate)) return tryRealpath(candidate);
    } catch {
      // existsSync can throw on some exotic paths; try next base
    }
  }
  // Last resort: resolve against the first base (usually projectRoot)
  const fallbackBase = bases.find(Boolean);
  return fallbackBase
    ? tryRealpath(path.resolve(fallbackBase, modulePath))
    : tryRealpath(modulePath);
}

/**
 * Protocol package *source* only — not nested deps under protocol/node_modules
 * (e.g. @noble/hashes), which must keep their real .js relative imports.
 *
 * @param {string | null | undefined} modulePath
 * @param {string} protocolRoot absolute path to packages/protocol
 * @param {string[]} [resolveBases] bases for relative origin paths
 */
function isProtocolSourceModule(modulePath, protocolRoot, resolveBases = [protocolRoot]) {
  const resolved = resolveOriginPath(modulePath, resolveBases);
  if (!resolved) return false;

  const protocolReal = tryRealpath(protocolRoot);
  if (!isPathInside(protocolReal, resolved)) return false;

  // Nested third-party installs under the protocol package
  if (isPathInside(path.join(protocolReal, 'node_modules'), resolved)) return false;

  return true;
}

module.exports = {
  tryRealpath,
  isPathInside,
  resolveOriginPath,
  isProtocolSourceModule,
};
