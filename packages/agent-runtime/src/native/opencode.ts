import { createAcpAdapter } from './acp.js';
import { configureOpenCodeModel } from './opencode-model.js';

/**
 * OpenCode's ACP server. OpenCode runs its tools without asking unless told to, so the
 * sandboxed tier asks for every tool through ACP approvals and the other tiers allow them.
 */
export const opencodeNativeAdapter = createAcpAdapter({
  authMethod: 'opencode-login',
  configureModel: configureOpenCodeModel,
  args: () => ['acp'],
  environment: (options) => ({
    OPENCODE_DISABLE_AUTOUPDATE: '1',
    OPENCODE_PERMISSION: JSON.stringify({
      '*':
        options.processSandbox || (options.safetyTier && options.safetyTier !== 'sandboxed')
          ? 'allow'
          : 'ask',
    }),
  }),
  modes: ['default'],
});
