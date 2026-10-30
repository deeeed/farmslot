import {
  type GatewayProfile,
  restoreGatewayProfileLogin,
  snapshotGatewayProfileLogin,
} from './gateway-profiles';

/**
 * Saves every profile a pairing produced, or none of their logins. A step that fails puts back the
 * login each profile had before, so a failed pairing leaves no half-saved sign-in behind.
 */
export async function savePairedProfiles<T extends { profile: GatewayProfile }>(
  imported: readonly T[],
  save: (entry: T) => Promise<void>,
): Promise<void> {
  const before = await Promise.all(
    imported.map(({ profile }) => snapshotGatewayProfileLogin(profile)),
  );
  try {
    for (const entry of imported) await save(entry);
  } catch (error) {
    await Promise.all(
      imported.map(({ profile }, index) =>
        restoreGatewayProfileLogin(profile, before[index] ?? null),
      ),
    );
    throw error;
  }
}
