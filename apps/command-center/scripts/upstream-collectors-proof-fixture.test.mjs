import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const fixtureFile = fileURLToPath(
  new URL('./upstream-collectors-proof-fixture.mjs', import.meta.url),
);
const source = fileURLToPath(new URL('../../../', import.meta.url)).replace(/\/$/, '');
const artifacts = mkdtempSync(path.join(tmpdir(), 'upstream-fixture-test-'));
const started = new Set();

/** Live processes whose command line names this case's GitHub fixture server. */
function serverPids(caseRoot) {
  return execFileSync('/bin/ps', ['-axww', '-o', 'pid=,command='], { encoding: 'utf8' })
    .split('\n')
    .filter(
      (line) => line.includes(fixtureFile) && line.includes(' serve ') && line.includes(caseRoot),
    )
    .map((line) => Number(line.trim().split(/\s+/, 1)[0]));
}

function killServers(caseRoot) {
  for (const pid of serverPids(caseRoot)) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch (error) {
      // Gone between the listing and the kill: nothing left to stop.
      if (error.code !== 'ESRCH') throw error;
    }
  }
}

async function poll(check, ceilingMs, what) {
  const deadline = Date.now() + ceilingMs;
  while (!check()) {
    assert(Date.now() < deadline, `${what} within ${ceilingMs} ms`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

after(() => {
  for (const caseRoot of started) killServers(caseRoot);
  rmSync(artifacts, { recursive: true, force: true });
});

/** Runs fixture setup for a fresh case; resolves with its exit code and output once it exits. */
function runSetup(name, prepare = () => undefined) {
  const caseRoot = path.join(artifacts, `d08-upstream-${name}`);
  mkdirSync(caseRoot, { recursive: true });
  started.add(caseRoot);
  prepare(caseRoot);
  const configFile = path.join(artifacts, `${name}.json`);
  writeFileSync(
    configFile,
    JSON.stringify({
      caseRoot,
      sourceRoot: source,
      name: `fixture-${name}`,
      gatewayUrl: 'ws://127.0.0.1:9',
    }),
  );
  const child = spawn(process.execPath, ['--import', 'tsx', fixtureFile, 'setup', configFile], {
    cwd: source,
    env: {
      ...process.env,
      FARMSLOT_OFFLINE_PROOF: '1',
      FARMSLOT_UPSTREAM_COLLECTORS_ARTIFACT_ROOT: artifacts,
      FARMSLOT_ROOT: path.join(caseRoot, 'farm'),
      FARMSLOT_HOME: path.join(caseRoot, 'home'),
      FARMSLOT_RUNS_DIR: path.join(caseRoot, 'home', 'runs'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => (stdout += chunk));
  child.stderr.on('data', (chunk) => (stderr += chunk));
  let exit;
  child.on('exit', (code) => (exit = code));
  return {
    caseRoot,
    child,
    done: () => exit !== undefined,
    result: () => ({ exit, stdout, stderr }),
  };
}

test('fixture setup exits by itself once it has printed its result', async () => {
  const setup = runSetup('exits');
  try {
    await poll(setup.done, 60_000, 'setup exits by itself');
  } finally {
    if (!setup.done()) setup.child.kill('SIGKILL');
  }
  const { exit, stdout, stderr } = setup.result();
  assert.equal(exit, 0, stderr);
  assert.equal(JSON.parse(stdout.trim().split('\n').at(-1)).fixturePrepared, true);
  const fixture = JSON.parse(readFileSync(path.join(setup.caseRoot, 'fixture.json'), 'utf8'));
  assert.deepEqual(serverPids(setup.caseRoot), [fixture.githubHttpPid], 'the server keeps running');
});

test('a setup that fails after starting the server leaves no server process', async () => {
  // fixture.json is written after the server reported its port; a directory there fails it.
  const setup = runSetup('fails', (caseRoot) => mkdirSync(path.join(caseRoot, 'fixture.json')));
  try {
    await poll(setup.done, 60_000, 'failed setup exits');
  } finally {
    if (!setup.done()) setup.child.kill('SIGKILL');
  }
  const { exit, stderr } = setup.result();
  assert.notEqual(exit, 0);
  assert.match(stderr, /EISDIR/);
  await poll(() => serverPids(setup.caseRoot).length === 0, 5_000, 'the server is stopped');
});
