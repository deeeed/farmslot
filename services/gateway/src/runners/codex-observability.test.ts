import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
  buildCodexNativeBindingProbeCommand,
  buildCodexPromptProbeCommand,
  buildCodexSessionIdProbeCommand,
  parseCodexNativeBindingProbe,
  parseCodexPromptProbe,
} from './codex-observability.js';

const prompt = 'Read SELF-REVIEW-FIX.md';

function record(timestamp: string, text: string): string {
  return JSON.stringify({
    timestamp,
    type: 'response_item',
    payload: {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text }],
    },
  });
}

async function writeCodexSession(
  root: string,
  name: string,
  sessionId: string,
  cwd: string,
): Promise<string> {
  const sessionPath = path.join(root, '2026', '08', '21', `${name}.jsonl`);
  await mkdir(path.dirname(sessionPath), { recursive: true });
  await writeFile(
    sessionPath,
    `${JSON.stringify({ type: 'session_meta', payload: { id: sessionId, cwd } })}\n`,
  );
  return sessionPath;
}

test('Codex native probe validates internal session identity and returns a bounded result', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'farmslot-codex-session-probe-'));
  const sessionPath = path.join(root, 'rollout-2026-08-06T09-00-00-session-id.jsonl');
  const sessionId = 'session-id';
  const turnId = 'turn-id';
  const acceptedAt = '2026-08-06T09:01:00.000Z';
  try {
    await writeFile(
      sessionPath,
      [
        JSON.stringify({ type: 'session_meta', payload: { id: sessionId } }),
        JSON.stringify({
          timestamp: acceptedAt,
          type: 'event_msg',
          payload: { type: 'task_started', turn_id: turnId },
        }),
        record(acceptedAt, prompt),
      ].join('\n'),
    );

    const idResult = spawnSync('bash', ['-lc', buildCodexSessionIdProbeCommand(sessionPath)], {
      encoding: 'utf8',
    });
    assert.equal(idResult.status, 0, idResult.stderr);
    assert.deepEqual(JSON.parse(idResult.stdout), { sessionId });

    const matched = spawnSync(
      'bash',
      [
        '-lc',
        buildCodexPromptProbeCommand(
          sessionId,
          sessionPath,
          prompt,
          Date.parse('2026-08-06T09:00:30.000Z'),
        ),
      ],
      { encoding: 'utf8' },
    );
    assert.equal(matched.status, 0, matched.stderr);
    assert.deepEqual(parseCodexPromptProbe(matched.stdout.trim()), {
      status: 'matched',
      observedAt: Date.parse(acceptedAt),
      turnId,
    });
    assert.ok(matched.stdout.length < 100, 'probe must return only a compact structured result');

    const mismatch = spawnSync(
      'bash',
      [
        '-lc',
        buildCodexPromptProbeCommand(
          'different-session',
          sessionPath,
          prompt,
          Date.parse('2026-08-06T09:00:30.000Z'),
        ),
      ],
      { encoding: 'utf8' },
    );
    assert.deepEqual(parseCodexPromptProbe(mismatch.stdout.trim()), {
      status: 'identity-mismatch',
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Codex native binding probe resolves one global-home fallback candidate', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'farmslot-codex-global-binding-'));
  const repo = path.join(root, 'repo');
  const isolated = path.join(repo, '.agent', 'codex-home', 'sessions');
  const global = path.join(root, 'global-sessions');
  await mkdir(repo, { recursive: true });
  const sessionPath = await writeCodexSession(global, 'rollout-global', 'global-session', repo);
  try {
    const result = spawnSync(
      'bash',
      [
        '-lc',
        buildCodexNativeBindingProbeCommand({
          repo,
          isolatedSessionsRoot: isolated,
          globalSessionsRoot: global,
          observedNotBeforeMs: Date.now() - 5_000,
        }),
      ],
      { encoding: 'utf8' },
    );
    assert.equal(result.status, 0, result.stderr);
    const probe = parseCodexNativeBindingProbe(result.stdout.trim());
    assert.equal(probe.status, 'matched');
    if (probe.status === 'matched') {
      assert.equal(probe.sessionId, 'global-session');
      assert.equal(probe.sessionPath, await realpath(sessionPath));
      assert.ok(Math.abs(probe.observedAt - (await stat(sessionPath)).mtimeMs) < 2);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Codex native binding probe honors fresh pane identity and rejects mismatch or ambiguity', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'farmslot-codex-binding-policy-'));
  const repo = path.join(root, 'repo');
  const isolated = path.join(repo, '.agent', 'codex-home', 'sessions');
  const global = path.join(root, 'global-sessions');
  await mkdir(repo, { recursive: true });
  const firstPath = await writeCodexSession(isolated, 'rollout-one', 'session-one', repo);
  const secondPath = await writeCodexSession(global, 'rollout-two', 'session-two', repo);
  const probe = (preferred?: { sessionId: string; sessionPath: string }) => {
    const result = spawnSync(
      'bash',
      [
        '-lc',
        buildCodexNativeBindingProbeCommand({
          repo,
          isolatedSessionsRoot: isolated,
          globalSessionsRoot: global,
          observedNotBeforeMs: Date.now() - 5_000,
          ...(preferred ? { preferred } : {}),
        }),
      ],
      { encoding: 'utf8' },
    );
    assert.equal(result.status, 0, result.stderr);
    return parseCodexNativeBindingProbe(result.stdout.trim());
  };
  try {
    const preferred = probe({ sessionId: 'session-two', sessionPath: secondPath });
    assert.equal(preferred.status, 'matched');
    if (preferred.status === 'matched') {
      assert.equal(preferred.sessionId, 'session-two');
      assert.equal(preferred.sessionPath, await realpath(secondPath));
    }
    assert.deepEqual(probe({ sessionId: 'session-one', sessionPath: secondPath }), {
      status: 'identity-mismatch',
    });
    assert.deepEqual(probe(), { status: 'ambiguous' });
    assert.notEqual(await realpath(firstPath), await realpath(secondPath));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
