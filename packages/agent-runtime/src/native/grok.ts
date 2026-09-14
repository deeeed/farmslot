import { createAcpAdapter } from './acp.js';

export const grokNativeAdapter = createAcpAdapter({
  authMethod: 'cached_token',
  args: (options) => [
    '--no-auto-update',
    '--permission-mode',
    options.safetyTier && options.safetyTier !== 'sandboxed' ? 'bypassPermissions' : 'default',
    'agent',
    '--no-leader',
    ...(options.effort ? ['--reasoning-effort', options.effort] : []),
    'stdio',
  ],
  modes: ['default'],
});
