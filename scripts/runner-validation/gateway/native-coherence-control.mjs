// Loaded only by disposable proof children. No files or live modules are changed.
import assert from 'node:assert/strict';
import { existsSync, writeFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import path from 'node:path';

const name = process.env.FARMSLOT_COHERENCE_CONTROL;
const root = process.env.FARMSLOT_COHERENCE_FIXTURE;
assert.ok(
  root && existsSync(path.join(root, '.coherence-fixture')),
  'control requires a disposable fixture marker',
);
const controls = {
  'provider-expiry': [
    'services/gateway/src/runtime-capabilities/registry.ts',
    /\(blocksAcquisition\(lease\) \|\| runsProvider\(lease\)\)/,
    'blocksAcquisition(lease)',
  ],
  'provider-claims': [
    'services/gateway/src/runtime-capabilities/registry.ts',
    /return blocksAcquisition\(lease\) \|\| lease\.providerCleanupDeferred !== undefined/,
    'return blocksAcquisition(lease)',
  ],
  'provider-cleanup': [
    'services/gateway/src/runtime-capabilities/registry.ts',
    /lease\.slotId,\s*lease\.capabilityId,\s*lease\.provenance\.digest,\s*lease\.parameters/,
    'lease.id, lease.slotId, lease.capabilityId, lease.provenance.digest, lease.parameters',
  ],
  crash: [
    'packages/agent-runtime/src/native/process.ts',
    /stderrTail:\s*this\.stderr\.snapshot\(\)/,
    'stderrTail: []',
  ],
  attestation: [
    'packages/agent-runtime/src/native/manager.ts',
    /(confirmWorkerStopped\([^)]*\)\s*(?::[^\{]+)?\{)/,
    '$1 return this.snapshot(this.owned(owner,id));',
  ],
  resume: [
    'services/gateway/src/methods/run/lifecycle-control.ts',
    /if\s*\(recovery\.length\s*===\s*1\)/,
    'if (false)',
  ],
  adopt: [
    'services/gateway/src/methods/run/adopt.ts',
    /(const adopted\s*=\s*await observeAdoptableTmuxWorker\([^;]+;)/,
    '$1 throw new Error("External adoption is disabled by the control");',
  ],
  'teardown-cancel': [
    'services/gateway/src/run-lifecycle/slot-teardown.ts',
    /(async function recordSlotTeardownBlocker\([^)]*\)\s*(?::[^\{]+)?\{)/,
    '$1 return null;',
  ],
  'teardown-force': [
    'services/gateway/src/run-lifecycle/slot-teardown.ts',
    /(async function recordSlotTeardownBlocker\([^)]*\)\s*(?::[^\{]+)?\{)/,
    '$1 return null;',
  ],
  queue: [
    'packages/agent-runtime/src/native/manager.ts',
    /const queued(?:\s*:\s*StoredCommand)?\s*=\s*\{/,
    'throw new Error("Busy queue is disabled by the control"); const queued = {',
  ],
  'task-path-gateway': [
    'services/gateway/src/methods/run.ts',
    /params\.taskFile\s*!==\s*(?:void 0|undefined)\s*&&\s*!path\.isAbsolute\(params\.taskFile\)/,
    'false',
  ],
  'task-path-cli': [
    'packages/cli/src/commands/run.ts',
    /const taskFile\s*=\s*path\.resolve\(opts\.task\)/,
    'const taskFile = opts.task',
  ],
  runtime: [
    'services/gateway/src/run-engine/task-steps.ts',
    /await initializeExistingTaskRuntime\(current\)/,
    'void current',
  ],
  adapters: [
    'packages/recipe-harness/src/core/library.ts',
    /(async function libraryAdapters\([^)]*\)\s*(?::[^\{]+)?\{)/,
    '$1 return new Set(LEGACY_RECIPE_ADAPTERS);',
  ],
};
assert.ok(controls[name], `unknown coherence control ${name}`);
const [file, pattern, replacement] = controls[name];
registerHooks({
  load(url, context, nextLoad) {
    const loaded = nextLoad(url, context);
    if (!url.endsWith(`/${file}`)) return loaded;
    const source = String(loaded.source);
    const changed = source.replace(pattern, replacement);
    assert.ok(changed !== source, `control must change ${file}`);
    writeFileSync(process.env.FARMSLOT_COHERENCE_CONTROL_RECEIPT, name);
    return { ...loaded, source: changed };
  },
});
