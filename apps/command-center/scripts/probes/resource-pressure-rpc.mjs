import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const machineArg = process.argv.indexOf('--machine');
const machineName = machineArg >= 0 ? process.argv[machineArg + 1] : 'macwork';
const projectArg = process.argv.indexOf('--project');
const projectName = projectArg >= 0 ? process.argv[projectArg + 1] : undefined;
if (!machineName) throw new Error('--machine requires a value');
const cdp = path.join(root, 'apps/command-center/scripts/cdp.mjs');
const { stdout } = await execFileAsync(
  process.execPath,
  [
    cdp,
    'gateway',
    'resource.pressure.snapshot',
    JSON.stringify({ machine: machineName, ...(projectName ? { project: projectName } : {}) }),
  ],
  { cwd: root, env: process.env, maxBuffer: 1024 * 1024 },
);
const snapshot = JSON.parse(stdout);
const machine = snapshot.machines?.find((candidate) => candidate.machine === machineName);
if (!machine) throw new Error(`resource pressure RPC omitted ${machineName}`);
if (
  typeof snapshot.summary?.omittedMachines !== 'number' ||
  typeof snapshot.summary?.omittedCleanupCandidates !== 'number'
) {
  throw new Error('resource pressure RPC omitted envelope truncation metadata');
}
if (!Array.isArray(machine.history) || machine.history.length === 0) {
  throw new Error('resource pressure RPC returned no history');
}
const attribution = machine.processAttribution;
if (!attribution || !Array.isArray(attribution.groups)) {
  throw new Error('resource pressure RPC returned an invalid attribution shape');
}
const expectedClasses = ['active', 'retained', 'stale', 'manual', 'unknown'];
if (expectedClasses.some((key) => typeof attribution.classCounts?.[key] !== 'number')) {
  throw new Error('resource pressure RPC returned invalid class counts');
}
if (attribution.sampledProcesses > 0 && !attribution.sampledAt) {
  throw new Error('sampled process attribution omitted sampledAt');
}
if (machine.system && 'processInventory' in machine.system) {
  throw new Error('resource pressure RPC leaked raw inventory through MachineHealth.system');
}
if (projectName) {
  const { stdout: fleetStdout } = await execFileAsync(
    process.execPath,
    [cdp, 'gateway', 'fleet.status', '{}'],
    {
      cwd: root,
      env: process.env,
      maxBuffer: 1024 * 1024,
    },
  );
  const fleet = JSON.parse(fleetStdout).fleet;
  const allowedSlots = new Set(
    (fleet?.slots ?? [])
      .filter((slot) => slot.machine === machineName && slot.project === projectName)
      .map((slot) => slot.slot),
  );
  const leaked = attribution.groups.find(
    (group) => group.slotId && !allowedSlots.has(group.slotId),
  );
  if (leaked) throw new Error(`project-filtered attribution leaked slot ${leaked.slotId}`);
}
console.log(
  JSON.stringify({
    machine: machine.machine,
    project: projectName ?? null,
    historySamples: machine.history.length,
    sampledAt: attribution.sampledAt,
    groups: attribution.groups.length,
    classCounts: attribution.classCounts,
    omittedGroups: attribution.omittedGroups,
    rawInventoryInHealth: false,
    managedIdentityScope: projectName ? 'project-filtered' : 'whole-machine',
  }),
);
