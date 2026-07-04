#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

function usage(exitCode = 0) {
  const text = [
    'Usage: farmslot-agent <command> [options]',
    '',
    'Commands:',
    '  mark <task-md> <signal-json> <args...>',
    '  artifact-check <task-dir> [args...]',
    '  install-mark <task-dir> [--task TASK.md] [--signal SIGNAL.json]',
    '  contract resolve --flow <flow> [--project-config path] [--mode mode]',
  ].join('\n');
  (exitCode === 0 ? console.log : console.error)(text);
  process.exit(exitCode);
}

function runNode(script, args) {
  const result = spawnSync(process.execPath, [script, ...args], { stdio: 'inherit' });
  process.exit(result.status ?? 1);
}

function parseInstallMarkArgs(args) {
  const parsed = { taskDir: args[0], task: 'TASK.md', signal: 'SIGNAL.json' };
  for (let i = 1; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--task') {
      parsed.task = args[++i] || parsed.task;
    } else if (arg.startsWith('--task=')) {
      parsed.task = arg.slice('--task='.length);
    } else if (arg === '--signal') {
      parsed.signal = args[++i] || parsed.signal;
    } else if (arg.startsWith('--signal=')) {
      parsed.signal = arg.slice('--signal='.length);
    } else {
      usage(2);
    }
  }
  if (!parsed.taskDir) usage(2);
  return parsed;
}

function installMark(args) {
  const parsed = parseInstallMarkArgs(args);
  const taskDir = path.resolve(parsed.taskDir);
  mkdirSync(taskDir, { recursive: true });
  const markPath = path.join(taskDir, 'mark');
  const binPath = path.join(packageRoot, 'bin', 'farmslot-agent.mjs');
  writeFileSync(
    markPath,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"',
      `node ${JSON.stringify(binPath)} mark "$DIR/${parsed.task}" "$DIR/${parsed.signal}" "$@"`,
      '',
    ].join('\n'),
    { mode: 0o755 },
  );
  console.log(`installed ${markPath}`);
}

function parseContractResolveArgs(args) {
  const parsed = { flow: null, mode: null, projectConfig: null };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--flow') parsed.flow = args[++i] || null;
    else if (arg.startsWith('--flow=')) parsed.flow = arg.slice('--flow='.length);
    else if (arg === '--mode') parsed.mode = args[++i] || null;
    else if (arg.startsWith('--mode=')) parsed.mode = arg.slice('--mode='.length);
    else if (arg === '--project-config') parsed.projectConfig = args[++i] || null;
    else if (arg.startsWith('--project-config='))
      parsed.projectConfig = arg.slice('--project-config='.length);
    else usage(2);
  }
  if (!parsed.flow) usage(2);
  return parsed;
}

function resolveContract(args) {
  const parsed = parseContractResolveArgs(args);
  const { resolveWorkerTerminalContract } = require('../scripts/worker-terminal-contract.cjs');
  const projectConfig = parsed.projectConfig
    ? (JSON.parse(readFileSync(path.resolve(parsed.projectConfig), 'utf8')).worker_terminal ?? null)
    : null;
  const contract = resolveWorkerTerminalContract(projectConfig, parsed.flow, {
    mode: parsed.mode,
  });
  console.log(JSON.stringify(contract, null, 2));
}

const [command, subcommand, ...rest] = process.argv.slice(2);
if (!command || command === '--help' || command === '-h') usage(0);

if (command === 'mark') {
  runNode(
    path.join(packageRoot, 'scripts', 'mark-checklist-step.cjs'),
    [subcommand, ...rest].filter((arg) => arg !== undefined),
  );
} else if (command === 'artifact-check') {
  runNode(
    path.join(packageRoot, 'scripts', 'check-task-artifact-contract.mjs'),
    [subcommand, ...rest].filter((arg) => arg !== undefined),
  );
} else if (command === 'install-mark') {
  installMark([subcommand, ...rest].filter((arg) => arg !== undefined));
} else if (command === 'contract' && subcommand === 'resolve') {
  resolveContract(rest);
} else {
  usage(2);
}
