// Manual only: real Pi TUI, synthetic discovery, private tmux server, no inference.
// node scripts/runner-validation/pi-effort-failfast.live.mjs [pi-cli.js]
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const cli =
  process.argv[2] ??
  join(
    process.env.HOME,
    '.npm-global/lib/node_modules/@earendil-works/pi-coding-agent/dist/cli.js',
  );
const extension =
  process.argv[3] ??
  fileURLToPath(new URL('../runners/pi-farmslot-observability.ts', import.meta.url));
const started = performance.now();
const dir = mkdtempSync(join(tmpdir(), 'pi-failfast-tui-'));
const tmux = (...args) =>
  execFileSync('tmux', ['-L', 'failfast-test', ...args], { encoding: 'utf8' });
const quote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;
const poll = async (predicate) => {
  const deadline = performance.now() + 15_000;
  while (performance.now() < deadline) {
    if (predicate()) return;
    await delay(20);
  }
  throw new Error(`Timed out. Pane: ${tmux('capture-pane', '-p', '-t', 'proof')}`);
};
let ownsServer = false;
let inference = 0;
let releaseDiscovery;
const discoveryGate = new Promise((resolve) => {
  releaseDiscovery = resolve;
});
let discoveryStarted = false;
const server = http.createServer(async (req, res) => {
  res.setHeader('content-type', 'application/json');
  if (req.url === '/v1/models') {
    discoveryStarted = true;
    await discoveryGate;
    res.end(
      JSON.stringify({
        data: [
          {
            id: 'synthetic-model',
            reasoning: false,
            context_length: 8192,
            max_output_tokens: 1024,
          },
        ],
      }),
    );
  } else if (req.url === '/v1/model/info') {
    res.end(JSON.stringify({ data: [] }));
  } else {
    inference++;
    res.writeHead(500);
    res.end(JSON.stringify({ error: 'Inference is forbidden in this fixture' }));
  }
});
// Ctrl-C or a kill skips `finally`; every exit path must stop the private tmux server.
let tornDown = false;
function teardown() {
  if (tornDown) return;
  tornDown = true;
  releaseDiscovery();
  if (ownsServer) tmux('kill-server');
  server.closeAllConnections();
  server.close();
  rmSync(dir, { recursive: true, force: true });
}
for (const [signal, code] of [
  ['SIGINT', 130],
  ['SIGTERM', 143],
  ['SIGHUP', 129],
]) {
  process.once(signal, () => {
    teardown();
    process.exit(code);
  });
}

try {
  // Never touch an existing private test server or the default tmux server.
  assert.notEqual(
    spawnSync('tmux', ['-L', 'failfast-test', 'list-sessions']).status,
    0,
    'private server already exists',
  );
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  mkdirSync(join(dir, 'agent'));
  writeFileSync(join(dir, 'agent/settings.json'), JSON.stringify({ packages: [], skills: [] }));
  const blocker = join(dir, 'startup.ts');
  writeFileSync(
    blocker,
    `
    import { existsSync, writeFileSync } from 'node:fs';
    export default function(pi) {
      pi.on('session_start', async () => {
        writeFileSync(${JSON.stringify(join(dir, 'tui-started'))}, 'ready');
        while (!existsSync(${JSON.stringify(join(dir, 'release-tui'))}))
          await new Promise(resolve => setTimeout(resolve, 10));
      });
    }
  `,
  );
  tmux('-f', '/dev/null', 'new-session', '-d', '-s', 'proof', '-x', '140', '-y', '42', '/bin/sh');
  ownsServer = true;
  tmux('set-option', '-t', 'proof', 'remain-on-exit', 'on');
  tmux('pipe-pane', '-t', 'proof', `cat > ${quote(join(dir, 'terminal.raw'))}`);
  const env = {
    PATH: process.env.PATH,
    HOME: dir,
    TERM: 'xterm-256color',
    PI_CODING_AGENT_DIR: join(dir, 'agent'),
    FARMSLOT_PI_OLLAMA: '0',
    FARMSLOT_THINKING: 'medium',
    FARMSLOT_SLOT_ID: 'synthetic-slot',
    FARMSLOT_OBS_DIR: join(dir, '.agent/.observability'),
    LITELLM_URL: `http://127.0.0.1:${server.address().port}/v1`,
    LITELLM_API_KEY: 'synthetic-key',
  };
  const launch = [
    'env',
    '-i',
    ...Object.entries(env).map(([key, value]) => `${key}=${value}`),
    process.execPath,
    cli,
    '--no-extensions',
    '--no-skills',
    '--no-prompt-templates',
    '--no-themes',
    '--no-mcp',
    '-e',
    blocker,
    '-e',
    extension,
    '--provider',
    'litellm',
    '--model',
    'synthetic-model',
    '--thinking',
    'medium',
  ];
  const script = join(dir, 'launch.sh');
  writeFileSync(
    script,
    `#!/bin/sh\ncd ${quote(dir)}\nstty -g > before.stty\nprintf '%s\\n' \"$$\" > shell-pid\n${launch.map(quote).join(' ')}\nresult=$?\nstty -g > after.stty\nprintf '%s\\n' "$result" > exit-code\n`,
  );
  tmux('send-keys', '-t', 'proof', '-l', `/bin/sh ${quote(script)}`);
  tmux('send-keys', '-t', 'proof', 'Enter');
  await poll(() => discoveryStarted);
  const panePid = tmux('display-message', '-p', '-t', 'proof', '#{pane_pid}').trim();
  const processes = execFileSync('ps', ['-ax', '-o', 'pid=,ppid=,command='], { encoding: 'utf8' });
  const shellPid = readFileSync(join(dir, 'shell-pid'), 'utf8').trim();
  const child = processes
    .split('\n')
    .map((line) => line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/))
    .find((row) => row?.[2] === shellPid);
  assert.ok(
    child && /pi|node/.test(child[3]),
    'real pi is alive during delayed provider discovery',
  );
  assert.ok(Number(panePid) > 0);
  releaseDiscovery();
  await poll(() => existsSync(join(dir, 'tui-started')));
  // Negotiate Kitty support so cleanup proves that protocol is disabled too.
  tmux('send-keys', '-t', 'proof', '-H', '1b', '5b', '3f', '31', '75');
  await poll(() => readFileSync(join(dir, 'terminal.raw'), 'utf8').includes('\x1b[>7u'));
  writeFileSync(join(dir, 'release-tui'), 'go');
  await poll(() => existsSync(join(dir, 'exit-code')));
  assert.equal(readFileSync(join(dir, 'exit-code'), 'utf8').trim(), '1');
  assert.equal(
    readFileSync(join(dir, 'after.stty'), 'utf8'),
    readFileSync(join(dir, 'before.stty'), 'utf8'),
  );
  const raw = readFileSync(join(dir, 'terminal.raw'), 'utf8');
  const pane = tmux('capture-pane', '-p', '-t', 'proof', '-S', '-200');

  assert.ok(raw.lastIndexOf('\x1b[?25h') > raw.lastIndexOf('\x1b[?25l'), 'cursor restored');
  assert.ok(
    raw.lastIndexOf('\x1b[?2004l') > raw.lastIndexOf('\x1b[?2004h'),
    'bracketed paste disabled',
  );
  assert.ok(raw.lastIndexOf('\x1b[<u') > raw.lastIndexOf('\x1b[>7u'), 'Kitty keyboard disabled');
  if (raw.includes('\x1b[>4;2m'))
    assert.ok(
      raw.lastIndexOf('\x1b[>4;0m') > raw.lastIndexOf('\x1b[>4;2m'),
      'modifyOtherKeys disabled',
    );
  assert.equal(tmux('display-message', '-p', '-t', 'proof', '#{cursor_flag}').trim(), '1');
  assert.match(pane, /PI_REASONING_EFFORT_MISMATCH/);
  assert.equal((raw.match(/PI_REASONING_EFFORT_MISMATCH/g) ?? []).length, 1);
  const hooks = readFileSync(join(dir, '.agent/.observability/hooks.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map(JSON.parse);
  assert.equal(hooks.length, 1);
  assert.equal(hooks[0].event, 'StopFailure');
  assert.match(hooks[0].failure, /PI_REASONING_EFFORT_MISMATCH/);
  assert.equal(inference, 0);
  console.log(
    JSON.stringify({
      pi: JSON.parse(readFileSync(resolve(dirname(cli), '../package.json'), 'utf8')).version,
      exit: 1,
      diagnostics: 1,
      inference,
      cursorVisible: true,
      bracketedPaste: false,
      kittyKeyboard: false,
      sttyRestored: true,
      failureHook: 'StopFailure',
      durationMs: Math.round(performance.now() - started),
    }),
  );
} finally {
  teardown();
}
