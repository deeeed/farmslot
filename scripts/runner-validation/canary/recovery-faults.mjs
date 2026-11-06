// Only the disposable gateway loads these faults. Production watchdogs own rejection.
import assert from 'node:assert/strict';
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { transformSync } from 'esbuild';

import { requireRecoveryFaultSupport } from './recovery-prerequisites.mjs';

requireRecoveryFaultSupport();
const { registerHooks } = await import('node:module');
const root = process.env.FARMSLOT_ROOT;
assert.ok(root && existsSync(path.join(root, 'holds', 'recovery-fixture')));
const { compilerOptions } = JSON.parse(
  readFileSync(new URL('../../../apps/command-center/tsconfig.base.json', import.meta.url), 'utf8'),
);
const arm = path.join(root, 'holds', 'node-timeout');
globalThis.__recoveryDropRequest = (method, params) => {
  if (!existsSync(arm) || method !== 'exec') return false;
  const request = JSON.stringify(params);
  if (!request.includes('recovery-node-timeout-1') || !request.includes('rev-parse HEAD'))
    return false;
  unlinkSync(arm);
  writeFileSync(arm + '.request.json', JSON.stringify({ method, params }));
  return true;
};
globalThis.__recoveryTimeout = (error) => {
  if (existsSync(arm + '.request.json'))
    writeFileSync(
      arm + '.timeout.json',
      JSON.stringify({ name: error.name, message: error.message }),
    );
  return error;
};

function patched(source, url) {
  return {
    format: 'module',
    source: transformSync(source, {
      format: 'esm',
      loader: 'ts',
      tsconfigRaw: { compilerOptions },
      sourcefile: fileURLToPath(url),
      target: `node${process.versions.node}`,
      keepNames: true,
      minifyWhitespace: true,
      sourcemap: 'inline',
    }).code,
    shortCircuit: true,
  };
}

function replaceCheckpoint(source, checkpoint, replacement, message) {
  assert.ok(source.includes(checkpoint), message);
  return source.replace(checkpoint, replacement);
}
registerHooks({
  load(url, context, next) {
    const reviewer = url.endsWith('/services/gateway/src/review/native-review-agent.ts');
    if (!reviewer && !url.endsWith('/services/gateway/src/fleet/node-rpc.ts'))
      return next(url, context);
    // next() can return tsx output on Node 22. Read and compile only these targets.
    const before = readFileSync(new URL(url), 'utf8');
    if (reviewer) {
      const checkpoint =
        'const inactivityTimeoutMs = (configuredInactivityMinutes ?? 10) * 60_000;';
      return patched(
        replaceCheckpoint(
          before,
          checkpoint,
          "const inactivityTimeoutMs = run.project === 'recovery-silent-reviewer' && !run.recoveryAttempts?.some((attempt) => attempt.stepName === 'review') ? 500 : (configuredInactivityMinutes ?? 10) * 60_000;",
          'Reviewer watchdog checkpoint must apply',
        ),
        url,
      );
    }
    let source = replaceCheckpoint(
      before,
      'const effectiveTimeout = opts?.timeout ?? DEFAULT_STREAMING_TIMEOUT_MS;',
      'const recoveryDrop = globalThis.__recoveryDropRequest(method, params); const effectiveTimeout = recoveryDrop ? 20 : opts?.timeout ?? DEFAULT_STREAMING_TIMEOUT_MS;',
      'Transport timeout checkpoint must apply',
    );
    source = replaceCheckpoint(
      source,
      'new NodeRpcTimeoutError(node.machine, effectiveTimeout, suffix)',
      'globalThis.__recoveryTimeout(new NodeRpcTimeoutError(node.machine, effectiveTimeout, suffix))',
      'Transport error checkpoint must apply',
    );
    source = replaceCheckpoint(
      source,
      "node.ws.send(JSON.stringify({ type: 'req', id, method, params }), (error) => {",
      "if (recoveryDrop) return; node.ws.send(JSON.stringify({ type: 'req', id, method, params }), (error) => {",
      'Transport send checkpoint must apply',
    );
    return patched(source, url);
  },
});
