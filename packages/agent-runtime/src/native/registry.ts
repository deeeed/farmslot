import { claudeProfileEnvironment, observeClaudeAccount } from './account-claude.js';
import { observeCodexAccount } from './account-codex.js';
import { cursorProfileEnvironment, observeCursorAccount } from './account-cursor.js';
import { observeGrokAccount } from './account-grok.js';
import type { NativeAccountObservation, NativeAccountProbeOptions } from './account-types.js';
import { claudeNativeAdapter } from './claude.js';
import { codexNativeAdapter } from './codex.js';
import { cursorNativeAdapter } from './cursor.js';
import { grokNativeAdapter } from './grok.js';
import type { NativeAdapter } from './types.js';

export interface NativeRunnerDefinition {
  adapter: NativeAdapter;
  binary: string;
  supportsWorkers?: boolean;
  /** Default for new standalone conversations; worker launch settings stay authoritative. */
  defaultEffort?: string;
  account: {
    environment(directory: string, base?: NodeJS.ProcessEnv): Record<string, string>;
    unset: readonly string[];
    loginArgs: readonly string[];
    observe(options: NativeAccountProbeOptions): Promise<NativeAccountObservation>;
  };
}

/** Native profile mechanics stay with the runner definition, not client workflows. */
export const nativeRunnerDefinitions: Record<string, NativeRunnerDefinition> = {
  codex: {
    adapter: codexNativeAdapter,
    binary: 'codex',
    supportsWorkers: true,
    defaultEffort: 'low',
    account: {
      environment: (directory) => ({ CODEX_HOME: directory }),
      unset: ['OPENAI_API_KEY', 'CODEX_API_KEY'],
      loginArgs: ['login'],
      observe: observeCodexAccount,
    },
  },
  claude: {
    adapter: claudeNativeAdapter,
    binary: 'claude',
    supportsWorkers: true,
    account: {
      environment: claudeProfileEnvironment,
      unset: [
        'ANTHROPIC_API_KEY',
        'ANTHROPIC_AUTH_TOKEN',
        'CLAUDE_CODE_OAUTH_TOKEN',
        'CLAUDE_CONFIG_DIR',
        'CLAUDE_SECURESTORAGE_CONFIG_DIR',
      ],
      loginArgs: ['auth', 'login'],
      observe: observeClaudeAccount,
    },
  },
  cursor: {
    adapter: cursorNativeAdapter,
    binary: 'cursor-agent',
    account: {
      environment: cursorProfileEnvironment,
      unset: [
        'CURSOR_API_KEY',
        'CURSOR_AUTH_TOKEN',
        'CURSOR_CONFIG_DIR',
        'CURSOR_DATA_DIR',
        'XDG_CONFIG_HOME',
        'XDG_DATA_HOME',
      ],
      loginArgs: ['login'],
      observe: observeCursorAccount,
    },
  },
  grok: {
    adapter: grokNativeAdapter,
    binary: 'grok',
    account: {
      environment: (directory) => ({ GROK_HOME: directory }),
      unset: ['GROK_API_KEY', 'XAI_API_KEY'],
      loginArgs: ['login'],
      observe: observeGrokAccount,
    },
  },
};
