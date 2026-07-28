import assert from 'node:assert/strict';
import test from 'node:test';

import type { SlotVars } from '@farmslot/slot-config';

import { buildFixtureSelectionVars, slotVarsShellLines } from './internal.js';

test('buildFixtureSelectionVars picks up an env var named by a non-standard compose.var', () => {
  // A project with `compose.var: "TARGET"` relies on bash `${!TARGET}` reach:
  // the exported TARGET must reach selection without a dedicated flag.
  const selectionVars = buildFixtureSelectionVars({
    env: { TARGET: 'alpha', UNRELATED: 'x' },
  });
  assert.equal(selectionVars.TARGET, 'alpha');
  assert.equal(selectionVars.UNRELATED, 'x');
});

test('buildFixtureSelectionVars lets an explicit flag override the env value', () => {
  const selectionVars = buildFixtureSelectionVars({
    env: { FLOW_TYPE: 'from-env', APP: 'env-app', DOMAIN: 'env-domain' },
    flowType: 'from-flag',
    app: 'flag-app',
    domain: 'flag-domain',
  });
  assert.equal(selectionVars.FLOW_TYPE, 'from-flag');
  assert.equal(selectionVars.APP, 'flag-app');
  assert.equal(selectionVars.DOMAIN, 'flag-domain');
});

test('buildFixtureSelectionVars keeps the env value when the matching flag is absent', () => {
  const selectionVars = buildFixtureSelectionVars({
    env: { FLOW_TYPE: 'from-env', APP: 'env-app' },
    // no flowType/app flags passed
    domain: 'flag-domain',
  });
  assert.equal(selectionVars.FLOW_TYPE, 'from-env');
  assert.equal(selectionVars.APP, 'env-app');
  assert.equal(selectionVars.DOMAIN, 'flag-domain');
});

test('buildFixtureSelectionVars defaults a custom slot to the custom variant only when unset', () => {
  assert.equal(buildFixtureSelectionVars({ env: {}, slotMode: 'custom' }).FLOW_TYPE, 'custom');
  // An env-supplied or flag FLOW_TYPE is not clobbered by the custom default.
  assert.equal(
    buildFixtureSelectionVars({ env: { FLOW_TYPE: 'fix-bug' }, slotMode: 'custom' }).FLOW_TYPE,
    'fix-bug',
  );
});

test('slotVarsShellLines preserves an explicit slot Metro port', () => {
  const vars = {
    slotId: 'macwork-ff-1',
    machine: 'macwork',
    platform: 'cli',
    host: 'macwork.local',
    sshUser: '',
    osType: 'darwin',
    claudePath: '',
    codexPath: '',
    opencodePath: '',
    cursorPath: '',
    grokPath: '',
    dispatchCmd: '',
    recycleCmd: '',
    repo: '/tmp/farmslot-1',
    session: 'ff-1',
    slotMode: 'dispatch',
    slotEnabled: true,
    sshTarget: 'macwork.local',
    remoteRepo: '/tmp/farmslot-1',
    projectName: 'farmslot-farm',
    resourceVars: {
      port: '8808',
      metro_port: '8878',
    },
  } satisfies SlotVars;

  assert.deepEqual(
    slotVarsShellLines(vars).filter((line) => line.startsWith('METRO_PORT=')),
    ["METRO_PORT='8878'"],
  );
});

test('slotVarsShellLines never aliases a missing Metro port to the gateway port', () => {
  const vars = {
    slotId: 'legacy-ff-1',
    machine: 'legacy',
    platform: 'cli',
    host: 'localhost',
    sshUser: '',
    osType: 'darwin',
    claudePath: '',
    codexPath: '',
    opencodePath: '',
    cursorPath: '',
    grokPath: '',
    dispatchCmd: '',
    recycleCmd: '',
    repo: '/tmp/farmslot-1',
    session: 'ff-1',
    slotMode: 'dispatch',
    slotEnabled: true,
    sshTarget: 'localhost',
    remoteRepo: '/tmp/farmslot-1',
    projectName: 'farmslot-farm',
    resourceVars: { port: '8808' },
  } satisfies SlotVars;

  assert.deepEqual(
    slotVarsShellLines(vars).filter((line) => line.startsWith('METRO_PORT=')),
    ["METRO_PORT=''"],
  );
});
