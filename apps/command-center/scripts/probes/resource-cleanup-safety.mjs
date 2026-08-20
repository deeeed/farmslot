import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const cdp = path.join(root, 'apps/command-center/scripts/cdp.mjs');
const machineArg = process.argv.indexOf('--machine');
const machine = machineArg >= 0 ? process.argv[machineArg + 1] : 'macwork';

const gateway = async (method, params) => {
  const { stdout } = await execFileAsync(
    process.execPath,
    [cdp, 'gateway', method, JSON.stringify(params)],
    { cwd: root, env: process.env, maxBuffer: 1024 * 1024 },
  );
  return JSON.parse(stdout);
};

let emptyRejected = false;
try {
  await gateway('resource.cleanup', { dryRun: false, targets: [] });
} catch (error) {
  emptyRejected = String(error).includes('non-empty exact reviewed targets');
}
if (!emptyRejected) throw new Error('live cleanup accepted an empty exact target set');

const missing = await gateway('resource.cleanup', {
  dryRun: false,
  targets: [
    {
      machine,
      slotId: '__farmslot_missing_cleanup_probe__',
      resourceId: '__none__',
    },
  ],
});
if (missing.ok || missing.stopped !== 0 || missing.targets?.[0]?.ok !== false) {
  throw new Error('missing reviewed target did not fail closed');
}

const fleetResult = await gateway('fleet.status', {});
const busySlot = fleetResult.fleet?.slots?.find(
  (slot) =>
    slot.machine === machine &&
    (slot.lifecycle === 'busy' || slot.lifecycle === 'held' || slot.currentRunId),
);
let busyRejected = null;
if (busySlot) {
  const busy = await gateway('resource.cleanup', {
    dryRun: false,
    targets: [{ machine, slotId: busySlot.slot, resourceId: '__none__' }],
  });
  busyRejected = !busy.ok && busy.stopped === 0 && busy.targets?.[0]?.ok === false;
  if (!busyRejected) throw new Error('busy reviewed target did not fail closed');
}

console.log(
  JSON.stringify({
    machine,
    emptyRejected,
    missingRejected: true,
    busyRejected,
    busyProof: busySlot ? 'verified' : 'not-applicable-no-busy-slot',
    mutations: 0,
  }),
);
