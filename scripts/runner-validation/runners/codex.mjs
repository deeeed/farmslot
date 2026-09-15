import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { DEFAULT_PROMPT, shSingleQuote } from '../lib/common.mjs';
import { listSessionCandidates, runnerSessionIdForPath } from '../lib/session-attribution.mjs';

export const RUNNER_ID = 'codex';
export const OBSERVABILITY_SCOPE = 'event-driven';
export const OBSERVABILITY_TRANSPORT = 'hooks';

/** Pause the real native server before startup so gateway launch recovery can be exercised. */
export function prepareLaunchBarrier(directory) {
  const executable = execFileSync('which', ['codex'], { encoding: 'utf8' }).trim();
  const marker = path.join(directory, 'native-launch.json');
  const release = path.join(directory, 'native-launch-release');
  fs.writeFileSync(
    path.join(directory, 'codex'),
    `#!/usr/bin/env node
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const args = process.argv.slice(2);
if (args[0] === 'app-server' && !fs.existsSync(${JSON.stringify(release)})) {
  fs.writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ pid: process.pid, args }));
  const deadline = Date.now() + 30000;
  while (!fs.existsSync(${JSON.stringify(release)})) {
    if (Date.now() >= deadline) throw new Error('Native launch barrier timed out');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
  }
}
const result = spawnSync(${JSON.stringify(executable)}, args, { stdio: 'inherit' });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
`,
    { mode: 0o755 },
  );
  return { marker, release };
}

/** Code-mode failures can lack item/commandExecution events. Read their structured tool receipt. */
export function readCommandProbe({ repo, sessionId, command }) {
  const files = listSessionCandidates(RUNNER_ID, repo).filter(
    (file) => runnerSessionIdForPath(RUNNER_ID, file) === sessionId,
  );
  if (files.length !== 1)
    throw new Error('Expected one native transcript for the reviewed workspace');
  const rows = fs
    .readFileSync(files[0], 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line).payload);
  const call = rows.find(
    (row) =>
      row.type === 'custom_tool_call' &&
      row.name === 'exec' &&
      typeof row.input === 'string' &&
      row.input.includes(JSON.stringify(command)),
  );
  if (!call) throw new Error('Native transcript has no command probe call');
  const output = rows.find(
    (row) => row.type === 'custom_tool_call_output' && row.call_id === call.call_id,
  );
  if (!Array.isArray(output?.output))
    throw new Error('Native command probe has no structured output');
  const receipts = output.output
    .filter((entry) => entry.type === 'input_text' && entry.text.trim().startsWith('{'))
    .map((entry) => JSON.parse(entry.text));
  const result = receipts.find((entry) => Number.isInteger(entry.exit_code));
  if (!result) throw new Error('Native command probe has no structured exit code');
  return { sessionId, callId: call.call_id, command, exitCode: result.exit_code, source: files[0] };
}

export const REGISTERED_EVENTS = [
  'SessionStart',
  'PreToolUse',
  'PostToolUse',
  'UserPromptSubmit',
  'PreCompact',
  'PostCompact',
  'Stop',
];

const CODEX_BIN = path.join(
  os.homedir(),
  '.npm-global/lib/node_modules/@openai/codex/bin/codex.js',
);
const DEFAULT_MODEL = 'gpt-6-astra';

export function binaryPath() {
  return CODEX_BIN;
}

export function prepareRepo(repo) {
  execFileSync('git', ['init'], { cwd: repo, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.email', 'runner-validate@farmslot.local'], {
    cwd: repo,
    stdio: 'pipe',
  });
  execFileSync('git', ['config', 'user.name', 'runner-validate'], { cwd: repo, stdio: 'pipe' });
  fs.mkdirSync(path.join(repo, '.codex'), { recursive: true });
  fs.writeFileSync(path.join(repo, '.codex', 'config.toml'), '[features]\nhooks = false\n');
}

export function assertBinary() {
  if (!fs.existsSync(CODEX_BIN)) {
    throw new Error(`codex binary missing: ${CODEX_BIN}`);
  }
}

export function buildLaunchCommand(
  repo,
  runtimeDir,
  prompt = DEFAULT_PROMPT,
  model = DEFAULT_MODEL,
) {
  assertBinary();
  const codexHome = path.join(repo, runtimeDir, 'codex-home');
  if (!fs.existsSync(codexHome)) {
    throw new Error(`codex-home missing after install: ${codexHome}`);
  }
  const modelFlag = model ? ['--model', shSingleQuote(model)] : [];
  return [
    `CODEX_HOME=${shSingleQuote(codexHome)}`,
    'node',
    shSingleQuote(CODEX_BIN),
    '--config',
    'features.hooks=true',
    'exec',
    '--sandbox',
    'workspace-write',
    ...modelFlag,
    shSingleQuote(prompt),
  ].join(' ');
}

/** Production-parity: open the interactive TUI; the gateway submits the prompt separately. */
export function buildInteractiveLaunchCommand(repo, runtimeDir = '.agent', model = DEFAULT_MODEL) {
  assertBinary();
  const codexHome = path.join(repo, runtimeDir, 'codex-home');
  if (!fs.existsSync(codexHome)) {
    throw new Error(`codex-home missing after install: ${codexHome}`);
  }
  return [
    `CODEX_HOME=${shSingleQuote(codexHome)}`,
    'node',
    shSingleQuote(CODEX_BIN),
    '--config',
    'features.hooks=true',
    '--dangerously-bypass-approvals-and-sandbox',
    '--model',
    shSingleQuote(model),
  ].join(' ');
}

export function launchMode() {
  return 'codex-exec';
}

export function interactiveLaunchMode() {
  return 'codex-interactive';
}

export function supportsLiveScenario(scenario) {
  if (scenario === 'mode-switch' || scenario === 'busy-composer') return false;
  return true;
}

export function skipReason(scenario) {
  if (scenario === 'pane-smoke') return 'codex is event-driven; use hook-smoke';
  if (scenario === 'interaction-smoke') return 'codex exec path covered by hook-smoke';
  if (scenario === 'mode-switch') return 'codex exec mode has no interactive permission-mode TUI';
  if (scenario === 'busy-composer') return 'codex has no busy-composer TUI equivalent';
  return null;
}

/** Assert the gateway's persisted command carries the requested or default effort. */
export function assertLaunchEffort(command, effort) {
  // Keep the expected default independent of production so a regression fails this proof.
  const expected = effort?.trim().toLowerCase() || 'high';
  if (expected === 'auto') {
    if (command.includes('model_reasoning_effort')) {
      throw new Error('auto effort must leave the Codex config default untouched');
    }
    return;
  }
  if ((command.match(/model_reasoning_effort=/g) ?? []).length !== 1) {
    throw new Error('expected exactly one Codex effort config argument');
  }
  if (!command.includes(`model_reasoning_effort="${expected}"`)) {
    throw new Error(`launch command does not carry Codex effort ${expected}`);
  }
}
