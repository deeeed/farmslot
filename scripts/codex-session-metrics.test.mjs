import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Regression: codex session/usage discovery scanned ~/.codex/sessions, but workers run with an
// isolated CODEX_HOME=<repo>/<runtimeDir>/codex-home, so the rollout (with the token usage) lives
// under the slot repo and was never found → run.metrics tokens null → cost breakdown showed 0.
function makeFixtureRollout() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-metrics-'));
  const repo = path.join(base, 'repo');
  const sessDir = path.join(repo, '.sandbox/farmslot-farm/agent/codex-home/sessions/2026/06/30');
  fs.mkdirSync(sessDir, { recursive: true });
  const rollout = path.join(sessDir, 'rollout-proof.jsonl');
  fs.writeFileSync(
    rollout,
    [
      JSON.stringify({ type: 'session_meta', payload: { cwd: repo, model: 'gpt-5.5' } }),
      JSON.stringify({
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            total_token_usage: {
              input_tokens: 1000,
              output_tokens: 200,
              total_tokens: 1200,
              cached_input_tokens: 50,
            },
          },
        },
      }),
    ].join('\n') + '\n',
  );
  return { repo, rollout };
}

test('codex session discovery finds the per-slot codex-home rollout (not ~/.codex)', () => {
  const { repo, rollout } = makeFixtureRollout();
  const src = fs.readFileSync(
    path.join(ROOT, 'services/gateway/src/runners/session-process.ts'),
    'utf8',
  );
  const match = src.match(/python3 - <<'PY'\n([\s\S]*?)\nPY`/);
  assert.ok(match, 'could not extract discovery python from session-process.ts');
  const py = match[1]
    .replace('${JSON.stringify(repo)}', JSON.stringify(repo))
    .replace('${JSON.stringify(runner)}', JSON.stringify('codex'))
    .replace('${JSON.stringify(runtimeDir)}', JSON.stringify('.sandbox/farmslot-farm/agent'));
  const discovered = JSON.parse(execFileSync('python3', ['-c', py], { encoding: 'utf8' }).trim());
  assert.ok(
    discovered.includes(rollout),
    `discovery must find the slot codex-home rollout; got ${JSON.stringify(discovered)}`,
  );
});

test('session-usage.sh extracts token usage from a codex rollout', () => {
  const { rollout } = makeFixtureRollout();
  // Any real slot id works; RUNNER_SESSION_PATH forces the transcript that gets parsed.
  const out = execFileSync(
    'bash',
    [path.join(ROOT, 'scripts/session-usage.sh'), 'macwork-ff-2', 'total'],
    {
      encoding: 'utf8',
      env: { ...process.env, RUNNER_SESSION_PATH: rollout, RUNNER_SESSION_RUNNER: 'codex' },
    },
  );
  assert.match(out, /input_tokens=1000/);
  assert.match(out, /output_tokens=200/);
  assert.match(out, /total_tokens=1200/);
});
