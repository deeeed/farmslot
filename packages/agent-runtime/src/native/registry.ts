import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { DEFAULT_CODEX_EFFORT, DEFAULT_PI_THINKING } from '@farmslot/protocol';

import { claudeProfileEnvironment, observeClaudeAccount } from './account-claude.js';
import { observeCodexAccount } from './account-codex.js';
import { cursorProfileEnvironment, observeCursorAccount } from './account-cursor.js';
import { observeGrokAccount } from './account-grok.js';
import { observeOpenCodeAccount, opencodeProfileEnvironment } from './account-opencode.js';
import { observePiAccount, piProfileEnvironment } from './account-pi.js';
import type { NativeAccountObservation, NativeAccountProbeOptions } from './account-types.js';
import { claudeNativeAdapter } from './claude.js';
import { claudeAcpBinary, claudeAcpNativeAdapter, observeClaudeAcpAccount } from './claude-acp.js';
import { codexNativeAdapter } from './codex.js';
import { cursorNativeAdapter } from './cursor.js';
import { grokNativeAdapter } from './grok.js';
import { opencodeNativeAdapter } from './opencode.js';
import { piNativeAdapter } from './pi.js';
import {
  hostReviewSandboxAvailable,
  type NativeProcessSandbox,
  type NativeReviewRuntimeAccess,
} from './review-sandbox.js';
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
  piReadOnlyReviewArgs: readonly string[];
  codexHome(environment: NodeJS.ProcessEnv): string;
  grokHome(environment: NodeJS.ProcessEnv): string;
  reviewConfigurationRootsByRunner: Record<string, (cwd: string) => string[]>;
  reviewRuntimeRootsByRunner: Record<string, (env: NodeJS.ProcessEnv) => string[]>;
  terminalReviewRefusalByRunner: Record<string, string>;
  grokReviewHomeAccess(environment: NodeJS.ProcessEnv): NativeReviewRuntimeAccess;
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
  /** Why this runner cannot take a terminal (tmux) review workspace, when it cannot. */
  terminalReviewRefusal?: string;
  /** When set, all a review may write inside its runtime roots. */
  reviewRuntimeAccess?: (environment: NodeJS.ProcessEnv) => NativeReviewRuntimeAccess;
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
    /** Where a session without a profile reads this runner's login under the node's environment. */
    standardDirectory(environment: NodeJS.ProcessEnv): string;
    environment(directory: string, base?: NodeJS.ProcessEnv): Record<string, string>;
    unset: readonly string[];
    loginArgs: readonly string[];
    observe(options: NativeAccountProbeOptions): Promise<NativeAccountObservation>;
  };
}

const claudeDirectory = (env: NodeJS.ProcessEnv) =>
  env.CLAUDE_CONFIG_DIR || join(env.HOME || homedir(), '.claude');

/** Native profile mechanics stay with the runner definition, not client workflows. */
export const nativeRunnerDefinitions: Record<string, NativeRunnerDefinition> = {
  codex: {
    trustWorkspace: workspaceTrustByRunner.codex,
    adapter: codexNativeAdapter,
    binary: 'codex',
    supportsWorkers: true,
    supportsReadOnlyWorkspace: true,
    reviewRuntimeRoots: workspaceTrust.reviewRuntimeRootsByRunner.codex,
    defaultEffort: DEFAULT_CODEX_EFFORT,
    account: {
      standardDirectory: workspaceTrust.codexHome,
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
    reviewRuntimeRoots: workspaceTrust.reviewRuntimeRootsByRunner.claude,
    adapter: claudeNativeAdapter,
    binary: 'claude',
    supportsWorkers: true,
    account: {
      standardDirectory: claudeDirectory,
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
    reviewRuntimeRoots: workspaceTrust.reviewRuntimeRootsByRunner.cursor,
    adapter: cursorNativeAdapter,
    binary: 'cursor-agent',
    supportsWorkers: true,
    account: {
      standardDirectory: (env) => env.HOME || homedir(),
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
    reviewRuntimeRoots: workspaceTrust.reviewRuntimeRootsByRunner.grok,
    reviewRuntimeAccess: workspaceTrust.grokReviewHomeAccess,
    terminalReviewRefusal: workspaceTrust.terminalReviewRefusalByRunner.grok,
    adapter: grokNativeAdapter,
    binary: 'grok',
    supportsWorkers: true,
    account: {
      standardDirectory: workspaceTrust.grokHome,
      environment: grokProfileEnvironment,
      unset: ['GROK_API_KEY', 'XAI_API_KEY'],
      loginArgs: ['login'],
      observe: observeGrokAccount,
    },
  },
  // Pi and OpenCode sign in per provider: a profile separates their own login stores,
  // while provider keys in the environment still apply.
  opencode: {
    reviewConfigurationRoots: reviewConfigurationRootsByRunner.opencode,
    supportsReadOnlyWorkspace: hostReviewSandboxAvailable(),
    reviewRuntimeRoots: workspaceTrust.reviewRuntimeRootsByRunner.opencode,
    adapter: opencodeNativeAdapter,
    binary: 'opencode',
    supportsWorkers: true,
    account: {
      standardDirectory: (env) => env.XDG_DATA_HOME || join(env.HOME || homedir(), '.local/share'),
      environment: opencodeProfileEnvironment,
      unset: ['OPENCODE_AUTH_CONTENT'],
      loginArgs: ['auth', 'login'],
      observe: observeOpenCodeAccount,
    },
  },
  pi: {
    reviewStartupArgs: workspaceTrust.piReadOnlyReviewArgs,
    reviewConfigurationRoots: reviewConfigurationRootsByRunner.pi,
    supportsReadOnlyWorkspace: hostReviewSandboxAvailable(),
    reviewRuntimeRoots: workspaceTrust.reviewRuntimeRootsByRunner.pi,
    adapter: piNativeAdapter,
    binary: 'pi',
    supportsWorkers: true,
    // The tmux launch's default thinking level.
    defaultEffort: DEFAULT_PI_THINKING,
    account: {
      standardDirectory: (env) =>
        env.PI_CODING_AGENT_DIR || join(env.HOME || homedir(), '.pi/agent'),
      environment: piProfileEnvironment,
      unset: [],
      // Pi signs in from its own `/login` command.
      loginArgs: [],
      observe: observePiAccount,
    },
  },
};

// ACP is a separate registration: existing SDK sessions keep their adapter and identity.
nativeRunnerDefinitions['claude-acp'] = {
  ...nativeRunnerDefinitions.claude,
  adapter: claudeAcpNativeAdapter,
  get binary() {
    return claudeAcpBinary();
  },
  account: {
    ...nativeRunnerDefinitions.claude.account,
    loginArgs: ['--cli', 'auth', 'login'],
    observe: observeClaudeAcpAccount,
  },
};
