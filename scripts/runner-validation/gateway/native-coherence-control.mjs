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
  'provider-compaction': [
    'services/gateway/src/runtime-capabilities/store.ts',
    /\|\|\s*Boolean\(lease.providerCleanupDeferred\)/,
    '',
  ],
  'provider-instance': [
    'services/gateway/src/runtime-capabilities/registry.ts',
    /if \(!holdsClaim\(lease\) && !selectedIds.has\(lease.id\)\) continue;/,
    'void lease;',
  ],
  'provider-capture': [
    'services/gateway/src/runtime-capabilities/registry.ts',
    /(catch \(error\) \{\s*)(const reason = `Provider identity capture failed:)/,
    '$1 throw error; $2',
  ],
  'kernel-reuse': [
    'packages/agent-runtime/src/native/manager.ts',
    /if \(leader && alive\(pid\) && !processIdentityAlive\(pid, leader.identity\) && alive\(pid\)\)\s*return false;/,
    'if (false) return false;',
  ],
  'authored-contract': [
    'services/gateway/src/tasks/existing-runtime.ts',
    /withTerminalReportPath\(configuredContract, authored.report, \[authored.learnings\]\)/,
    'configuredContract',
  ],
  'adapters-shadow': [
    'packages/recipe-harness/src/core/library.ts',
    /if \(!qualified.has\(alias\)\)/,
    'if (!recipes.has(ref) && !qualified.has(alias))',
  ],
  'queued-receipt': [
    'packages/agent-runtime/src/native/worker-history.ts',
    /submitted.has\(command.commandId\) \|\|\s*this.commandLeases.get\(command.commandId\) === leaseId/,
    'submitted.has(command.commandId) || (command.queued && this.commandLeases.get(command.commandId) === leaseId)',
  ],
  'held-reconcile': [
    [
      'services/gateway/src/run-engine/recovery.ts',
      /slot.lifecycle === 'held' && slot.phase === 'occupied'/,
      'false',
    ],
    [
      'services/gateway/src/core/state.ts',
      /!\(slot.lifecycle === 'held' && slot.phase === 'occupied'\)/,
      'true',
    ],
  ],
  'provider-owner': [
    'services/gateway/src/fleet/resource-manager.ts',
    /ownerRunId \?\? currentRunIdForSlot\(slotId\)/,
    'currentRunIdForSlot(slotId)',
  ],
  'provider-metadata': [
    'services/gateway/src/runtime-capabilities/registry.ts',
    /if \(acquired.providerProcesses\) lease.providerProcesses = acquired.providerProcesses;/,
    'void acquired;',
  ],
  'provider-retry': [
    'services/gateway/src/runtime-capabilities/registry.ts',
    /\(lease.state === 'released' \|\|\s*\(lease.state === 'error' && Boolean\(lease.cleanupFailure\)\)\)/,
    "lease.state === 'released'",
  ],
  'stop-generation': [
    'services/gateway/src/runners/owned-stop.ts',
    /currentRun\?\.engineState\?\.generation !== expectedGeneration/,
    'currentRun?.engineState?.generation !== run.engineState?.generation',
  ],
  'provider-preexisting': [
    'services/gateway/src/fleet/resource-manager.ts',
    /process &&\s*\(process.pid !== processBeforeBoot\?\.pid[\s\S]*?process.group !== processBeforeBoot\?\.group\)/,
    'process',
  ],
  'cancel-failure': [
    'services/gateway/src/run-lifecycle/cancel-transition.ts',
    /cleanup.set\(run.id, state\);/,
    'void state;',
  ],
  'cancel-ancillary': [
    'services/gateway/src/run-lifecycle/cancel-transition.ts',
    /await settleFailedRunSlotCleanup\(run, fence, error\);/,
    'void error;',
  ],
  'completion-failure': [
    'services/gateway/src/methods/run/lifecycle-control.ts',
    /await settleFailedRunSlotCleanup\(run, fence, error\)/,
    'String(error)',
  ],
  'failure-notification': [
    'services/gateway/src/run-lifecycle/slot-teardown.ts',
    /const updated = updateRun\(run.id, \{ slotTeardownSkipped: reason \}\);/,
    "$& const { broadcastEvent: earlyBroadcast } = await import('../server.js'); earlyBroadcast(Events.RUN_UPDATED, {run:updated});",
  ],
  'provider-birth': [
    'services/gateway/src/methods/runtime-capabilities.ts',
    /current\?\.identity !== meta.process.identity \|\| current.group !== meta.process.group/,
    'false',
  ],
  'provider-group': [
    'services/gateway/src/runtime-capabilities/registry.ts',
    /await this.options.checkProviderCleanup\?\.\([\s\S]*?\);/,
    'null;',
  ],
  'cleanup-gone': [
    'services/gateway/src/runners/owned-stop.ts',
    /if \(!session && !paneId && !panePid\) continue/,
    "if (!session && !paneId && !panePid) return 'Historical pane incorrectly blocks cleanup';",
  ],
  'cleanup-handoff': [
    'services/gateway/src/run-lifecycle/slot-teardown.ts',
    /row\?\.handoff_run_id && row\.handoff_run_id !== run\.id/,
    'false',
  ],
  'cleanup-pane': [
    'services/gateway/src/run-lifecycle/slot-teardown.ts',
    /return `Recorded worker pane process \$\{panePid\} is still occupied; cleanup deferred`/,
    'continue',
  ],
  'owned-provider': [
    'services/gateway/src/runtime-capabilities/registry.ts',
    /lease\.state = 'acquired';\s*lease\.acquiredAt/,
    "lease.providerProcesses = undefined; lease.state = 'acquired'; lease.acquiredAt",
  ],
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
const mutations = typeof controls[name][0] === 'string' ? [controls[name]] : controls[name];
registerHooks({
  load(url, context, nextLoad) {
    const loaded = nextLoad(url, context);
    let source = String(loaded.source);
    let applied = false;
    for (const [file, pattern, replacement] of mutations) {
      if (!url.endsWith(`/${file}`)) continue;
      const changed = source.replace(pattern, replacement);
      assert.ok(changed !== source, `control must change ${file}`);
      source = changed;
      applied = true;
    }
    if (!applied) return loaded;
    writeFileSync(process.env.FARMSLOT_COHERENCE_CONTROL_RECEIPT, name);
    return { ...loaded, source };
  },
});
