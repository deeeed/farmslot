import {
  isNativeProfileReference,
  type NativeProfileInfo,
  type NativeProfileReference,
  nativeProfileSessionParams,
  type NativeProfileStatusResult,
  type NativeSessionCreateParams,
  type NativeSessionInfo,
  sameNativeProfileReference,
} from '@farmslot/protocol';

export function nativeProfileReference(
  executionNodeId: string,
  profile: NativeProfileInfo,
): NativeProfileReference {
  return {
    executionNodeId,
    runner: profile.runner,
    profileId: profile.id,
    accountContextId: profile.accountContextId,
  };
}

export function sessionNativeProfile(
  session: NativeSessionInfo,
): NativeProfileReference | undefined {
  if (!session.profileId) return undefined;
  const profile = {
    executionNodeId: session.executionNodeId,
    runner: session.runner,
    profileId: session.profileId,
    accountContextId: session.accountContextId,
  };
  if (!isNativeProfileReference(profile))
    throw new Error('The saved profile registration is incomplete.');
  return profile;
}

export function validateNativeProfileStatus(
  profile: NativeProfileReference,
  expected: NativeProfileInfo,
  status: NativeProfileStatusResult,
) {
  if (
    !sameNativeProfileReference(
      profile,
      nativeProfileReference(profile.executionNodeId, status.profile),
    ) ||
    status.profile.directory !== expected.directory ||
    status.profile.state !== 'active' ||
    status.account.runner !== profile.runner
  ) {
    throw new Error('Profile registration changed. Refresh profiles and select it again.');
  }
}

export function nativeProfileLoginReason(
  status: NativeProfileStatusResult | undefined,
): string | undefined {
  if (!status) return 'Checking profile login.';
  if (!status.account.installed) return 'The runner is unavailable on this node.';
  if (status.account.login === 'signed-out')
    return 'Sign in using the normal runner login command, then refresh.';
  if (status.account.login !== 'authenticated')
    return 'Login status is unavailable. Refresh after checking the runner on its node.';
  return undefined;
}

export function nativeResumeRequest(
  session: NativeSessionInfo,
  profile: NativeProfileReference | undefined,
): NativeSessionCreateParams {
  if (
    session.workerManaged ||
    !session.capabilities.resume ||
    !session.nativeSessionId ||
    !['closed', 'failed'].includes(session.state) ||
    (session.processPid && !session.processStopped)
  ) {
    throw new Error('This conversation cannot be resumed here.');
  }
  if (!sameNativeProfileReference(sessionNativeProfile(session), profile))
    throw new Error('Resume must use the saved runner and configuration directory.');
  return {
    executionNodeId: session.executionNodeId,
    runner: session.runner,
    cwd: session.cwd,
    model: session.model,
    mode: session.mode,
    resumeSessionId: session.nativeSessionId,
    ...nativeProfileSessionParams(profile),
  };
}
