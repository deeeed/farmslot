import assert from 'node:assert/strict';
import os from 'node:os';
import { mock, test } from 'node:test';

import type { ExecResult } from '@farmslot/protocol';

import type { RawProjectJson, SlotVars } from '../../core/index.js';

// Stub only the slot exec layer so the artifact_available check runs its real
// hook expansion + detail formatting against a controlled command outcome. The
// probe itself lives in the project repo; here we only prove the gateway wiring:
// exit 0 → available, non-zero → unavailable with the probe's last line as detail.
let nextResult: ExecResult = { stdout: '', stderr: '', exitCode: 0 };
const execCommands: string[] = [];
mock.module('../../core/exec.js', {
  namedExports: {
    execOnSlot: async (_vars: unknown, cmd: string): Promise<ExecResult> => {
      execCommands.push(cmd);
      return nextResult;
    },
    execLocal: async (): Promise<ExecResult> => nextResult,
    isLocal: () => false,
  },
});

const { checkPrepareRequirement } = await import('./prepare-profile.js');

function makeSlotVars(remoteRepo: string): SlotVars {
  return {
    slotId: 'artifact-test',
    machine: os.hostname(),
    platform: 'ios',
    host: 'localhost',
    sshUser: 'test',
    osType: 'darwin',
    claudePath: '',
    codexPath: '',
    opencodePath: '',
    cursorPath: '',
    grokPath: '',
    dispatchCmd: '',
    recycleCmd: '',
    repo: remoteRepo,
    session: 'artifact-test',
    slotMode: 'dispatch',
    slotEnabled: true,
    sshTarget: '',
    remoteRepo,
    projectName: 'artifact-test',
    resourceVars: {},
  };
}

const projectJson: RawProjectJson = { hooks: { artifact_check: 'bash artifact-check.sh' } };
const ctx = { vars: makeSlotVars('/repo'), projectJson, runtimeDir: '.agent' };

test('artifact_available passes when the artifact_check hook exits 0', async () => {
  execCommands.length = 0;
  nextResult = { stdout: 'cache HIT\n', stderr: '', exitCode: 0 };
  const result = await checkPrepareRequirement('artifact_available', ctx);
  assert.equal(result.ok, true);
  assert.equal(result.detail, 'artifact_check passed');
  // Runs the expanded hook inside the slot's repo dir.
  assert.match(execCommands[0], /cd '\/repo' && bash artifact-check\.sh/);
});

test('artifact_available fails with the probe last line when the hook exits non-zero', async () => {
  nextResult = {
    stdout: 'resolving run...\nno Runway artifact resolvable for ios@main: gh auth login\n',
    stderr: '',
    exitCode: 1,
  };
  const result = await checkPrepareRequirement('artifact_available', ctx);
  assert.equal(result.ok, false);
  assert.equal(
    result.detail,
    'artifact_check exited 1: no Runway artifact resolvable for ios@main: gh auth login',
  );
});

test('artifact_available fails with a bare detail when the probe prints nothing', async () => {
  nextResult = { stdout: '', stderr: '', exitCode: 2 };
  const result = await checkPrepareRequirement('artifact_available', ctx);
  assert.equal(result.ok, false);
  assert.equal(result.detail, 'artifact_check exited 2');
});
