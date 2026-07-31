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
    // Reached transitively via methods/git.ts. Record it like execOnSlot so a
    // future call remains visible to these wiring assertions.
    execArgvOnSlot: async (_vars: unknown, argv: string[]): Promise<ExecResult> => {
      execCommands.push(argv.join(' '));
      return nextResult;
    },
    execFileArgv: async (argv: string[]): Promise<ExecResult> => {
      execCommands.push(argv.join(' '));
      return nextResult;
    },
    execOnSlot: async (_vars: unknown, cmd: string): Promise<ExecResult> => {
      execCommands.push(cmd);
      return nextResult;
    },
    execLocal: async (): Promise<ExecResult> => nextResult,
    // Reached transitively via methods/git.ts. Mirrors the execOnSlot mock above so
    // the recorded command log stays coherent whichever entrypoint the subject uses.
    execArgvOnSlot: async (_vars: unknown, argv: string[]): Promise<ExecResult> => {
      execCommands.push(argv.join(' '));
      return nextResult;
    },
    execFileArgv: async (): Promise<ExecResult> => nextResult,
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

test('artifact_available threads both work ref and default ref into the hook', async () => {
  execCommands.length = 0;
  nextResult = { stdout: '', stderr: '', exitCode: 0 };
  const refCtx = {
    vars: makeSlotVars('/repo'),
    projectJson: {
      hooks: {
        artifact_check:
          'bash artifact-check.sh --branch {{prepare_ref}} --default-branch {{prepare_default_ref}}',
      },
    },
    runtimeDir: '.agent',
    prepareRef: 'feat/my-work',
    prepareDefaultRef: 'main',
  };
  const result = await checkPrepareRequirement('artifact_available', refCtx);
  assert.equal(result.ok, true);
  // The probe receives both refs so it can order resolution itself.
  assert.match(
    execCommands[0],
    /bash artifact-check\.sh --branch feat\/my-work --default-branch main/,
  );
});

test('artifact_available substitutes an empty work ref (no hardcoded branch leaks through)', async () => {
  // A run with no work branch expands {{prepare_ref}} to empty (not a literal
  // placeholder and not a stale default); the default ref still threads through.
  execCommands.length = 0;
  nextResult = { stdout: '', stderr: '', exitCode: 0 };
  const noWorkRefCtx = {
    vars: makeSlotVars('/repo'),
    projectJson: {
      hooks: {
        artifact_check:
          'bash artifact-check.sh --branch "{{prepare_ref}}" --default-branch {{prepare_default_ref}}',
      },
    },
    runtimeDir: '.agent',
    prepareDefaultRef: 'main',
  };
  await checkPrepareRequirement('artifact_available', noWorkRefCtx);
  assert.match(execCommands[0], /--branch "" --default-branch main/);
});
