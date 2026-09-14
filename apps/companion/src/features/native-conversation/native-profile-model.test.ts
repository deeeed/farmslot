import assert from 'node:assert/strict';
import test from 'node:test';

import {
  Methods,
  type NativeProfileInfo,
  type NativeProfileStatusResult,
  type NativeSessionInfo,
} from '@farmslot/protocol';

import {
  nativeProfileLoginReason,
  nativeProfileReference,
  nativeResumeRequest,
  sessionNativeProfile,
  validateNativeProfileStatus,
} from '../../lib/native-profile';

import { readNativeProfileSelection } from './native-profile-queries';

const profile: NativeProfileInfo = {
  id: 'personal',
  runner: 'claude',
  directory: '/private/profiles/personal',
  accountContextId: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa',
  state: 'active',
};
const reference = nativeProfileReference('private-node', profile);
const status = (): NativeProfileStatusResult => ({
  profile: { ...profile },
  loginCommand: 'native login command',
  account: {
    runner: 'claude',
    installed: true,
    login: 'authenticated',
    mode: 'subscription',
    identity: { subjectId: 'first-login' },
    identityQuality: 'stable-subject',
    observedAt: '2026-09-14T00:00:00Z',
  },
});

function api(replies: unknown[]) {
  const calls: Array<{ method: string; params: unknown }> = [];
  return {
    calls,
    request: async <T>(method: string, params: unknown) => {
      calls.push({ method, params });
      return (await replies.shift()) as T;
    },
  };
}

test('login rotation inside the same directory keeps the exact registered profile usable', async () => {
  const observed = status();
  observed.account.identity = { subjectId: 'different-login' };
  const gateway = api([{ profiles: [profile] }, observed]);
  const result = await readNativeProfileSelection(
    gateway,
    'private-node',
    'claude',
    reference,
    () => true,
  );
  assert.deepEqual(result?.profiles, [profile]);
  assert.equal(nativeProfileLoginReason(result?.status), undefined);
  assert.deepEqual(
    gateway.calls.map(({ method }) => method),
    [Methods.NATIVE_PROFILE_LIST, Methods.NATIVE_PROFILE_STATUS],
  );
  assert.deepEqual(gateway.calls[1].params, {
    executionNodeId: 'private-node',
    profileId: 'personal',
  });
});

test('missing, replaced, retiring and foreign node/runner selections never adopt a default or another registration', async () => {
  for (const [profiles, selected] of [
    [[], reference],
    [[{ ...profile, accountContextId: 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb' }], reference],
    [[{ ...profile, state: 'retiring' }], reference],
    [[profile], { ...reference, executionNodeId: 'other-node' }],
    [[{ ...profile, runner: 'codex' }], reference],
  ] as const) {
    const gateway = api([{ profiles }]);
    const result = await readNativeProfileSelection(
      gateway,
      'private-node',
      'claude',
      selected,
      () => true,
    );
    assert(result?.error);
    assert.equal(result.status, undefined);
    assert.equal(
      gateway.calls.length,
      1,
      'Do not request login status for a mismatched registration',
    );
  }
});

test('status must match the listed directory, registration, runner and active state', () => {
  for (const changed of [
    { directory: '/different-directory' },
    { id: 'other' },
    { runner: 'codex' },
    { accountContextId: 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb' },
    { state: 'retiring' as const },
  ]) {
    const result = status();
    Object.assign(result.profile, changed);
    assert.throws(
      () => validateNativeProfileStatus(reference, profile, result),
      /registration changed/,
    );
  }
  const result = status();
  result.account.runner = 'codex';
  assert.throws(
    () => validateNativeProfileStatus(reference, profile, result),
    /registration changed/,
  );
});

test('actual signed-out, unavailable and missing-runner observations block readiness', () => {
  for (const login of ['signed-out', 'unavailable'] as const) {
    const result = status();
    result.account.login = login;
    assert(nativeProfileLoginReason(result));
  }
  const result = status();
  result.account.installed = false;
  assert(nativeProfileLoginReason(result));
  assert(nativeProfileLoginReason(undefined));
  assert.equal(nativeProfileLoginReason(status()), undefined);
});

test('a response from the prior node, runner or credentials cannot publish profiles or start the next lookup', async () => {
  for (const delayedPhase of ['list', 'status']) {
    let release!: (value: unknown) => void;
    const delayed = new Promise((resolve) => {
      release = resolve;
    });
    const gateway = api(delayedPhase === 'list' ? [delayed] : [{ profiles: [profile] }, delayed]);
    let current = true;
    const reading = readNativeProfileSelection(
      gateway,
      'private-node',
      'claude',
      reference,
      () => current,
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    current = false;
    release(delayedPhase === 'list' ? { profiles: [profile] } : status());
    assert.equal(await reading, undefined);
    assert.equal(gateway.calls.length, delayedPhase === 'list' ? 1 : 2);
  }
});

const savedSession = (): NativeSessionInfo => ({
  id: 'wrapper-session',
  generation: 'generation-1',
  hostPid: 100,
  processPid: 101,
  processStopped: true,
  runner: profile.runner,
  nativeSessionId: 'runner-session',
  ownerPrincipalId: 'owner',
  executionNodeId: reference.executionNodeId,
  accountContextId: reference.accountContextId,
  profileId: profile.id,
  cwd: '/private/workspace',
  executable: '/native/runner',
  version: 'current',
  model: 'saved-model',
  mode: 'plan',
  accountMode: 'native',
  capabilities: {
    modes: ['default', 'plan'],
    streaming: true,
    tools: true,
    approvals: true,
    questions: true,
    interrupt: true,
    resume: true,
  },
  state: 'closed',
});

test('resume preserves saved runner, node, model, mode, native identity and configuration registration', () => {
  const session = savedSession();
  assert.deepEqual(nativeResumeRequest(session, sessionNativeProfile(session)), {
    executionNodeId: 'private-node',
    runner: 'claude',
    model: 'saved-model',
    mode: 'plan',
    cwd: '/private/workspace',
    resumeSessionId: 'runner-session',
    profileId: 'personal',
    accountContextId: reference.accountContextId,
  });
  for (const changed of [
    undefined,
    { ...reference, runner: 'codex' },
    { ...reference, profileId: 'other' },
    { ...reference, executionNodeId: 'other-node' },
    { ...reference, accountContextId: 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb' },
  ]) {
    assert.throws(() => nativeResumeRequest(session, changed), /saved runner and configuration/);
  }
  delete session.profileId;
  assert.equal(sessionNativeProfile(session), undefined);
  const request = nativeResumeRequest(session, undefined);
  assert(!('profileId' in request));
  assert(!('accountContextId' in request));
});

test('worker history, live or unconfirmed processes and unsupported saved sessions stay read-only', () => {
  for (const changed of [
    { workerManaged: true },
    { state: 'idle' as const },
    { processStopped: false },
    { nativeSessionId: '' },
  ]) {
    assert.throws(
      () => nativeResumeRequest({ ...savedSession(), ...changed }, reference),
      /cannot be resumed/,
    );
  }
  const session = savedSession();
  session.capabilities.resume = false;
  assert.throws(() => nativeResumeRequest(session, reference), /cannot be resumed/);
});
