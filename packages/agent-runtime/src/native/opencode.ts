import { acpRunsToolsUnasked, createAcpAdapter } from './acp.js';
import { configureOpenCodeModel } from './opencode-model.js';
import type { NativeAdapterOptions } from './types.js';

/**
 * OpenCode runs its tools without asking unless its permission rules say otherwise. The
 * sandboxed tier asks for every tool through native approvals. Other tiers keep OpenCode's
 * own rules, as the tmux launch does: an `allow` override would also lift its asks for `.env`
 * reads and writes outside the workspace, and the user's denies.
 */
export function opencodeEnvironment(options: NativeAdapterOptions): Record<string, string> {
  return {
    OPENCODE_DISABLE_AUTOUPDATE: '1',
    ...(acpRunsToolsUnasked(options)
      ? {}
      : { OPENCODE_PERMISSION: JSON.stringify({ '*': 'ask' }) }),
  };
}

export const opencodeNativeAdapter = createAcpAdapter({
  authMethod: 'opencode-login',
  configureModel: configureOpenCodeModel,
  args: () => ['acp'],
  environment: opencodeEnvironment,
  modes: ['default'],
});
