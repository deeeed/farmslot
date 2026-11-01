'use strict';

/**
 * Node side of the injected React Native runtime (bridge-runtime/injected).
 *
 * - buildInjectedPayload: bundle a host entry (which imports injected/*.ts)
 *   into one Hermes-safe expression. The caller passes its esbuild instance so
 *   adapter-rn keeps no build dependency.
 * - ensureInjectedRuntime: version-stamped, idempotent install. One cheap probe
 *   evaluation per command; the payload is sent only when the stamp is missing
 *   (fresh JS runtime after a reload or restart) or stale.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { cdpEval } = require('./cdp-eval.cjs');
const { INJECTABLE_RUNTIME_EXPRESSION } = require('./target-discovery.cjs');

const INJECTED_DIR = path.join(__dirname, '..', 'injected');
const CORE_SOURCES = ['rn-runtime.ts', 'rn-hud.ts', 'rn-install.ts'].map((name) =>
  path.join(INJECTED_DIR, name),
);

/** Content hash of the generic runtime plus any host sources. */
function runtimeSourceDigest(extraFiles = []) {
  const hash = crypto.createHash('sha256');
  for (const file of [...CORE_SOURCES, ...extraFiles]) {
    hash.update(path.basename(file));
    hash.update(fs.readFileSync(file));
  }
  return hash.digest('hex').slice(0, 12);
}

/**
 * Bundle `entry` (an ESM module exporting `result`) into an expression whose
 * value is that `result`. Hermes evaluates it through Runtime.evaluate.
 */
function buildInjectedPayload({ esbuild, entry, define = {}, target = 'es2019' }) {
  const out = esbuild.buildSync({
    entryPoints: [entry],
    bundle: true,
    write: false,
    format: 'cjs',
    platform: 'neutral',
    target,
    legalComments: 'none',
    alias: { '@farmslot/adapter-rn/bridge-runtime/injected': INJECTED_DIR },
    define,
    logLevel: 'silent',
  });
  const code = out.outputFiles[0].text;
  return `(function(){var module={exports:{}};var exports=module.exports;\n${code}\nreturn module.exports.result;})()`;
}

function stampProbeExpression(globalName) {
  const name = JSON.stringify(globalName);
  return `(function(){var b=globalThis[${name}];var s=b&&b.__cdpRuntime&&b.__cdpRuntime.stamp;return s?{version:s.version,installedAt:s.installedAt,globalName:s.globalName}:null;})()`;
}

/** Read the install stamp without installing. */
async function probeInjectedRuntime(client, globalName) {
  return cdpEval(client, stampProbeExpression(globalName));
}

/**
 * Install when missing or stale. Returns { status, stamp, previous }, where
 * status is 'present' (nothing sent), 'installed' or 'replaced'.
 */
async function ensureInjectedRuntime(client, { globalName, version, payload }) {
  const previous = await probeInjectedRuntime(client, globalName);
  if (previous && previous.version === version) {
    return { status: 'present', stamp: previous, previous };
  }
  const source = typeof payload === 'function' ? payload() : payload;
  const result = await cdpEval(client, source);
  if (!result || result.status === 'failed' || !result.stamp) {
    throw new Error(
      `Injected runtime install failed: ${result && result.error ? result.error : JSON.stringify(result)}`,
    );
  }
  return { status: result.status, stamp: result.stamp, previous };
}

module.exports = {
  INJECTED_DIR,
  INJECTABLE_RUNTIME_EXPRESSION,
  buildInjectedPayload,
  ensureInjectedRuntime,
  probeInjectedRuntime,
  runtimeSourceDigest,
  stampProbeExpression,
};
