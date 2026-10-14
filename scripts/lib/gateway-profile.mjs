// Automation and proof scripts share the CLI's explicit profile resolution.
// No profile means no credential. Keep service/test profiles in their own home.
import { tsImport } from 'tsx/esm/api';

export async function automationGatewayTarget(
  requestedUrl = process.env.FARMSLOT_GATEWAY,
  name = process.env.FARMSLOT_GATEWAY_PROFILE,
) {
  if (!name) return null;
  const { loadProfiles, profileForUrl } = await tsImport(
    '../../packages/cli/src/gateway-profiles.ts',
    import.meta.url,
  );
  const profile = loadProfiles().gateways[name];
  if (!profile) throw new Error(`Unknown gateway profile '${name}'`);
  const url = requestedUrl ?? profile.url;
  if (!profileForUrl(url, { gateways: { [name]: profile } }))
    throw new Error('Selected profile does not match the requested gateway URL');
  if (profile.authMode !== 'token' || !profile.secret)
    throw new Error('Select an authenticated automation/test profile');
  return { url, credential: { token: profile.secret } };
}

export async function automationGatewayToken(name = process.env.FARMSLOT_GATEWAY_PROFILE) {
  const target = await automationGatewayTarget(process.env.FARMSLOT_GATEWAY, name);
  if (!target) throw new Error('Select an authenticated automation/test gateway profile');
  return target.credential.token;
}
