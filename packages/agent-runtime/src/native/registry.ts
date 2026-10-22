import { readFileSync } from 'node:fs';
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

const { grokProfileEnvironment, canResumeGrokProfileContext } = createRequire(import.meta.url)(
  '../../scripts/review-account-preflight.cjs',
) as {
  grokProfileEnvironment(directory: string, base?: NodeJS.ProcessEnv): Record<string, string>;
  canResumeGrokProfileContext(
    previous: Record<string, string>,
    current: Record<string, string>,
    ambientHome: string,
  ): boolean;
};

export interface NativeWorkspaceTrustOptions {
  executable?: string;
  processSandbox?: NativeProcessSandbox;
  inspectionCwd?: string;
}

const workspaceTrust = createRequire(import.meta.url)('../../scripts/workspace-trust.cjs') as {
  claudeReadOnlyReviewArgs: readonly string[];
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

export const {
  workspaceTrustByRunner,
  codexWorkspaceTrustConfig,
  reviewConfigurationRootsByRunner,
} = workspaceTrust;

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
  /** Exclude repository configuration before the sandbox can deny its startup read. */
  reviewStartupArgs?: readonly string[];
  reviewRuntimeRoots?: (environment: NodeJS.ProcessEnv) => string[];
  /** Read-only account inspection before copying support or trusting a review checkout. */
  reviewAccountPreflight?: { script: string; timeoutMs: number };
  /** A runner may admit only its verified migration to a stricter profile environment. */
  canResumeExecutionContext?: (
    previous: Record<string, string>,
    current: Record<string, string>,
    ambientHome: string,
  ) => boolean;
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
    reviewStartupArgs: workspaceTrust.claudeReadOnlyReviewArgs,
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
    canResumeExecutionContext: canResumeGrokProfileContext,
    reviewAccountPreflight: {
      script: `${readFileSync(new URL('../../scripts/review-account-preflight.cjs', import.meta.url), 'utf8')}\ntry { const env = process.argv[2] ? { ...process.env, ...grokProfileEnvironment(process.argv[2]) } : process.env; const selected = process.argv[3] || 'grok'; const executable = selected.startsWith('~/') ? join(process.env.HOME || homedir(), selected.slice(2)) : selected; assertGrokReviewAccount(process.argv[1], env, { executable }); } catch (error) { console.error(error.message); process.exitCode = 1; }`,
      timeoutMs: 15_000,
    },
    reviewConfigurationRoots: reviewConfigurationRootsByRunner.grok,
    trustWorkspace: workspaceTrustByRunner.grok,
    supportsReadOnlyWorkspace: hostReviewSandboxAvailable(),
    reviewRuntimeRoots: (env) => [env.GROK_HOME ?? join(env.HOME ?? homedir(), '.grok')],
    adapter: grokNativeAdapter,
    binary: 'grok',
    supportsWorkers: true,
    account: {
      environment: grokProfileEnvironment,
      unset: ['GROK_API_KEY', 'XAI_API_KEY'],
      loginArgs: ['login'],
      observe: observeGrokAccount,
    },
  },
};
