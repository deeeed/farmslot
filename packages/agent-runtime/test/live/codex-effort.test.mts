import assert from 'node:assert/strict';
import { readFile, rm } from 'node:fs/promises';
import test from 'node:test';

import { DEFAULT_CODEX_EFFORT } from '@farmslot/protocol';
import { codexNativeAdapter } from '../../src/native/codex.js';
import { fixture } from '../../src/native/filesystem-policy.test.js';
import type { NativeAdapterSession } from '../../src/native/types.js';

for (const mode of ['default', 'plan'] as const) {
  test(`Codex ${mode} turns share the configured default and explicit effort`, async () => {
    for (const effort of [undefined, 'max']) {
      const f = await fixture(true);
      let session: NativeAdapterSession | undefined;
      try {
        session = await codexNativeAdapter.start(
          {
            cwd: f.root,
            executable: f.executable,
            model: 'gpt-6.1-sol',
            mode,
            effort,
            approvalMode: 'bypass',
          },
          () => {},
        );
        await session.send('fixture effort request', 'fixture-command');
        const messages = (await readFile(f.requests, 'utf8'))
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line));
        const turn = messages.find((message) => message.method === 'turn/start').params;
        assert.equal(turn.effort, effort ?? DEFAULT_CODEX_EFFORT);
        if (mode === 'plan')
          assert.equal(
            turn.collaborationMode.settings.reasoning_effort,
            effort ?? DEFAULT_CODEX_EFFORT,
          );
      } finally {
        await session?.close();
        await rm(f.root, { recursive: true, force: true });
      }
    }
  });
}

for (const [model, effort] of [
  ['gpt-6.1-sol', 'invalid-level'],
  ['gpt-6-luna', 'ultra'],
]) {
  test(`Codex refuses unsupported ${effort} for ${model} before a turn`, async () => {
    const f = await fixture(true);
    let session: NativeAdapterSession | undefined;
    try {
      await assert.rejects(async () => {
        session = await codexNativeAdapter.start(
          { cwd: f.root, executable: f.executable, model, effort, approvalMode: 'bypass' },
          () => {},
        );
      }, /Invalid Codex reasoning effort/);
      const messages = (await readFile(f.requests, 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      assert.equal(
        messages.some((message) => message.method === 'turn/start'),
        false,
      );
    } finally {
      await session?.close();
      await rm(f.root, { recursive: true, force: true });
    }
  });
}

for (const [model, effort] of [
  ['gpt-6.1-sol', 'ultra'],
  ['gpt-6-luna', 'max'],
]) {
  test(`Codex preserves supported ${effort} for ${model}`, async () => {
    const f = await fixture(true);
    let session: NativeAdapterSession | undefined;
    try {
      session = await codexNativeAdapter.start(
        { cwd: f.root, executable: f.executable, model, effort, approvalMode: 'bypass' },
        () => {},
      );
      await session.send('fixture supported effort', 'fixture-supported');
      const messages = (await readFile(f.requests, 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      assert.equal(
        messages.find((message) => message.method === 'turn/start').params.effort,
        effort,
      );
    } finally {
      await session?.close();
      await rm(f.root, { recursive: true, force: true });
    }
  });
}
