import {
  Methods,
  type NativeProfileStatusResult,
  type NativeSessionInfo,
} from '@farmslot/protocol';

import {
  addNativeProfile,
  inspectNativeProfile,
  listNativeProfiles,
  nativeProfileEnvironment,
  removeNativeProfile,
} from './account-profiles.js';
import type { NativeSessionClient } from './client.js';
import { nativeRunnerDefinitions } from './registry.js';

export const NATIVE_PROFILE_METHODS: readonly string[] = [
  Methods.NATIVE_PROFILE_LIST,
  Methods.NATIVE_PROFILE_ADD,
  Methods.NATIVE_PROFILE_STATUS,
  Methods.NATIVE_PROFILE_REMOVE,
];
function string(params: Record<string, unknown>, name: string): string {
  if (typeof params[name] !== 'string' || !params[name].trim())
    throw new Error(`${name} must be a nonempty string`);
  return params[name];
}
function quote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
function sessionStopped(session: NativeSessionInfo): boolean {
  return (
    ['closed', 'failed'].includes(session.state) &&
    (!session.processPid || session.processStopped === true)
  );
}

/** Called only after execution-node ownership is authorized, using that node's environment. */
export async function routeNativeProfile(
  client: NativeSessionClient,
  owner: string,
  method: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  if (
    Object.keys(params).some(
      (key) =>
        !['executionNodeId', 'profileId', 'runner', 'directory', 'accountContextId'].includes(key),
    )
  )
    throw new Error(
      'Native profiles accept native directories, not credentials or environment overrides',
    );
  if (method === Methods.NATIVE_PROFILE_LIST) return { profiles: listNativeProfiles() };
  const id = string(params, 'profileId');
  if (method === Methods.NATIVE_PROFILE_ADD)
    return {
      profile: await addNativeProfile({
        profileId: id,
        runner: string(params, 'runner'),
        ...(params.directory !== undefined ? { directory: string(params, 'directory') } : {}),
      }),
    };
  if (method === Methods.NATIVE_PROFILE_STATUS)
    return inspectNativeProfile(id, async (profile): Promise<NativeProfileStatusResult> => {
      const definition = nativeRunnerDefinitions[profile.runner];
      const account = await definition.account.observe({
        cwd: profile.directory,
        executable: definition.binary,
        env: nativeProfileEnvironment(profile),
      });
      const loginCommand = [
        'env',
        ...definition.account.unset.flatMap((name) => ['-u', name]),
        ...Object.entries(definition.account.environment(profile.directory)).map(
          ([key, value]) => `${key}=${value}`,
        ),
        account.executable ?? definition.binary,
        ...definition.account.loginArgs,
      ]
        .map(quote)
        .join(' ');
      return { profile, account, loginCommand };
    });
  if (method === Methods.NATIVE_PROFILE_REMOVE) {
    await removeNativeProfile(id, string(params, 'accountContextId'), async (profile) => {
      const sessions = (await client.list(owner)).filter(
        (session) => session.profileId === profile.id,
      );
      if (sessions.some((session) => session.workerManaged && !sessionStopped(session)))
        throw new Error('Stop this profile’s worker runs before removing the profile');
      for (const session of sessions) {
        // Retirement blocks new launches. A stopped worker needs no standalone
        // close request, which correctly requires its separate task controls.
        if (session.workerManaged) continue;
        await client.close(owner, session.id);
        const stopped = (await client.read(owner, session.id, undefined, 1)).session;
        if (!sessionStopped(stopped))
          throw new Error('Native profile process cleanup is not confirmed');
      }
    });
    return { removed: true };
  }
  throw new Error('Unknown native profile method');
}
