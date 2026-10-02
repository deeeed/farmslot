// Faults run only in marked disposable gateways, never in the operator process.
import assert from 'node:assert/strict';
import { existsSync, writeFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import path from 'node:path';

const root = process.env.FARMSLOT_COHERENCE_FIXTURE;
assert.ok(root && existsSync(path.join(root, '.coherence-fixture')));
const fixtures = JSON.parse(process.env.FARMSLOT_COHERENCE_FAULTS);
const ids = Object.fromEntries(fixtures.map((fixture) => [fixture.fault, fixture.runId]));
const slots = Object.fromEntries(fixtures.map((fixture) => [fixture.fault, fixture.slotId]));
globalThis.__coherenceGenerationFault = (run) => {
  if (run?.id !== process.env.FARMSLOT_COHERENCE_GENERATION_RUN_ID) return;
  run.engineState = { ...run.engineState, generation: 'coherence-changed-generation' };
  writeFileSync(path.join(root, 'generation-fault-applied'), run.id);
};
const faults = [
  [
    'methods/runtime-capabilities.ts',
    /(async function captureProviderProcesses[\s\S]*?\{)/,
    `$1 if(slotId===${JSON.stringify(slots['capture-provider'])}) throw new Error('Fixture identity capture failed');`,
  ],
  [
    'runners/owned-stop.ts',
    /const currentRun = getRun\(run.id\);/,
    '$& globalThis.__coherenceGenerationFault(currentRun);',
  ],
  [
    'runners/session-archive.ts',
    /(async function archiveRunnerSessionsForSlotRelease\([^)]*\)\s*(?::[^\{]+)?\{)/,
    `$1 if(params.runId===${JSON.stringify(ids['early-cancel'])}) throw new Error('Fixture archive failed');`,
  ],
  [
    'methods/terminal-attachment.ts',
    /(async function terminalAttachmentCleanupForRun[\s\S]*?\{)/,
    `$1 if(${JSON.stringify([ids['cancel-ancillary'], ids['complete-ancillary'], ids.notify])}.includes(run.id)) throw new Error('Fixture ancillary cleanup failed');`,
  ],
  [
    'server.ts',
    /(function broadcastEvent\([^)]*\)\s*(?::[^\{]+)?\{)/,
    `$1 if(payload?.run?.id===${JSON.stringify(ids.notify)} && payload.run.slotTeardownSkipped==='Fixture ancillary cleanup failed') throw new Error('Fixture notification failed');`,
  ],
  [
    'methods/runtime-capabilities.ts',
    /const current = await probeResourceProcess\(vars, pid\);/,
    `if(slotId===${JSON.stringify(slots['stale-provider'])}) meta.process.identity='stale fixture birth identity'; $&`,
  ],
  [
    'methods/runtime-capabilities.ts',
    /frames.push\(\{ ...current, resourceId \}\);/,
    `frames.push(slotId===${JSON.stringify(slots['provider-group'])} ? {...current,resourceId,group:current.group+1000000} : {...current,resourceId});`,
  ],
];
registerHooks({
  load(url, context, nextLoad) {
    const loaded = nextLoad(url, context);
    let source = String(loaded.source);
    for (const [file, pattern, replacement] of faults) {
      if (!url.endsWith(`/services/gateway/src/${file}`)) continue;
      const changed = source.replace(pattern, replacement);
      assert.ok(changed !== source, `Fault must apply to ${file}`);
      source = changed;
    }
    return source === String(loaded.source) ? loaded : { ...loaded, source };
  },
});
