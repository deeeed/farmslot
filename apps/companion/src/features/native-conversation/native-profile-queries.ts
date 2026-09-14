import {
  Methods,
  type NativeProfileListResult,
  type NativeProfileReference,
  type NativeProfileStatusResult,
  sameNativeProfileReference,
} from '@farmslot/protocol';

import { nativeProfileReference, validateNativeProfileStatus } from '../../lib/native-profile';

interface ProfileApi {
  request<T>(method: string, params: unknown): Promise<T>;
}

export async function readNativeProfileSelection(
  api: ProfileApi,
  node: string,
  runner: string,
  selected: NativeProfileReference | undefined,
  current: () => boolean,
) {
  const result = await api.request<NativeProfileListResult>(Methods.NATIVE_PROFILE_LIST, {
    executionNodeId: node,
  });
  if (!current()) return;
  const profiles = result.profiles.filter((profile) => profile.runner === runner);
  if (!selected) return { profiles };
  const profile = profiles.find((item) => item.id === selected.profileId);
  if (!profile || !sameNativeProfileReference(selected, nativeProfileReference(node, profile))) {
    return {
      profiles,
      error: 'Profile registration changed or is missing. Select a profile explicitly to continue.',
    };
  }
  if (profile.state !== 'active') return { profiles, error: 'Profile removal is incomplete.' };
  const status = await api.request<NativeProfileStatusResult>(Methods.NATIVE_PROFILE_STATUS, {
    executionNodeId: node,
    profileId: profile.id,
  });
  if (!current()) return;
  try {
    validateNativeProfileStatus(selected, profile, status);
  } catch (cause) {
    return { profiles, error: cause instanceof Error ? cause.message : String(cause) };
  }
  return { profiles, status };
}
