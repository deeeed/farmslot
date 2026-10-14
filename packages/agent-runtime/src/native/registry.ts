import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { claudeProfileEnvironment, observeClaudeAccount } from './account-claude.js';
import { observeCodexAccount } from './account-codex.js';
import { cursorProfileEnvironment, observeCursorAccount } from './account-cursor.js';
import { observeGrokAccount } from './account-grok.js';
import type { NativeAccountObservation, NativeAccountProbeOptions } from './account-types.js';
import { claudeNativeAdapter } from './claude.js';
import { codexNativeAdapter } from './codex.js';
import { cursorNativeAdapter } from './cursor.js';
import { grokNativeAdapter } from './grok.js';
import { hostReviewSandboxAvailable, type NativeProcessSandbox } from './review-sandbox.js';
import type { NativeAdapter } from './types.js';

export interface NativeWorkspaceTrustOptions {
  executable?: string;
  processSandbox?: NativeProcessSandbox;
  inspectionCwd?: string;
}

export const {
  workspaceTrustByRunner,
  codexWorkspaceTrustConfig,
  reviewConfigurationRootsByRunner,
} = createRequire(import.meta.url)('../../scripts/workspace-trust.cjs') as {
  reviewConfigurationRootsByRunner: Record<string, (cwd: string) => string[]>;
  codexWorkspaceTrustConfig(cwd: string, trust: 'trusted' | 'untrusted'): string;
  workspaceTrustByRunner: Record<
    string,
    (
      cwd: string,
      environment: NodeJS.ProcessEnv,
      owner?: string,
      launch?: NativeWorkspaceTrustOptions,
    ) => void
  >;
};

export interface NativeRunnerDefinition {
  adapter: NativeAdapter;
  binary: string;
  supportsWorkers?: boolean;
  /** Only farm-created worker workspaces may receive a persisted native trust decision. */
  trustWorkspace?: (
    cwd: string,
    environment: NodeJS.ProcessEnv,
    owner?: string,
    launch?: NativeWorkspaceTrustOptions,
  ) => void;
  supportsReadOnlyWorkspace?: boolean;
  /** Repository startup configuration cannot execute inside a read-only review. Git blobs stay readable. */
  reviewConfigurationRoots?: (cwd: string) => string[];
  reviewRuntimeRoots?: (environment: NodeJS.ProcessEnv) => string[];
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
    trustWorkspace: workspaceTrustByRunner.codex,
    adapter: codexNativeAdapter,
    binary: 'codex',
    supportsWorkers: true,
    supportsReadOnlyWorkspace: true,
    defaultEffort: 'low',
    account: {
      environment: (directory) => ({ CODEX_HOME: directory }),
      unset: ['OPENAI_API_KEY', 'CODEX_API_KEY'],
      loginArgs: ['login'],
      observe: observeCodexAccount,
    },
  },
  claude: {
    reviewConfigurationRoots: reviewConfigurationRootsByRunner.claude,
    trustWorkspace: workspaceTrustByRunner.claude,
    supportsReadOnlyWorkspace: hostReviewSandboxAvailable(),
    reviewRuntimeRoots: (env) => [
      env.CLAUDE_CONFIG_DIR ?? join(env.HOME ?? homedir(), '.claude'),
      // Claude Code creates its tool-runner scratch directory outside
      // CLAUDE_CONFIG_DIR. Keep that state writable inside the review sandbox.
      ...(typeof process.getuid === 'function' ? [join('/tmp', `claude-${process.getuid()}`)] : []),
    ],
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
    reviewConfigurationRoots: reviewConfigurationRootsByRunner.cursor,
    supportsReadOnlyWorkspace: hostReviewSandboxAvailable(),
    reviewRuntimeRoots: (env) => [
      join(env.HOME ?? homedir(), '.cursor'),
      join(env.HOME ?? homedir(), 'Library/Caches/cursor-compile-cache'),
      join(env.HOME ?? homedir(), 'Library/Application Support/Cursor'),
      // cursor-agent locks chats under /tmp/cursor-agent-persist-<uid> (realpath
      // /private/tmp/...). Denying that mkdir kills the tmux reviewer in seconds.
      ...(typeof process.getuid === 'function'
        ? [join('/tmp', `cursor-agent-persist-${process.getuid()}`)]
        : []),
    ],
    adapter: cursorNativeAdapter,
    binary: 'cursor-agent',
    supportsWorkers: true,
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
    reviewConfigurationRoots: reviewConfigurationRootsByRunner.grok,
    trustWorkspace: workspaceTrustByRunner.grok,
    supportsReadOnlyWorkspace: hostReviewSandboxAvailable(),
    reviewRuntimeRoots: (env) => [env.GROK_HOME ?? join(env.HOME ?? homedir(), '.grok')],
    adapter: grokNativeAdapter,
    binary: 'grok',
    supportsWorkers: true,
    account: {
      environment: (directory) => ({ GROK_HOME: directory }),
      unset: ['GROK_API_KEY', 'XAI_API_KEY'],
      loginArgs: ['login'],
      observe: observeGrokAccount,
    },
  },
};
