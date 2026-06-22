import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../../../..');
const scriptPath = path.join(repoRoot, 'scripts/session-usage.sh');

function makeHarness() {
  const root = mkdtempSync(path.join(tmpdir(), 'farmslot-session-usage-'));
  const poolDir = path.join(root, 'pool');
  const repoDir = path.join(root, 'repo');
  mkdirSync(poolDir, { recursive: true });
  mkdirSync(repoDir, { recursive: true });
  writeFileSync(
    path.join(poolDir, 'local.json'),
    JSON.stringify({
      schema_version: 1,
      machine: 'local-test',
      project: 'test-project',
      platform: 'test',
      os: 'darwin',
      host: 'localhost',
      ssh_user: 'tester',
      slots: [
        {
          id: 'test-slot',
          enabled: true,
          repo: repoDir,
          session: 'test-slot',
          resources: {},
        },
      ],
    }),
  );
  return { root, poolDir, repoDir };
}

function runExtractor(runner: string, sessionPath: string, home: string, poolDir: string) {
  return execFileSync('bash', [scriptPath, 'test-slot', 'total'], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: home,
      FARMSLOT_POOL_DIR: poolDir,
      RUNNER_SESSION_RUNNER: runner,
      RUNNER_SESSION_PATH: sessionPath,
    },
  });
}

function runAutoExtractor(home: string, poolDir: string) {
  return execFileSync('bash', [scriptPath, 'test-slot', 'total'], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: home,
      FARMSLOT_POOL_DIR: poolDir,
      RUNNER_SESSION_RUNNER: '',
      RUNNER_SESSION_PATH: '',
    },
  });
}

test('session-usage.sh extracts Claude usage from persisted JSONL', () => {
  const { root, poolDir } = makeHarness();
  const sessionPath = path.join(root, 'claude.jsonl');
  writeFileSync(
    sessionPath,
    `${JSON.stringify({
      type: 'assistant',
      message: {
        model: 'claude-test',
        usage: {
          input_tokens: 10,
          cache_creation_input_tokens: 20,
          cache_read_input_tokens: 30,
          output_tokens: 4,
        },
      },
    })}\n`,
  );

  const stdout = runExtractor('claude', sessionPath, root, poolDir);

  assert.match(stdout, /turns=1/);
  assert.match(stdout, /input_tokens=10/);
  assert.match(stdout, /cache_creation=20/);
  assert.match(stdout, /cache_read=30/);
  assert.match(stdout, /output_tokens=4/);
  assert.match(stdout, /total_tokens=64/);
});

test('session-usage.sh extracts Codex provider total without double-counting detail fields', () => {
  const { root, poolDir } = makeHarness();
  const sessionPath = path.join(root, 'codex.jsonl');
  writeFileSync(
    sessionPath,
    [
      { type: 'session_meta', payload: { cwd: root, model: 'gpt-test' } },
      {
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            total_token_usage: {
              input_tokens: 100,
              cached_input_tokens: 70,
              output_tokens: 12,
              reasoning_output_tokens: 5,
              total_tokens: 112,
            },
          },
        },
      },
    ]
      .map((line) => JSON.stringify(line))
      .join('\n') + '\n',
  );

  const stdout = runExtractor('codex', sessionPath, root, poolDir);

  assert.match(stdout, /input_tokens=100/);
  assert.match(stdout, /cache_read=70/);
  assert.match(stdout, /reasoning_output_tokens=5/);
  assert.match(stdout, /total_tokens=112/);
});

test('session-usage.sh extracts Grok usage by joining summary to unified log', () => {
  const { root, poolDir } = makeHarness();
  const sessionDir = path.join(root, '.grok/sessions/repo/session-1');
  const logDir = path.join(root, '.grok/logs');
  mkdirSync(sessionDir, { recursive: true });
  mkdirSync(logDir, { recursive: true });
  writeFileSync(
    path.join(sessionDir, 'summary.json'),
    JSON.stringify({ info: { id: 'session-1', cwd: root }, current_model_id: 'grok-test' }),
  );
  writeFileSync(
    path.join(logDir, 'unified.jsonl'),
    `${JSON.stringify({
      sid: 'session-1',
      msg: 'shell.turn.inference_done',
      ctx: {
        prompt_tokens: 200,
        cached_prompt_tokens: 50,
        completion_tokens: 30,
        reasoning_tokens: 7,
      },
    })}\n`,
  );

  const stdout = runExtractor('grok', sessionDir, root, poolDir);

  assert.match(stdout, /model=grok-test/);
  assert.match(stdout, /input_tokens=200/);
  assert.match(stdout, /output_tokens=30/);
  assert.match(stdout, /cache_read=50/);
  assert.match(stdout, /reasoning_output_tokens=7/);
  assert.match(stdout, /total_tokens=230/);
});

test('session-usage.sh auto-discovers the newest Grok session for the slot repo', () => {
  const { root, poolDir, repoDir } = makeHarness();
  const encodedRepo = encodeURIComponent(repoDir);
  const oldSessionDir = path.join(root, '.grok/sessions', encodedRepo, 'old-session');
  const newSessionDir = path.join(root, '.grok/sessions', encodedRepo, 'new-session');
  const logDir = path.join(root, '.grok/logs');
  mkdirSync(oldSessionDir, { recursive: true });
  mkdirSync(newSessionDir, { recursive: true });
  mkdirSync(logDir, { recursive: true });
  writeFileSync(
    path.join(oldSessionDir, 'summary.json'),
    JSON.stringify({ info: { id: 'old-session', cwd: repoDir }, current_model_id: 'grok-old' }),
  );
  writeFileSync(
    path.join(newSessionDir, 'summary.json'),
    JSON.stringify({ info: { id: 'new-session', cwd: repoDir }, current_model_id: 'grok-new' }),
  );
  const oldTime = new Date('2026-01-01T00:00:00Z');
  const newTime = new Date('2026-01-02T00:00:00Z');
  utimesSync(oldSessionDir, oldTime, oldTime);
  utimesSync(newSessionDir, newTime, newTime);
  writeFileSync(
    path.join(logDir, 'unified.jsonl'),
    [
      {
        sid: 'old-session',
        msg: 'shell.turn.inference_done',
        ctx: { prompt_tokens: 10, completion_tokens: 1 },
      },
      {
        sid: 'new-session',
        msg: 'shell.turn.inference_done',
        ctx: { prompt_tokens: 40, completion_tokens: 2 },
      },
    ]
      .map((line) => JSON.stringify(line))
      .join('\n') + '\n',
  );

  const stdout = runAutoExtractor(root, poolDir);

  assert.match(stdout, /Session:\s+new-session/);
  assert.match(stdout, /Runner:\s+grok/);
  assert.match(stdout, /model=grok-new/);
  assert.match(stdout, /total_tokens=42/);
});

test('session-usage.sh extracts Cursor usage only from captured headless JSON stdout', () => {
  const { root, poolDir } = makeHarness();
  const sessionPath = path.join(root, 'cursor.json');
  writeFileSync(
    sessionPath,
    JSON.stringify({
      type: 'result',
      usage: {
        inputTokens: 300,
        outputTokens: 40,
        cacheReadTokens: 12,
        cacheWriteTokens: 8,
      },
    }),
  );

  const stdout = runExtractor('cursor', sessionPath, root, poolDir);

  assert.match(stdout, /input_tokens=300/);
  assert.match(stdout, /output_tokens=40/);
  assert.match(stdout, /cache_creation=8/);
  assert.match(stdout, /cache_read=12/);
  assert.match(stdout, /total_tokens=340/);
});
