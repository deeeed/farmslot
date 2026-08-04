import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import {
  getRunnerAttachmentProvider,
  runnerAttachmentUnsupportedDetail,
  runnerSupportsAttachments,
} from './attachment-provider.js';

const CTX = {
  vars: {} as never,
  target: 'slot:worker',
  storedPath: '/repo/slot/.agent/.attachments/att-abc.png',
  filename: 'shot.png',
  byteLength: 1234,
};

test('claude and codex expose verified attachment providers', () => {
  for (const runner of ['claude', 'codex']) {
    const provider = getRunnerAttachmentProvider(runner);
    assert.ok(provider, `${runner} should have a provider`);
    assert.equal(provider.id, runner);
    assert.ok(runnerSupportsAttachments(runner));
    assert.ok(
      provider.buildMessage(CTX).includes(CTX.storedPath),
      `${runner} delivery message must name the staged path`,
    );
  }
});

test('claude uses its @path file reference and codex names the plain path', () => {
  assert.equal(
    getRunnerAttachmentProvider('claude')!.buildMessage(CTX),
    `Look at this image: @${CTX.storedPath}`,
  );
  assert.equal(
    getRunnerAttachmentProvider('codex')!.buildMessage(CTX),
    `View the image at ${CTX.storedPath}`,
  );
});

test('runners without verified behavior are explicitly unsupported', () => {
  for (const runner of ['opencode', 'none', 'scripted', 'cursor', 'grok', 'made-up', null]) {
    assert.equal(getRunnerAttachmentProvider(runner), null, `${runner} must not have a provider`);
    assert.equal(runnerSupportsAttachments(runner), false);
  }
  assert.match(runnerAttachmentUnsupportedDetail('opencode'), /opencode/);
  assert.match(runnerAttachmentUnsupportedDetail(null), /No runner is bound/);
});
