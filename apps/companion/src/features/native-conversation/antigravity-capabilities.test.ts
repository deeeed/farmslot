import assert from 'node:assert/strict';
import test from 'node:test';

import type {
  NativeProfileInfo,
  NativeProfileStatusResult,
  NativeSessionCatalogResult,
  NativeSessionInfo,
} from '@farmslot/protocol';
import {
  catalogForNativeRunners,
  nativeLaunchModel,
  nativeLaunchModelSelection,
  ReviewDispatchViewModel,
} from '@farmslot/review-dispatch';

import {
  nativeProfileLoginReason,
  nativeProfileReference,
  nativeResumeRequest,
  validateNativeProfileStatus,
} from '../../lib/native-profile';

test('Companion Copilot flow consumes server-declared Antigravity catalog, display names, profile helpers, and resume rules', () => {
  const catalog: NativeSessionCatalogResult = {
    runners: [
      {
        runner: 'antigravity',
        nativeOnly: true,
        models: [],
        nodeModels: {
          local: ['gemini-4-neon-high', 'gemini-3.8-flash-low'],
        },
        modelLabels: {
          'gemini-4-neon-high': 'Gemini 4 Neon (High)',
          'gemini-3.8-flash-low': 'Gemini 3.8 Flash (Low)',
        },
        defaultModel: '',
        modes: ['default', 'plan'],
        supportsWorkers: true,
        supportsQueuedWorkers: true,
      },
    ],
    contexts: [
      {
        cwd: '/Users/operator/workspace',
        label: 'Workspace',
        executionNodeId: 'local',
        supportsProfiles: true,
      },
    ],
  };

  const runnerCatalog = catalogForNativeRunners(catalog.runners, undefined, 'local');
  const agy = runnerCatalog.runners.find((entry) => entry.id === 'antigravity');
  assert.ok(agy);
  assert.deepEqual(agy.models, [
    { id: 'gemini-4-neon-high', label: 'Gemini 4 Neon (High)' },
    { id: 'gemini-3.8-flash-low', label: 'Gemini 3.8 Flash (Low)' },
  ]);
  // Effort is unsupported as a separate control because Antigravity encodes thinking level in model IDs
  assert.deepEqual(agy.efforts, []);
  assert.equal(nativeLaunchModelSelection(agy, 'gemini-3.8-flash-low'), 'gemini-3.8-flash-low');
  assert.equal(nativeLaunchModel(agy, 'gemini-3.8-flash-low'), 'gemini-3.8-flash-low');

  const picker = new ReviewDispatchViewModel({
    context: { allowedActions: ['chat'] },
    catalog: runnerCatalog,
    sequence: [
      { runner: 'antigravity', model: 'gemini-3.8-flash-low', effort: null, mode: 'cold' },
    ],
  });
  assert.equal(picker.selection?.runner, 'antigravity');
  assert.equal(picker.selection?.model, 'gemini-3.8-flash-low');
  assert.deepEqual(picker.effortChoices(picker.rows[0].id), [
    { value: null, label: 'Supported default' },
  ]);

  // Exercise Companion's real native profile & resume consumers against an Antigravity session.
  const accountContextId = '11111111-2222-4333-8444-555555555555';
  const profile: NativeProfileInfo = {
    id: 'work-agy',
    runner: 'antigravity',
    directory: '/Users/operator/.farmslot/profiles/work-agy',
    accountContextId,
    state: 'active',
  };
  const profileRef = nativeProfileReference('local', profile);
  const authenticatedStatus: NativeProfileStatusResult = {
    profile,
    account: {
      runner: 'antigravity',
      installed: true,
      login: 'authenticated',
      version: '1.5.12',
      mode: 'subscription',
      identityQuality: 'unavailable',
      observedAt: '2026-11-27T00:00:00Z',
    },
    loginCommand: "env 'HOME=/Users/operator/.farmslot/profiles/work-agy' 'agy' 'login'",
  };
  assert.doesNotThrow(() => validateNativeProfileStatus(profileRef, profile, authenticatedStatus));
  assert.equal(nativeProfileLoginReason(authenticatedStatus), undefined);
  assert.match(
    nativeProfileLoginReason({
      ...authenticatedStatus,
      account: { ...authenticatedStatus.account, login: 'signed-out' },
    }) ?? '',
    /Sign in/,
  );
  assert.match(
    nativeProfileLoginReason({
      ...authenticatedStatus,
      account: { ...authenticatedStatus.account, installed: false, login: 'unavailable' },
    }) ?? '',
    /unavailable on this node/,
  );
  assert.throws(
    () =>
      validateNativeProfileStatus(profileRef, profile, {
        ...authenticatedStatus,
        profile: { ...profile, state: 'retiring' },
      }),
    /Profile registration changed/,
  );

  const closedSession: NativeSessionInfo = {
    id: 'session-agy-1',
    generation: 'gen-1',
    hostPid: 4242,
    ownerPrincipalId: 'operator',
    executionNodeId: 'local',
    runner: 'antigravity',
    cwd: '/Users/operator/workspace',
    executable: '/usr/local/bin/agy',
    version: '1.5.12',
    model: 'gemini-3.8-flash-low',
    mode: 'default',
    accountMode: 'native',
    approvalMode: 'ask',
    state: 'closed',
    nativeSessionId: 'acp-session-1',
    profileId: profile.id,
    accountContextId,
    capabilities: {
      modes: ['default', 'plan'],
      approvalModes: ['ask', 'bypass'],
      streaming: true,
      tools: true,
      approvals: true,
      questions: false,
      interrupt: true,
      resume: true,
      contextCompaction: false,
    },
  };
  assert.deepEqual(nativeResumeRequest(closedSession, profileRef), {
    executionNodeId: 'local',
    runner: 'antigravity',
    cwd: '/Users/operator/workspace',
    model: 'gemini-3.8-flash-low',
    mode: 'default',
    resumeSessionId: 'acp-session-1',
    profileId: 'work-agy',
    accountContextId,
  });
  assert.throws(
    () =>
      nativeResumeRequest(
        {
          ...closedSession,
          capabilities: { ...closedSession.capabilities, resume: false },
        },
        profileRef,
      ),
    /cannot be resumed/,
  );
  assert.throws(
    () => nativeResumeRequest(closedSession, undefined),
    /saved runner and configuration directory/,
  );
});
