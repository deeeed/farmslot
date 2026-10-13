/** Own the web and native dev servers used by the manual fleet client proof. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readSourceProofConnection } from './client-connection.js';

const code = fileURLToPath(new URL('../../', import.meta.url));
const output = path.resolve(process.argv[2]);
const connection = await readSourceProofConnection(output);
const webPort = Number(process.argv[3]);
const metroPort = Number(process.argv[4]);
assert([webPort, metroPort].every((port) => Number.isInteger(port) && port > 1024 && port < 65536));
const env = { ...process.env };
for (const key of Object.keys(env))
  if (/^(FARMSLOT_|GATEWAY_|VITE_|EXPO_PUBLIC_)/.test(key)) delete env[key];
const specs = [
  {
    name: 'web',
    cwd: path.join(code, 'apps/command-center/ui'),
    args: ['workspace', '@farmslot/command-center-ui', 'exec', 'vite', '--host', '127.0.0.1'],
    env: {
      VITE_PORT: String(webPort),
      GATEWAY_PORT: String(connection.port),
      GATEWAY_HOST: '127.0.0.1',
      VITE_FARMSLOT_GATEWAY_URL: `ws://127.0.0.1:${webPort}/ws`,
      VITE_FARMSLOT_GATEWAY_TOKEN: connection.token,
      VITE_FARMSLOT_GATEWAY_PASSWORD: '',
    },
  },
  {
    name: 'native',
    cwd: path.join(code, 'apps/companion'),
    args: ['expo', 'start', '--dev-client', '--localhost', '--port', String(metroPort)],
    env: {
      APP_VARIANT: 'development',
      FARMSLOT_LOCAL_RUNTIME_CONFIG: '1',
      METRO_PORT: String(metroPort),
      GATEWAY_PORT: String(connection.port),
      EXPO_PUBLIC_GATEWAY_URL: `ws://127.0.0.1:${connection.port}`,
      FARMSLOT_REMOTE_GATEWAY_URL: '',
      FARMSLOT_GATEWAY_TOKEN: connection.token,
      FARMSLOT_REMOTE_GATEWAY_TOKEN: '',
      NODE_OPTIONS: `${env.NODE_OPTIONS ?? ''} --dns-result-order=ipv4first`.trim(),
      EXPO_PUBLIC_FARMSLOT_RECIPE_BRIDGE: '1',
      CI: '1',
    },
  },
];
const children: ReturnType<typeof spawn>[] = [];
const logs: ReturnType<typeof createWriteStream>[] = [];
try {
  let stop!: () => void;
  const stopped = new Promise<void>((resolve) => {
    stop = resolve;
  });
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  for (const spec of specs) {
    const log = createWriteStream(path.join(output, `${spec.name}-client.log`));
    const child = spawn('yarn', spec.args, {
      cwd: spec.cwd,
      env: { ...env, ...spec.env },
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    children.push(child);
    logs.push(log);
    child.stdout.pipe(log);
    child.stderr.pipe(log);
    child.once('error', (error) => {
      console.error(error.message);
      process.exitCode = 1;
      stop();
    });
    child.once('close', (code) => {
      if (code) process.exitCode = code;
      stop();
    });
  }
  console.log(JSON.stringify({ webPort, metroPort, gatewayPort: connection.port }));
  await stopped;
} finally {
  for (const child of children)
    if (child.exitCode === null && child.signalCode === null) process.kill(-child.pid!, 'SIGTERM');
  await Promise.all(
    children.map((child) =>
      child.exitCode !== null || child.signalCode !== null
        ? Promise.resolve()
        : new Promise((resolve) => child.once('close', resolve)),
    ),
  );
  for (const log of logs) log.end();
}
