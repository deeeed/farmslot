import { acpRunsToolsUnasked, createAcpAdapter } from './acp.js';
import { type AcpObject, acpObject } from './acp-rpc.js';

/**
 * Grok's cached sign-in, or the home's external auth provider (`auth_provider_command`, which Grok
 * marks `_meta.external_provider`), as a review home uses to share the main login. Never grok.com's
 * interactive login or an API-key fallback.
 */
export function grokAuthMethod(methods: AcpObject[]): string | undefined {
  if (methods.some((method) => method.id === 'cached_token')) return 'cached_token';
  const external = methods.find((method) => {
    const meta = method._meta;
    return (
      typeof meta === 'object' &&
      meta !== null &&
      !Array.isArray(meta) &&
      acpObject(meta).external_provider === true
    );
  });
  return typeof external?.id === 'string' ? external.id : undefined;
}

export const grokNativeAdapter = createAcpAdapter({
  authMethod: grokAuthMethod,
  args: (options) => [
    '--no-auto-update',
    '--permission-mode',
    acpRunsToolsUnasked(options) ? 'bypassPermissions' : 'default',
    'agent',
    '--no-leader',
    ...(options.effort ? ['--reasoning-effort', options.effort] : []),
    'stdio',
  ],
  modes: ['default'],
});
