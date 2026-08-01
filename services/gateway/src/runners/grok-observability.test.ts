import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { execLocal } from '../core/exec.js';
import { shellQuote } from '../core/tmux.js';

import {
  buildGrokPromptSignalProbeCommand,
  createGrokLogObservability,
  parseGrokPromptSignalProbe,
} from './grok-observability.js';
import { makeVars } from './test-fixtures.js';

describe('Grok structured prompt observability', () => {
  it('parses a pane-bound prompt signal', () => {
    assert.deepEqual(
      parseGrokPromptSignalProbe(JSON.stringify({ status: 'matched', promptAcceptedAt: 1234 })),
      { status: 'matched', promptAcceptedAt: 1234 },
    );
  });

  it('accepts a prompt when the bound Grok session signal advances', async () => {
    const observability = createGrokLogObservability(async (_vars, target, sinceMs, promptText) => {
      assert.equal(target, 'core-3:bugfix');
      assert.equal(sinceMs, 1000);
      assert.equal(promptText, 'Read TASK.md');
      return { status: 'matched', promptAcceptedAt: 1200 };
    });

    assert.deepEqual(
      await observability.promptAccepted(
        makeVars(),
        'core-3:bugfix',
        'unused',
        1000,
        false,
        'Read TASK.md',
      ),
      { value: true, source: 'signal', confidence: 'high', observedAt: 1200 },
    );
  });

  it('captures the provider clock for prompt acceptance cutoffs', async () => {
    const observability = createGrokLogObservability(
      async () => ({ status: 'matched', promptAcceptedAt: null }),
      async () => 987_654,
    );

    assert.equal(
      await observability.capturePromptAcceptanceBaseline?.(makeVars(), 'core-3:bugfix'),
      987_654,
    );
  });

  it('falls back without a new signal from one pane-bound session', async () => {
    const noChange = createGrokLogObservability(async () => ({
      status: 'matched',
      promptAcceptedAt: null,
    }));
    const ambiguous = createGrokLogObservability(async () => ({ status: 'ambiguous' }));

    assert.equal(
      (
        await noChange.promptAccepted(
          makeVars(),
          'core-3:bugfix',
          'unused',
          1000,
          false,
          'Read TASK.md',
        )
      )?.value,
      false,
    );
    assert.equal(
      await ambiguous.promptAccepted(
        makeVars(),
        'core-3:bugfix',
        'unused',
        1000,
        false,
        'Read TASK.md',
      ),
      null,
    );
  });

  it('bounds the log scan and binds events to the active session process', () => {
    const command = buildGrokPromptSignalProbeCommand(
      makeVars(),
      'core-3:bugfix',
      1000,
      'Read TASK.md',
    );

    assert.match(command, /max_scan_bytes = 1024 \* 1024/);
    assert.match(command, /quote\(repo, safe=''\)/);
    assert.match(command, /quote\(os\.path\.realpath\(repo\), safe=''\)/);
    assert.match(command, /if len\(candidates\) != 1/);
    assert.match(command, /event\.get\('session_id'\) != candidate\['session_id'\]/);
    assert.match(command, /event_ms < max\(candidate\['opened_at_ms'\], since_ms\)/);
    assert.match(command, /event\.get\('prompt'\) == expected_prompt/);
  });

  it('executes the generated probe against pane-bound Grok fixtures', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'farmslot-grok-probe-'));
    const home = path.join(root, 'home');
    const bin = path.join(root, 'bin');
    const repo = path.join(root, 'repo');
    const sessionId = 'session-1';
    const prompt = 'Read TASK.md';
    const openedAt = '2026-08-01T12:00:00+00:00';
    const acceptedAt = '2026-08-01T12:00:01+00:00';
    const historyDir = path.join(home, '.grok', 'sessions', encodeURIComponent(repo));
    const activePath = path.join(home, '.grok', 'active_sessions.json');
    const historyPath = path.join(historyDir, 'prompt_history.jsonl');

    try {
      await Promise.all([
        mkdir(bin, { recursive: true }),
        mkdir(repo, { recursive: true }),
        mkdir(historyDir, { recursive: true }),
      ]);
      const tmuxPath = path.join(bin, 'tmux');
      const psPath = path.join(bin, 'ps');
      const pythonPath = path.join(bin, 'python3');
      await Promise.all([
        writeFile(tmuxPath, "#!/bin/sh\nprintf '111\\n'\n"),
        writeFile(psPath, "#!/bin/sh\nprintf '111 1\\n222 111\\n223 111\\n333 1\\n'\n"),
        writeFile(pythonPath, '#!/bin/sh\nexec /usr/bin/python3 "$@"\n'),
        writeFile(
          activePath,
          JSON.stringify([{ cwd: repo, pid: 222, session_id: sessionId, opened_at: openedAt }]),
        ),
        writeFile(
          historyPath,
          `${JSON.stringify({ session_id: sessionId, timestamp: acceptedAt, prompt, is_bash: false })}\n{"partial":`,
        ),
      ]);
      await Promise.all([chmod(tmuxPath, 0o755), chmod(psPath, 0o755), chmod(pythonPath, 0o755)]);

      const vars = { ...makeVars(), remoteRepo: repo };
      const runProbe = async () => {
        const command = buildGrokPromptSignalProbeCommand(
          vars,
          'core-3:bugfix',
          Date.parse(openedAt),
          prompt,
        );
        return execLocal(
          `export HOME=${shellQuote(home)}; export PATH=${shellQuote(bin)}:$PATH; ${command}`,
          { cwd: repo },
        );
      };

      const matched = await runProbe();
      assert.equal(matched.exitCode, 0, matched.stderr);
      assert.deepEqual(parseGrokPromptSignalProbe(matched.stdout.trim()), {
        status: 'matched',
        promptAcceptedAt: Date.parse(acceptedAt),
      });

      await writeFile(
        historyPath,
        `${JSON.stringify({
          session_id: sessionId,
          timestamp: '2026-08-01T12:00:02',
          prompt,
          is_bash: false,
        })}\n`,
      );
      const naiveTimestamp = await runProbe();
      assert.deepEqual(parseGrokPromptSignalProbe(naiveTimestamp.stdout.trim()), {
        status: 'matched',
        promptAcceptedAt: null,
      });

      await writeFile(
        activePath,
        JSON.stringify([{ pid: 222, session_id: sessionId, opened_at: openedAt }]),
      );
      const missingCwd = await runProbe();
      assert.deepEqual(parseGrokPromptSignalProbe(missingCwd.stdout.trim()), {
        status: 'unavailable',
      });

      await writeFile(
        activePath,
        JSON.stringify([{ cwd: repo, pid: 333, session_id: sessionId, opened_at: openedAt }]),
      );
      const otherPane = await runProbe();
      assert.deepEqual(parseGrokPromptSignalProbe(otherPane.stdout.trim()), {
        status: 'unavailable',
      });

      await writeFile(
        activePath,
        JSON.stringify([
          { cwd: repo, pid: 222, session_id: sessionId, opened_at: openedAt },
          { cwd: repo, pid: 223, session_id: 'session-2', opened_at: openedAt },
        ]),
      );
      const ambiguous = await runProbe();
      assert.deepEqual(parseGrokPromptSignalProbe(ambiguous.stdout.trim()), {
        status: 'ambiguous',
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
