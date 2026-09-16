import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const scripts = fileURLToPath(
  new URL('../../../../packages/agent-runtime/scripts/', import.meta.url),
);

test('legacy chat recovery requires one exact workspace and creation interval match', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'review-chat-discovery-'));
  const target = path.join(root, 'source');
  const add = (cwd: string, createdAtMs: number) => {
    const id = randomUUID();
    const dir = path.join(root, 'chats', 'workspace', id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, 'meta.json'),
      JSON.stringify({ schemaVersion: 1, hasConversation: true, cwd, createdAtMs }),
    );
    return id;
  };
  const input = { root: path.join(root, 'chats'), cwd: target, startedAt: 100, completedAt: 200 };
  const discover = () =>
    JSON.parse(
      execFileSync(
        process.execPath,
        [path.join(scripts, 'cursor-session-discovery.cjs'), JSON.stringify(input)],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
      ),
    );
  try {
    add(path.join(root, 'unrelated'), 150);
    add(target, 90);
    add(target, 210);
    assert.equal(discover(), null);
    const expected = add(target, 150);
    assert.equal(discover().sessionId, expected);
    add(target, 160);
    assert.throws(discover, /ambiguous/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('session reservation is durable, preserves explicit resume IDs and rejects a different run', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'review-chat-reservation-'));
  const id = randomUUID();
  const input = {
    runId: 'run',
    workspaceId: 'workspace',
    runner: 'cursor',
    cwd: root,
    task: root,
    resumeSessionId: id,
  };
  const reserve = (value: unknown) =>
    JSON.parse(
      execFileSync(
        process.execPath,
        [path.join(scripts, 'review-session.cjs'), JSON.stringify(value)],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
      ),
    );
  try {
    assert.equal(reserve(input).sessionId, id);
    assert.equal(reserve(input).sessionId, id);
    assert.throws(() => reserve({ ...input, runId: 'different' }), /identity changed/);
    assert.throws(
      () => reserve({ ...input, resumeSessionId: randomUUID() }),
      /Retained session changed/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
