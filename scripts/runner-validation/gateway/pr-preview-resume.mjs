import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, open, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

assert.equal(process.env.FARMSLOT_ASSESSMENT_VALIDATION, '1');
const out = process.env.PR_PREVIEW_RESUME_OUT,
  port = Number(process.env.PR_PREVIEW_RESUME_PORT);
assert.ok(
  out && Number.isInteger(port) && port > 1024 && port < 65536,
  'Set a new proof directory and a free isolated port',
);
await mkdir(out, { mode: 0o700 });
const root = path.join(out, 'root'),
  bin = path.join(out, 'bin');
for (const dir of [
  bin,
  path.join(root, 'scripts'),
  path.join(root, 'services', 'gateway'),
  path.join(root, 'pool'),
])
  await mkdir(dir, { recursive: true });
await writeFile(path.join(root, 'CLAUDE.md'), '# Isolated validation fixture\n');
await writeFile(path.join(root, 'scripts', 'dev.sh'), '#!/bin/sh\n');
await writeFile(
  path.join(root, 'services', 'gateway', 'package.json'),
  '{"name":"fixture","version":"0.0.0"}',
);
execFileSync('git', ['init', '--initial-branch=fixture-proof', root], { stdio: 'pipe' });
execFileSync(
  'git',
  [
    '-C',
    root,
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '--allow-empty',
    '-m',
    'test: initialize isolated gateway fixture',
  ],
  { stdio: 'pipe' },
);
await writeFile(path.join(out, 'phase'), 'slow-page');
await writeFile(path.join(out, 'requests.jsonl'), '');
const shellQuote = (s) => `'${s.replaceAll("'", "'\\''")}'`;
await writeFile(
  path.join(bin, 'gh'),
  `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(path.resolve('scripts/runner-validation/fixtures/gh-preview-pages.mjs'))} "$@"\n`,
  { mode: 0o700 },
);
const env = {
  ...process.env,
  PATH: `${bin}:${process.env.PATH}`,
  FARMSLOT_ROOT: root,
  FARMSLOT_HOME: path.join(out, 'home'),
  FARMSLOT_POOL_DIR: path.join(root, 'pool'),
  FARMSLOT_DISABLE_ORCHESTRATION: '1',
  FARMSLOT_ASSESSMENT_ENABLED: 'true',
  FARMSLOT_ASSESSMENT_PROVIDER: 'unavailable-proof',
  FARMSLOT_PR_SOURCE_BUDGET_MS: '1500',
  FARMSLOT_GATEWAY_AUTH_MODE: 'token',
  FARMSLOT_GATEWAY_TOKEN: randomUUID(),
  GATEWAY_HOST: '127.0.0.1',
  GATEWAY_PORT: String(port),
  FARMSLOT_GATEWAY: `ws://127.0.0.1:${port}`,
  FARMSLOT_RPC_TIMEOUT_MS: '20000',
  PR_PREVIEW_FIXTURE_DIR: out,
  TSX_TSCONFIG_PATH: path.resolve('services/gateway/tsconfig.json'),
};
delete env.FARMSLOT_GATEWAY_PASSWORD;
let child, log;
function rpc(method, params = {}) {
  return JSON.parse(
    execFileSync(
      process.execPath,
      ['apps/command-center/scripts/cdp.mjs', 'gateway', method, JSON.stringify(params)],
      { env, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 },
    ),
  );
}
async function start() {
  log = await open(path.join(out, 'gateway.log'), 'a');
  child = spawn(process.execPath, ['--import', 'tsx', 'services/gateway/src/index.ts'], {
    env,
    stdio: ['ignore', log.fd, log.fd],
  });
  for (let i = 0; i < 150; i++) {
    if (child.exitCode !== null) throw new Error('Fixture gateway exited; inspect gateway.log');
    try {
      if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) return;
    } catch (e) {
      if (!(e instanceof TypeError)) throw e;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('Fixture gateway did not become ready');
}
async function stop() {
  if (child && child.exitCode === null) {
    const ended = once(child, 'exit');
    child.kill('SIGTERM');
    await ended;
  }
  await log?.close();
  log = undefined;
}
try {
  try {
    await fetch(`http://127.0.0.1:${port}/health`);
    throw new Error('Proof port already occupied');
  } catch (e) {
    if (!(e instanceof TypeError)) throw e;
  }
  const shared = execFileSync(
    process.execPath,
    ['--import', 'tsx', 'scripts/runner-validation/gateway/github-shared-deadline.mts'],
    { env, encoding: 'utf8' },
  );
  console.log(shared.trim());
  await start();
  const { team } = rpc('prRules.teamSave', {
    config: {
      name: 'Deadline fixture',
      account: { host: 'github.com', login: 'fixture-user' },
      sources: [{ kind: 'repository', repo: 'fixture/repo' }],
      predicate: { kind: 'compare', field: 'state', operator: 'equals', value: 'open' },
      repositories: [],
      githubTeams: [],
      notificationPrincipalIds: [],
    },
  });
  const { rule } = rpc('prRules.ruleSave', {
    config: {
      name: 'Deadline fixture',
      teamId: team.id,
      predicate: { kind: 'compare', field: 'draft', operator: 'equals', value: false },
      actions: [{ kind: 'notify' }],
      pollIntervalMs: 60000,
      maxAdmissionsPerScan: 1,
      rereviewOnHeadChange: false,
    },
  });
  const first = rpc('prRules.preview', { id: rule.id }).preview;
  assert.equal(first.complete, false, 'The slow second page must time out');
  assert.equal(first.sourceProgress.pages, 1);
  assert.equal(first.sourceProgress.pendingConnections, 1);
  assert.equal(first.sourceErrors.length, 1);
  await stop();
  await writeFile(path.join(out, 'phase'), 'fast');
  await start();
  const resumed = rpc('prRules.preview', { id: rule.id }).preview;
  assert.equal(resumed.complete, true);
  assert.equal(resumed.sourceProgress.id, first.sourceProgress.id);
  assert.equal(resumed.sourceProgress.pages, 2);
  assert.equal(resumed.items.length, 3);
  const calls = (await readFile(path.join(out, 'requests.jsonl'), 'utf8'))
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));
  assert.equal(
    calls.filter((e) => e.kind === 'page' && e.cursor === null).length,
    1,
    'Restart must not refetch the saved first page',
  );
  await writeFile(path.join(out, 'phase'), 'slow-files');
  const changed = rpc('prRules.ruleSave', {
    id: rule.id,
    revision: rule.revision,
    config: {
      ...rule.config,
      predicate: {
        kind: 'compare',
        field: 'changed-paths',
        operator: 'contains-any',
        value: ['src/a.ts'],
      },
    },
  }).rule;
  const truncated = rpc('prRules.preview', { id: changed.id }).preview;
  assert.equal(truncated.complete, false);
  assert.equal(
    truncated.sourceErrors.length,
    1,
    'Only one paused message may be emitted for 80 remaining candidates',
  );
  assert.equal(rpc('assessment.list', { limit: 1 }).records.length, 0);
  const result = {
    pausedThenResumed: true,
    savedPageNotRefetched: true,
    singlePauseFor80Candidates: true,
    zeroAssessments: true,
  };
  await writeFile(path.join(out, 'proof.json'), JSON.stringify(result, null, 2), { mode: 0o600 });
  console.log(JSON.stringify(result));
} finally {
  await stop();
}
