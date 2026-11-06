import { acpRunsToolsUnasked, createAcpAdapter } from './acp.js';
import { opencodeQuestionPermission } from './model-questions.js';
import { configureOpenCodeModel } from './opencode-model.js';
import type { NativeAdapterOptions } from './types.js';

/**
 * OpenCode runs its tools without asking unless its permission rules say otherwise. The
 * sandboxed tier asks for every tool through native approvals. Other tiers keep OpenCode's
 * own rules, as the tmux launch does: an `allow` override would also lift its asks for `.env`
 * reads and writes outside the workspace, and the user's denies. A run with model questions
 * off also denies the `question` tool.
 */
export function opencodeEnvironment(options: NativeAdapterOptions): Record<string, string> {
  const permission = {
    ...(acpRunsToolsUnasked(options) ? {} : { '*': 'ask' }),
    ...(options.modelQuestions === 'off' ? opencodeQuestionPermission : {}),
  };
  return {
    OPENCODE_DISABLE_AUTOUPDATE: '1',
    ...(options.filesystemPolicy ? { OPENCODE_DISABLE_PROJECT_CONFIG: 'true' } : {}),
    ...(Object.keys(permission).length ? { OPENCODE_PERMISSION: JSON.stringify(permission) } : {}),
  };
}

export const opencodeNativeAdapter = createAcpAdapter({
  authMethod: 'opencode-login',
  configureModel: configureOpenCodeModel,
  args: () => ['acp'],
  environment: opencodeEnvironment,
  modes: ['default'],
});
