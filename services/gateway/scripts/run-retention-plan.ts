// Read-only dry run of the engine's run retention pass (ADR-039 Amendment 2): what the
// next pass would remove now, per store. It reads run records directly and changes nothing.
// Run it with the gateway's FARMSLOT_ROOT and FARMSLOT_HOME so it reads the same stores.
import path from 'node:path';

import type { Run } from '@farmslot/protocol';
import { loadAllRunRecords } from '@farmslot/run-bundle';

import '../src/projects/read-only-status-process.js';

import {
  gatewayRetentionRoots,
  retentionContext,
  runHoldsSlot,
} from '../src/methods/run/retention.js';
import { planRunRetention } from '../src/runs/retention.js';

const extra = process.argv.slice(2).filter((arg) => arg !== '--paths');
if (extra.length)
  throw new Error('Usage: tsx services/gateway/scripts/run-retention-plan.ts [--paths]');

const roots = await gatewayRetentionRoots();
const byId = new Map<string, Run>();
for (const run of loadAllRunRecords(path.join(roots.runsDir, 'archive'))) byId.set(run.id, run);
for (const run of loadAllRunRecords(roots.runsDir)) byId.set(run.id, run);
const runs = [...byId.values()];
const { plan } = await planRunRetention(runs, await retentionContext(runs), roots, runHoldsSlot);

console.log(`Runs removable: ${plan.runs.length} of ${byId.size}`);
let total = 0;
for (const [store, { entries, bytes }] of Object.entries(plan.stores)) {
  total += bytes;
  console.log(
    `  ${store.padEnd(18)} ${String(entries).padStart(5)}  ${(bytes / 1e9).toFixed(2)} GB`,
  );
}
console.log(`  ${'total'.padEnd(18)} ${''.padStart(5)}  ${(total / 1e9).toFixed(2)} GB`);
console.log('Kept:');
for (const [reason, count] of Object.entries(plan.held).sort((a, b) => b[1] - a[1]))
  console.log(`  ${String(count).padStart(5)}  ${reason}`);
if (process.argv.includes('--paths')) console.log(JSON.stringify(plan.paths, null, 2));
