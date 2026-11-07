import { observeClaudeAccount } from './account-claude.js';
import {
  AccountProbeError,
  observeNativeAccount,
  resolveNativeAccountExecutable,
} from './account-common.js';
import type { NativeAccountProbeOptions } from './account-types.js';
import { createAcpAdapter } from './acp.js';
import type { NativeAdapter } from './types.js';

export const CLAUDE_ACP_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

export function claudeAcpBinary(environment: NodeJS.ProcessEnv = process.env): string {
  return environment.FARMSLOT_CLAUDE_ACP_EXECUTABLE || 'claude-agent-acp';
}

const adapter = createAcpAdapter({
  args: () => [],
  modes: ['default', 'plan'],
  // The provider may inherit Auto or Bypass from its profile. Keep it asking, and
  // apply the native session's audited approval policy in the common ACP client.
  defaultModeId: 'default',
  effortConfig: true,
  sessionMetadata: (options) => {
    const policy = {
      ...(options.filesystemPolicy
        ? { settingSources: ['user'], settings: { disableAllHooks: true } }
        : {}),
      ...(options.modelQuestions === 'off' ? { disallowedTools: ['AskUserQuestion'] } : {}),
    };
    return Object.keys(policy).length ? { claudeCode: { options: policy } } : undefined;
  },
});

/** Initial registered agent binding; all RPC, events and approval behavior remain shared. */
export const claudeAcpNativeAdapter: NativeAdapter = {
  ...adapter,
  async start(options, emit) {
    const environment = options.env ?? process.env;
    const executable = await resolveNativeAccountExecutable(
      environment.CLAUDE_CODE_EXECUTABLE || 'claude',
      options,
      environment,
    );
    if (!executable) throw new Error('Install and log into the existing Claude Code CLI first');
    return adapter.start(
      { ...options, env: { ...environment, CLAUDE_CODE_EXECUTABLE: executable } },
      emit,
    );
  },
};

export function observeClaudeAcpAccount(options: NativeAccountProbeOptions) {
  return observeNativeAccount(
    'claude-acp',
    claudeAcpBinary(options.env),
    options,
    async (context) => {
      const executable = await resolveNativeAccountExecutable(
        context.env.CLAUDE_CODE_EXECUTABLE || 'claude',
        context,
        context.env,
      );
      if (!executable) throw new AccountProbeError('executable-unavailable');
      const account = await observeClaudeAccount({ ...context, executable });
      return {
        login: account.login,
        mode: account.mode,
        identity: account.identity,
        identityQuality: account.identityQuality,
        reason: account.reason,
      };
    },
  );
}
