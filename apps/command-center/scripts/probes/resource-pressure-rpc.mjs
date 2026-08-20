import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const cdp = path.join(root, 'apps/command-center/scripts/cdp.mjs');
const { stdout } = await execFileAsync(
  process.execPath,
  [cdp, 'gateway', 'resource.pressure.snapshot', '{"machine":"macwork"}'],
  { cwd: root, env: process.env, maxBuffer: 1024 * 1024 },
);
const snapshot = JSON.parse(stdout);
const machine = snapshot.machines?.find((candidate) => candidate.machine === 'macwork');
if (!machine) throw new Error('resource pressure RPC omitted macwork');
if (!Array.isArray(machine.history) || machine.history.length === 0) {
  throw new Error('resource pressure RPC returned no history');
}
const attribution = machine.processAttribution;
if (
  !attribution?.sampledAt ||
  !Array.isArray(attribution.groups) ||
  attribution.groups.length === 0
) {
  throw new Error('resource pressure RPC returned no sampled process attribution');
}
const classTotal = Object.values(attribution.classCounts ?? {}).reduce(
  (total, count) => total + Number(count),
  0,
);
if (classTotal === 0) throw new Error('resource pressure RPC returned empty class counts');
if (!(attribution.classCounts.active > 0)) {
  throw new Error('resource pressure RPC returned no active managed class');
}
if (!attribution.groups.some((group) => group.classification === 'active')) {
  throw new Error('active managed group did not survive the response cap');
}
if (!(attribution.omittedGroups > 0)) {
  throw new Error('live proof requires an unknown-heavy truncated group set');
}
if (machine.system && 'processInventory' in machine.system) {
  throw new Error('resource pressure RPC leaked raw inventory through MachineHealth.system');
}
const samplerSource = await readFile(
  path.join(root, 'services/node/src/commands/system-metrics.ts'),
  'utf8',
);
if (!samplerSource.includes("'comm='") || samplerSource.includes("'command='")) {
  throw new Error('process sampler is not using the comm-only executable field');
}

console.log(
  JSON.stringify({
    machine: machine.machine,
    historySamples: machine.history.length,
    sampledAt: attribution.sampledAt,
    groups: attribution.groups.length,
    classCounts: attribution.classCounts,
    omittedGroups: attribution.omittedGroups,
    managedGroupPreserved: true,
    commOnlyExecutable: true,
    rawInventoryInHealth: false,
  }),
);
