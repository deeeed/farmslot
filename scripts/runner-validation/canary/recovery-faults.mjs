// Only the disposable gateway loads these faults. Production watchdogs own rejection.
import assert from 'node:assert/strict';
import { existsSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { requireRecoveryFaultSupport } from './recovery-prerequisites.mjs';

requireRecoveryFaultSupport();
const { registerHooks } = await import('node:module');
registerHooks({
  load(url, context, next) {
    const loaded = next(url, context);
    const reviewer = url.endsWith('/services/gateway/src/review/native-review-agent.ts');
    if (!reviewer && !url.endsWith('/services/gateway/src/fleet/node-rpc.ts')) return loaded;
    const root = process.env.FARMSLOT_ROOT;
    assert.ok(root && existsSync(path.join(root, 'holds', 'recovery-fixture')));
    if (reviewer) {
      const before = String(loaded.source);
      const checkpoint =
        'const inactivityTimeoutMs = (configuredInactivityMinutes ?? 10) * 60_000;';
      assert.ok(before.includes(checkpoint), 'Reviewer watchdog checkpoint must apply');
      return {
        ...loaded,
        source: before.replace(
          checkpoint,
          "const inactivityTimeoutMs = run.project === 'recovery-silent-reviewer' && !run.recoveryAttempts?.some((attempt) => attempt.stepName === 'review') ? 500 : (configuredInactivityMinutes ?? 10) * 60_000;",
        ),
      };
    }
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
    const before = String(loaded.source);
    let source = before.replace(
      'const effectiveTimeout = opts?.timeout ?? DEFAULT_STREAMING_TIMEOUT_MS;',
      'const recoveryDrop = globalThis.__recoveryDropRequest(method, params); const effectiveTimeout = recoveryDrop ? 20 : opts?.timeout ?? DEFAULT_STREAMING_TIMEOUT_MS;',
    );
    source = source.replace(
      'new NodeRpcTimeoutError(node.machine, effectiveTimeout, suffix)',
      'globalThis.__recoveryTimeout(new NodeRpcTimeoutError(node.machine, effectiveTimeout, suffix))',
    );
    source = source.replace(
      "node.ws.send(JSON.stringify({ type: 'req', id, method, params }), (error) => {",
      "if (recoveryDrop) return; node.ws.send(JSON.stringify({ type: 'req', id, method, params }), (error) => {",
    );
    assert.notEqual(source, before, 'Transport timeout checkpoint must apply');
    return { ...loaded, source };
  },
});
