import {
  Methods,
  type NativeProfileListResult,
  type NativeProfileReference,
  type NativeProfileStatusResult,
  sameNativeProfileReference,
} from '@farmslot/protocol';
import { type GatewayResourceCache, nativeObservationQuery } from '@farmslot/protocol/client-cache';

import { nativeProfileReference, validateNativeProfileStatus } from '../../lib/native-profile';

export interface NativeProfileSelectionResources {
  cache: Pick<GatewayResourceCache, 'read' | 'retry'>;
  nativeOwnerId: string;
}

export async function readNativeProfileSelection(
  resources: NativeProfileSelectionResources,
  node: string,
  runner: string,
  selected: NativeProfileReference | undefined,
  current: () => boolean,
) {
  if (!current()) return;
  const { cache, nativeOwnerId } = resources;
  const listQuery = nativeObservationQuery<NativeProfileListResult>(
    Methods.NATIVE_PROFILE_LIST,
    { executionNodeId: node },
    nativeOwnerId,
  );
  await cache.retry(listQuery);
  if (!current()) return;
  const listed = cache.read(listQuery);
  if (listed.status !== 'ready' || !listed.data)
    throw new Error(listed.error?.message ?? 'Wait for current runner profiles before launch.');
  const result = listed.data;
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
  const statusQuery = nativeObservationQuery<NativeProfileStatusResult>(
    Methods.NATIVE_PROFILE_STATUS,
    { executionNodeId: node, profileId: profile.id },
    nativeOwnerId,
  );
  await cache.retry(statusQuery);
  if (!current()) return;
  const observed = cache.read(statusQuery);
  const currentList = cache.read(listQuery);
  if (observed.status !== 'ready' || !observed.data)
    throw new Error(observed.error?.message ?? 'Wait for current profile login before launch.');
  if (currentList.status !== 'ready' || !currentList.data)
    throw new Error(
      currentList.error?.message ?? 'Wait for current runner profiles before launch.',
    );
  const currentProfile = currentList.data.profiles.find(
    (item) => item.id === selected.profileId && item.runner === runner,
  );
  if (
    !currentProfile ||
    !sameNativeProfileReference(selected, nativeProfileReference(node, currentProfile))
  )
    return {
      profiles,
      error: 'Profile registration changed or is missing. Select a profile explicitly to continue.',
    };
  if (currentProfile.state !== 'active')
    return { profiles, error: 'Profile removal is incomplete.' };
  const status = observed.data;
  try {
    validateNativeProfileStatus(selected, currentProfile, status);
  } catch (cause) {
    return { profiles, error: cause instanceof Error ? cause.message : String(cause) };
  }
  return { profiles, status };
}
