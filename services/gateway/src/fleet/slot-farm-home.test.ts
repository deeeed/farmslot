import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { NodeFarmPaths } from '@farmslot/protocol/node/farm-paths';

const gatewayHome = mkdtempSync(path.join(tmpdir(), 'slot-farm-home-'));
process.env.FARMSLOT_HOME = gatewayHome;
const { setNodeFarmPathsLookup } = await import('@farmslot/slot-config');
const { currentFarmPaths } = await import('@farmslot/protocol/node/farm-paths');
const { slotFarmHome } = await import('./slot-storage-cleanup.js');

const reports = new Map<string, Pick<NodeFarmPaths, 'layout' | 'home'>>();
setNodeFarmPathsLookup((machine) => reports.get(machine) as NodeFarmPaths | undefined);
const remote = { machine: 'parking-remote', host: 'parking-remote.invalid' };

test('a layout-2 node report names the parking home', () => {
  reports.set(remote.machine, { layout: 2, home: '/srv/farm/instances/dev' });
  assert.equal(slotFarmHome({ ...remote, machineEnv: {} }), '/srv/farm/instances/dev');
  reports.clear();
});

test('a legacy report falls back like blind trials: the pool FARMSLOT_HOME, else ~/.farmslot', () => {
  reports.set(remote.machine, { layout: 'legacy', home: '/reported/legacy-home' });
  assert.equal(
    slotFarmHome({ ...remote, machineEnv: { FARMSLOT_HOME: '~/.farmslot-dev' } }),
    '~/.farmslot-dev',
  );
  assert.equal(slotFarmHome({ ...remote, machineEnv: {} }), '~/.farmslot');
  reports.clear();
});

test("a local slot parks under this gateway's own farm home", () => {
  assert.equal(
    slotFarmHome({ machine: 'parking-local', host: 'localhost', machineEnv: {} }),
    currentFarmPaths('gateway').home,
  );
});
