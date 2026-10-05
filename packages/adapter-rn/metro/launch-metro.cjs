#!/usr/bin/env node
'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '-h' || arg === '--help') {
      values.help = true;
      continue;
    }
    if (arg === '--clear') {
      values.clear = true;
      continue;
    }
    if (!arg.startsWith('--') || index + 1 >= argv.length)
      throw new Error(`invalid argument: ${arg}`);
    values[arg.slice(2)] = argv[++index];
  }
  return values;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(
      'Usage: launch-metro.cjs --target <path> --port <port> --log <path> --pid-file <path> --build-env <path> --runner <path> [--workers <n>] [--clear]',
    );
    return;
  }
  for (const required of ['target', 'port', 'log', 'pid-file', 'build-env', 'runner']) {
    if (!args[required]) throw new Error(`--${required} is required`);
  }
  const target = path.resolve(args.target);
  const log = path.resolve(args.log);
  const pidFile = path.resolve(args['pid-file']);
  const runner = path.resolve(args.runner);
  fs.mkdirSync(path.dirname(log), { recursive: true });
  fs.mkdirSync(path.dirname(pidFile), { recursive: true });
  const runnerStat = fs.lstatSync(runner);
  if (!runnerStat.isFile()) throw new Error('--runner must be a regular file');
  fs.accessSync(runner, fs.constants.X_OK);
  const env = { ...process.env };
  env.BASH_ENV = args['build-env'];
  if (args.workers) env.METRO_MAX_WORKERS = String(args.workers);
  const child = spawn(runner, [], {
    cwd: target,
    detached: true,
    env,
    stdio: 'ignore',
  });
  await new Promise((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', reject);
  });
  fs.writeFileSync(pidFile, `${String(child.pid)}\n`);
  fs.writeFileSync(
    path.join(path.dirname(pidFile), 'metro-launch.json'),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        pid: child.pid,
        pgid: child.pid,
        startedAt: new Date().toISOString(),
        target,
        port: Number(args.port),
        clear: Boolean(args.clear),
        command: runner,
      },
      null,
      2,
    )}\n`,
  );
  child.unref();
}

main().catch((error) => {
  console.error(`launch-metro: ${error.message}`);
  process.exit(1);
});
