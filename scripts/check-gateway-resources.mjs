#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const runCommand = (command, args) =>
  execFileSync(command, args, {
    encoding: 'utf8',
    timeout: 5000,
    maxBuffer: 4 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

function positiveInteger(value, name) {
  if (!/^\d+$/.test(String(value)) || !Number.isSafeInteger(Number(value)) || Number(value) < 1)
    throw new Error(`${name} must be a positive integer.`);
  return Number(value);
}

/** Read metadata only. This guard never signals or restarts the gateway. */
export function checkGatewayResources(options, run = runCommand) {
  const maxFds = positiveInteger(options.maxFds ?? 2048, 'max-fds');
  const maxRssMiB = positiveInteger(options.maxRssMiB ?? 4096, 'max-rss-mib');
  if (Boolean(options.pid) === Boolean(options.port))
    throw new Error('Specify exactly one of --pid or --port.');
  let pid;
  if (options.pid) pid = positiveInteger(options.pid, 'pid');
  else {
    const port = positiveInteger(options.port, 'port');
    if (port > 65535) throw new Error('port must be at most 65535.');
    const listeners = new Set(
      run('lsof', ['-nP', '-t', `-iTCP:${port}`, '-sTCP:LISTEN'])
        .trim()
        .split(/\s+/),
    );
    if (listeners.size !== 1) throw new Error('Expected exactly one listening gateway PID.');
    pid = positiveInteger([...listeners][0], 'listener pid');
  }
  const processInfo = () => {
    const output = run('ps', ['-p', String(pid), '-o', 'lstart=', '-o', 'rss=']).trim();
    const match = /^(\S.*\S)\s+(\d+)$/.exec(output);
    if (!match) throw new Error('Gateway process identity/RSS is unavailable.');
    return { started: match[1].trim(), rssKiB: positiveInteger(match[2], 'RSS') };
  };
  const before = processInfo();
  const output = run('lsof', ['-nP', '-a', '-p', String(pid), '-Ff']);
  const fds = new Set(output.split('\n').filter((line) => /^f\d+$/.test(line))).size;
  if (!fds) throw new Error('Gateway descriptor count is unavailable.');
  const after = processInfo();
  if (before.started !== after.started) throw new Error('Gateway PID changed during measurement.');
  const rssMiB = Math.ceil(Math.max(before.rssKiB, after.rssKiB) / 1024);
  return { ok: fds <= maxFds && rssMiB <= maxRssMiB, pid, fds, rssMiB, maxFds, maxRssMiB };
}

export function main(argv) {
  try {
    const names = {
      '--pid': 'pid',
      '--port': 'port',
      '--max-fds': 'maxFds',
      '--max-rss-mib': 'maxRssMiB',
    };
    const options = {};
    for (let index = 0; index < argv.length; index += 2) {
      const name = names[argv[index]];
      if (!name || argv[index + 1] === undefined || name in options)
        throw new Error(
          'Usage: check-gateway-resources.mjs (--pid PID | --port PORT) [--max-fds N] [--max-rss-mib N]',
        );
      options[name] = argv[index + 1];
    }
    const result = checkGatewayResources(options);
    console.log(`gateway-resources ${result.ok ? 'OK' : 'ALERT'} ${JSON.stringify(result)}`);
    return result.ok ? 0 : 1;
  } catch (error) {
    // Command stderr can contain private process metadata. Report only the failure kind.
    const reason =
      error && typeof error === 'object' && 'cmd' in error
        ? 'metadata probe failed or timed out'
        : error instanceof Error
          ? error.message
          : 'metadata probe failed';
    console.error(`gateway-resources UNAVAILABLE: ${reason}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  process.exitCode = main(process.argv.slice(2));
