import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { Command } from 'commander';

import { registerInternalCommand } from './internal.js';

test('registered forced session usage needs no private pool', async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'cli-forced-usage-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const pool = path.join(root, 'empty-pool');
  mkdirSync(pool);
  const transcript = path.join(root, 'native.jsonl');
  writeFileSync(
    transcript,
    [
      { type: 'response_item', payload: { type: 'message', role: 'assistant' } },
      {
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: { total_token_usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 } },
        },
      },
    ]
      .map((line) => JSON.stringify(line))
      .join('\n') + '\n',
  );
  const saved = {
    pool: process.env.FARMSLOT_POOL_DIR,
    path: process.env.RUNNER_SESSION_PATH,
    runner: process.env.RUNNER_SESSION_RUNNER,
  };
  process.env.FARMSLOT_POOL_DIR = pool;
  process.env.RUNNER_SESSION_PATH = transcript;
  process.env.RUNNER_SESSION_RUNNER = 'codex';
  t.after(() => {
    for (const [key, value] of Object.entries({
      FARMSLOT_POOL_DIR: saved.pool,
      RUNNER_SESSION_PATH: saved.path,
      RUNNER_SESSION_RUNNER: saved.runner,
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  let output = '';
  const write = t.mock.method(process.stdout, 'write', (chunk: string | Uint8Array) => {
    output += String(chunk);
    return true;
  });
  const program = new Command();
  registerInternalCommand(program);
  await program.parseAsync([
    'node',
    'farmslot',
    'internal',
    'session-usage',
    'unknown-slot',
    'total',
  ]);
  write.mock.restore();
  assert.match(output, /turns=1/);
  assert.match(output, /total_tokens=12/);
});
