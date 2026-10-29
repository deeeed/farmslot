import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

import * as inventory from './account-inventory.js';
import * as claudeAuth from './claude-auth-status.js';
import * as codexAuth from './codex-auth-status.js';
import * as codexBar from './codexbar-usage.js';
import * as cursorAuth from './cursor-auth-status.js';
import * as grokAuth from './grok-auth-status.js';
import * as host from './provider-account-host.js';
import { makeVars } from './test-fixtures.js';

// Every leaf probe is faked: these tests never execute a provider CLI.
const usage = (runner: string, error?: string) => ({
  provider: runner,
  accountEmail: null,
  remainingPercent: error ? null : 40,
  usedPercent: error ? null : 60,
  resetsAt: null,
  loginMethod: null,
  source: null,
  ...(error ? { error } : {}),
});
mock.module('./codexbar-usage.js', {
  namedExports: {
    ...codexBar,
    probeCodexBarUsageForRunner: async ({ runner }: { runner: string }) =>
      runner === 'claude'
        ? usage(runner, 'rate limited')
        : runner === 'grok'
          ? usage(runner, 'codexbar not found')
          : usage(runner),
  },
});
mock.module('./claude-auth-status.js', {
  namedExports: {
    ...claudeAuth,
    probeClaudeAuthStatus: async () => ({
      loggedIn: true,
      email: 'claude@example.com',
      subscriptionType: 'max',
      authMethod: null,
      orgName: null,
    }),
  },
});
mock.module('./codex-auth-status.js', {
  namedExports: {
    ...codexAuth,
    probeCodexAuthStatus: async () => ({
      loggedIn: false,
      email: null,
      planType: null,
      authMode: null,
      error: 'timeout',
    }),
  },
});
mock.module('./grok-auth-status.js', {
  namedExports: {
    ...grokAuth,
    probeGrokAuthStatus: async () => ({
      loggedIn: false,
      email: null,
      displayName: null,
      authMode: null,
      error: 'auth-file-missing',
    }),
  },
});
mock.module('./cursor-auth-status.js', {
  namedExports: {
    ...cursorAuth,
    probeCursorAuthStatus: async () => ({
      loggedIn: false,
      email: null,
      displayName: null,
      error: 'bash: line 1: cursor-agent: command not found',
    }),
  },
});
mock.module('./account-inventory.js', {
  namedExports: {
    ...inventory,
    probePiAccounts: async () => ({
      status: 'unavailable',
      scope: 'host-default',
      accounts: [],
      error: 'Runner executable unavailable',
    }),
    probeOpenCodeAccounts: async () => ({
      status: 'unavailable',
      scope: 'host-default',
      accounts: [],
      error: 'Account inventory unavailable',
    }),
  },
});
mock.module('./provider-account-host.js', {
  namedExports: {
    ...host,
    hostGetActiveProfile: async () => null,
    hostResolveProviderAccount: async () => {
      throw new Error('provider-account-cli timed out');
    },
  },
});
const { getHostRunnerSubscriptions } = await import('./status-provider.js');

test('subscriptions separate failed probes from definitive absence per component', async () => {
  const vars = makeVars({
    host: 'localhost',
    claudePath: '/nonexistent/claude',
    codexPath: '/nonexistent/codex',
    cursorPath: '/nonexistent/cursor-agent',
    opencodePath: '/nonexistent/opencode',
    piPath: '/nonexistent/pi',
  });
  const outcomes = Object.fromEntries(
    (await getHostRunnerSubscriptions(vars)).map((sub) => [sub.runner, sub.outcome]),
  );
  assert.deepEqual(outcomes, {
    // Identity survives a quota-only CodexBar failure.
    claude: { identity: 'observed', quota: 'failed' },
    // A bind error is a failed identity even when native identity also failed.
    codex: { identity: 'failed', quota: 'observed' },
    // No auth file and no CodexBar install are valid absence.
    grok: { identity: 'absent', quota: 'absent' },
    cursor: { identity: 'absent', quota: 'observed' },
    // A missing optional runner is absent; a fulfilled inventory error is not success.
    pi: { identity: 'absent', quota: 'absent' },
    opencode: { identity: 'failed', quota: 'absent' },
  });
});
