import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  buildCopilotLaunch,
  COPILOT_TMUX_TARGET,
  createCopilotRunnerVars,
  resolveOperatorCheckout,
} from './launcher.js';
import { CopilotRuntimeStore } from './session-store.js';

test('launcher uses configured operator checkout and buildLaunchCommand tier flags', async () => {
  const checkout = '/configured/operator/farmslot';
  const home = await mkdtemp(path.join(tmpdir(), 'copilot-launcher-'));
  const launched = buildCopilotLaunch({
    checkout,
    runner: 'cursor',
    model: 'test-model',
    safetyTier: 'sandboxed',
    bootstrapPrompt: 'read bootstrap',
    store: new CopilotRuntimeStore(home),
    runtimeDir: '.sandbox/farmslot-farm/agent',
  });
  assert.equal(launched.vars.remoteRepo, checkout);
  assert.equal(launched.vars.slotId, 'gateway-copilot');
  assert.match(launched.command, /cd '\/configured\/operator\/farmslot'/);
  assert.match(launched.command, /--sandbox enabled/);
  assert.doesNotMatch(launched.command, /dangerously|sandbox disabled/);
  assert.equal(COPILOT_TMUX_TARGET, 'farmslot-copilot:agent.0');

  const hooked = buildCopilotLaunch({
    checkout,
    runner: 'claude',
    model: 'opus',
    safetyTier: 'sandboxed',
    bootstrapPrompt: 'read bootstrap',
    store: new CopilotRuntimeStore(home),
    runtimeDir: '.sandbox/farmslot-farm/agent',
  });
  assert.match(hooked.command, /\.sandbox\/farmslot-farm\/agent/);
});

test('operator checkout resolves from gateway configuration without a user path', () => {
  const previous = process.env.FARMSLOT_OPERATOR_CHECKOUT;
  process.env.FARMSLOT_OPERATOR_CHECKOUT = '/gateway/configured/root';
  try {
    assert.equal(resolveOperatorCheckout(), '/gateway/configured/root');
    assert.equal(createCopilotRunnerVars('/gateway/configured/root').repo, '/gateway/configured/root');
  } finally {
    if (previous === undefined) delete process.env.FARMSLOT_OPERATOR_CHECKOUT;
    else process.env.FARMSLOT_OPERATOR_CHECKOUT = previous;
  }
});

test('local tmux launch normalizes host-specific base indexes before using agent.0', async () => {
  const source = await readFile(new URL('./launcher.ts', import.meta.url), 'utf8');
  assert.match(source, /pane-base-index/);
  assert.match(source, /move-window/);
  assert.match(source, /base-index/);
  assert.match(source, /configureTranscript\(target, transcriptPath\)/);
});
