// Private farm, fake GitHub/runner CLIs and their mutable sources for the upstream collector
// browser proof. Never calls GitHub, a provider or a real runner CLI.
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, readFileSync } from 'node:fs';
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const source = fileURLToPath(new URL('../../../', import.meta.url)).replace(/\/$/, '');
const fixtureFile = fileURLToPath(import.meta.url);
const execute = promisify(execFile);
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const REPO = 'proof/upstream-collectors';
const PR_NUMBER = 7;
// A completed dev run on this PR makes it an owned-family row of the persisted pr.list.
const LIST_PR_NUMBER = 8;
const LIST_BRANCH = 'proof/run-backed-branch';
const PROJECT = 'upstream-proof';
const MACHINE = 'proof-node';
const SLOT = 'proof-node-1';
const FAKE_TOOLS = [
  'gh',
  'claude',
  'codex',
  'cursor-agent',
  'cursor',
  'codexbar',
  'gemini',
  'grok',
  'pi',
  'opencode',
  'ssh',
  'scp',
  'curl',
  'security',
  'tmux',
];

function caseRoot(value) {
  const root = path.resolve(value);
  assert(path.basename(root).startsWith('d08-upstream-'));
  return root;
}

function ghFlags(args) {
  const valued = new Set([
    '-f',
    '-F',
    '-H',
    '-X',
    '-R',
    '-q',
    '-t',
    '--jq',
    '--hostname',
    '--header',
    '--raw-field',
    '--field',
    '--input',
    '--method',
    '--repo',
    '--json',
    '--template',
  ]);
  const positional = [];
  const fields = {};
  const flags = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (valued.has(arg)) {
      const value = args[(index += 1)] ?? '';
      if (['-f', '-F', '--field', '--raw-field'].includes(arg)) {
        const split = value.indexOf('=');
        fields[value.slice(0, split)] = value.slice(split + 1);
      } else flags[arg] = value;
    } else if (arg.startsWith('-')) flags[arg] = true;
    else positional.push(arg);
  }
  return { positional, fields, flags };
}

/** One answer per invocation, from the case's current source state. */
function answer(state, tool, args) {
  const ok = (sourceName, stdout) => ({ source: sourceName, outcome: 'ok', stdout, code: 0 });
  const failed = (sourceName) => ({
    source: sourceName,
    outcome: 'failed',
    stdout: '',
    // Raw failure text deliberately carries a marker and a token-shaped value.
    stderr: `fake ${tool} failed: ${state.marker} token=${state.github.token} auth=${state.authPath}\n`,
    code: 1,
  });
  const unsupported = () => ({
    source: 'unsupported',
    outcome: 'unsupported',
    stdout: '',
    stderr: `fake ${tool}: no fixture answer\n`,
    code: 1,
  });
  // No terminal server exists for this case; callers treat exit 1 as an empty server.
  if (tool === 'tmux')
    return {
      source: 'tmux',
      outcome: 'no-server',
      stdout: '',
      stderr: 'no server running on fake socket\n',
      code: 1,
    };
  if (tool === 'gh') {
    const { positional, fields, flags } = ghFlags(args);
    const [command, sub] = positional;
    if (command === 'auth' && sub === 'status') {
      if (state.github.fail) return failed('github-accounts');
      return ok(
        'github-accounts',
        JSON.stringify({
          hosts: {
            'github.com': state.github.accounts.map((account) => ({
              state: 'success',
              active: account.active,
              host: 'github.com',
              login: account.login,
              tokenSource: 'keyring',
              token: state.github.token,
              scopes: 'repo',
              gitProtocol: 'https',
            })),
          },
        }) + '\n',
      );
    }
    const http = (body) =>
      flags['--include'] || flags['-i']
        ? `HTTP/2.0 200 OK\r\nContent-Type: application/json; charset=utf-8\r\nX-Github-Request-Id: FAKE\r\n\r\n${body}`
        : body;
    if (command === 'api' && sub === 'user')
      return ok('github-user', http(state.github.accounts[0].login + '\n'));
    // The monitored PR feeds pr.status; the run-backed PR feeds pr.list.
    const repo =
      command === 'api'
        ? sub === 'graphql'
          ? `${fields.owner}/${fields.name}`
          : sub?.split('/').slice(1, 3).join('/')
        : flags['--repo'];
    const number = Number(
      command === 'api' ? (sub === 'graphql' ? fields.pr : sub?.split('/')[4]) : positional[2],
    );
    const pr = [state.pr, state.listPr].find(
      (candidate) => candidate.repo === repo && candidate.number === number,
    );
    if (!pr) return unsupported();
    const label = pr === state.pr ? 'pr-detail' : 'pr-list';
    if (command === 'pr' && ['view', 'checks'].includes(sub)) {
      if (pr.fail) return failed(label);
      if (sub === 'checks')
        return ok(
          label + ':checks',
          pr.checks
            .map((check) =>
              [check.name, check.bucket, check.startedAt, check.completedAt, check.state, ''].join(
                '\t',
              ),
            )
            .join('\n') + '\n',
        );
      return ok(
        label + ':view',
        [
          'OPEN',
          'MERGEABLE',
          'CLEAN',
          'REVIEW_REQUIRED',
          pr.head,
          pr.createdAt,
          pr.updatedAt,
          '',
          '',
          pr.title,
        ].join('\t') +
          '\n' +
          pr.author +
          '\n',
      );
    }
    if (command === 'api') {
      const prefix = `repos/${pr.repo}/`;
      if (pr.fail) return failed(label);
      if (sub === `${prefix}issues/${pr.number}/comments`) return ok(label + ':comments', '');
      if (sub === `${prefix}pulls/${pr.number}/commits`)
        return ok(label + ':commits', http(pr.updatedAt + '\n'));
      if (sub === 'graphql' && fields.query.includes('latestOpinionatedReviews'))
        return ok(label + ':reviews', http(''));
      if (sub === 'graphql' && fields.query.includes('reviewThreads'))
        return ok(label + ':threads', flags['--paginate'] ? '' : http('{"data":{}}'));
    }
    return unsupported();
  }
  if (tool === 'claude' && args.join(' ') === 'auth status --json') {
    if (state.seats.fail) return failed('seats:claude');
    return ok(
      'seats:claude',
      JSON.stringify({
        loggedIn: true,
        email: state.seats.claudeEmail,
        subscriptionType: 'max',
        authMethod: 'claude.ai',
      }) + '\n',
    );
  }
  if (tool === 'codexbar' && args[0] === 'usage') {
    const provider = args[args.indexOf('--provider') + 1];
    if (state.seats.fail) return failed('seats:codexbar');
    if (provider !== 'claude')
      return ok(
        'seats:codexbar',
        JSON.stringify([{ provider, error: { message: 'no-codexbar-provider' } }]) + '\n',
      );
    return ok(
      'seats:codexbar',
      JSON.stringify([
        {
          provider,
          source: 'oauth',
          usage: {
            accountEmail: state.seats.claudeEmail,
            loginMethod: 'max',
            primary: { usedPercent: state.seats.usedPercent, resetsAt: state.seats.resetsAt },
          },
        },
      ]) + '\n',
    );
  }
  if (tool === 'codex' && args.join(' ') === 'login status')
    return ok('seats:codex', `Logged in using ChatGPT (${state.seats.codexEmail})\n`);
  if (tool === 'cursor-agent' && args.join(' ') === 'status --format json')
    return ok(
      'seats:cursor',
      JSON.stringify({ isAuthenticated: true, userInfo: { email: state.seats.cursorEmail } }) +
        '\n',
    );
  return unsupported();
}

/** Detached intermediate shells start their own group, so the audit follows the live parent chain. */
function ancestry(pid) {
  const table = new Map(
    execFileSync('/bin/ps', ['-A', '-o', 'pid=,ppid=,pgid='], { encoding: 'utf8' })
      .trim()
      .split('\n')
      .map((line) => line.trim().split(/\s+/).map(Number))
      .map(([id, ppid, pgid]) => [id, { pid: id, ppid, pgid }]),
  );
  const chain = [];
  for (let row = table.get(pid); row && chain.length < 6; row = table.get(row.ppid)) {
    chain.push(row);
    if (row.ppid <= 1) break;
  }
  return chain;
}

async function fake([root, tool, ...args]) {
  const directory = caseRoot(root);
  const state = JSON.parse(readFileSync(path.join(directory, 'fake', 'state.json'), 'utf8'));
  const reply = FAKE_TOOLS.includes(tool)
    ? answer(state, tool, args)
    : { source: 'unsupported', outcome: 'unsupported', stdout: '', code: 1 };
  appendFileSync(
    path.join(directory, 'fake-invocations.jsonl'),
    JSON.stringify({
      tool,
      args: args.map((arg) => (arg.length > 160 ? arg.slice(0, 160) + '…' : arg)),
      source: reply.source,
      outcome: reply.outcome,
      stateRevision: state.revision,
      at: Date.now(),
      pid: process.pid,
      ppid: process.ppid,
      ancestry: ancestry(process.pid),
      cwd: process.cwd(),
      path: process.env.PATH,
      home: process.env.HOME,
    }) + '\n',
  );
  process.stdout.write(reply.stdout ?? '');
  process.stderr.write(reply.stderr ?? '');
  process.exitCode = reply.code;
}

const TRANSITIONS = {
  'pr-change': (state) => {
    state.pr.title = 'Offline upstream collectors proof (source revised)';
    state.pr.updatedAt = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
    state.pr.checks = state.pr.checks.map((check) => ({
      ...check,
      bucket: 'pass',
      state: 'SUCCESS',
      completedAt: check.completedAt || state.pr.updatedAt,
    }));
  },
  'pr-fail': (state) => {
    state.pr.fail = true;
  },
  'pr-repair': (state) => {
    state.pr.fail = false;
  },
  'accounts-change': (state) => {
    state.github.accounts = [...state.github.accounts, { login: 'proof-second', active: false }];
  },
  'accounts-fail': (state) => {
    state.github.fail = true;
  },
  'accounts-repair': (state) => {
    state.github.fail = false;
  },
  'seats-change': (state) => {
    state.seats.claudeEmail = 'seat-b@example.invalid';
    state.seats.usedPercent = 64;
  },
  'seats-fail': (state) => {
    state.seats.fail = true;
  },
  'seats-repair': (state) => {
    state.seats.fail = false;
  },
};

if (process.argv[2] === 'fake') {
  await fake(process.argv.slice(3));
} else {
  assert.equal(process.env.FARMSLOT_OFFLINE_PROOF, '1');
  const [mode, configFile, transition] = process.argv.slice(2);
  const config = JSON.parse(await readFile(configFile, 'utf8'));
  const root = caseRoot(config.caseRoot);
  assert(process.env.FARMSLOT_UPSTREAM_COLLECTORS_ARTIFACT_ROOT);
  assert.equal(
    path.dirname(root),
    path.resolve(process.env.FARMSLOT_UPSTREAM_COLLECTORS_ARTIFACT_ROOT),
  );
  assert.notEqual(root, source);
  const farm = path.join(root, 'farm');
  const home = path.join(root, 'home');
  const osHome = path.join(root, 'os-home');
  const upstream = path.join(root, 'upstream');
  const slotRepo = path.join(root, 'slot-repo');
  const fakeBin = path.join(root, 'fakebin');
  const stateFile = path.join(root, 'fake', 'state.json');
  const git = async (directory, ...args) =>
    (await execute('/usr/bin/git', args, { cwd: directory, timeout: 20000 })).stdout.trim();
  const save = async (name, value) => {
    const file = path.join(root, name);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  };
  const put = async (file, value) => {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(
      file,
      typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n',
    );
  };
  if (mode === 'setup') {
    assert.equal(config.sourceRoot, source);
    assert.equal(path.resolve(process.env.FARMSLOT_ROOT), farm);
    assert.equal(path.resolve(process.env.FARMSLOT_HOME), home);
    // The farm is its own private checkout so gateway Git reads never reach a parent or network remote.
    await mkdir(upstream, { recursive: true });
    await git(upstream, '-c', 'init.defaultBranch=main', 'init');
    await git(upstream, 'config', 'user.name', 'Offline proof');
    await git(upstream, 'config', 'user.email', 'offline-proof@invalid');
    for (const [name, text] of Object.entries({
      'CLAUDE.md': 'Private upstream collector fixture.\n',
      'scripts/dev.sh': '#!/bin/sh\nexit 0\n',
      'services/gateway/package.json': JSON.stringify({
        name: '@farmslot/gateway',
        version: '0.0.1-proof',
      }),
      '.gitignore': '.farm-cache/\n.farm-status.json\n.runs/\npool/\nprojects/\n.pr-*.json\n',
    }))
      await put(path.join(upstream, name), text);
    await git(upstream, 'add', '.');
    await git(upstream, '-c', 'commit.gpgSign=false', 'commit', '-m', 'chore: seed private farm');
    await git(root, 'clone', upstream, farm);
    await mkdir(slotRepo, { recursive: true });
    await git(slotRepo, '-c', 'init.defaultBranch=main', 'init');
    await put(path.join(farm, 'projects', PROJECT, 'project.json'), {
      name: PROJECT,
      runtime_dir: '.agent',
      artifact_dir: 'artifacts',
      resources: {},
      ci: { repo: REPO },
    });
    await put(path.join(farm, 'pool', `${MACHINE}.json`), {
      schema_version: 2,
      machine: MACHINE,
      project: PROJECT,
      platform: 'web',
      os: 'darwin',
      host: 'localhost',
      ssh_user: 'proof',
      slots: [{ id: SLOT, enabled: true, mode: 'custom', repo: slotRepo, session: SLOT }],
    });
    await put(path.join(farm, '.farm-status.json'), {
      checked_at: new Date().toISOString(),
      slots: [
        {
          slot: SLOT,
          machine: MACHINE,
          project: PROJECT,
          platform: 'web',
          repo: slotRepo,
          enabled: true,
          lifecycle: 'custom',
          mode: 'custom',
          agent: 'idle',
          session: SLOT,
        },
      ],
    });
    await mkdir(osHome, { recursive: true, mode: 0o700 });
    await mkdir(home, { recursive: true });
    const { CredentialStoreRuntime, CredentialStoreWriter } =
      await import('../../../packages/credential-store/src/index.ts');
    const { saveProfiles } = await import('../../../packages/cli/src/gateway-profiles.ts');
    const writer = new CredentialStoreWriter(
      new CredentialStoreRuntime({ ...process.env, FARMSLOT_HOME: home }),
      true,
    );
    const roles = [{ role: 'admin', scope: { kind: 'global' } }];
    const custodian = writer.createPrincipal(
      { type: 'service', displayName: config.name + '-custodian' },
      roles,
    );
    writer.issueCredential(custodian.id, 'private fixture retirement custodian');
    const actor = writer.createPrincipal(
      { type: 'service', displayName: config.name + '-actor' },
      roles,
    );
    const issued = writer.issueCredential(actor.id, 'private upstream collector browser');
    const profileFile = path.join(home, 'gateways.json');
    saveProfiles(
      {
        active: config.name,
        gateways: {
          [config.name]: { url: config.gatewayUrl, authMode: 'token', secret: issued.secret },
        },
      },
      profileFile,
    );
    // A paused, never-polled monitor puts the PR on the actual board without list status.
    const { PRMonitorStore } = await import('../../../services/gateway/src/pr-monitoring/store.ts');
    const { runWithPrincipalOwner } =
      await import('../../../services/gateway/src/security/work-originator.ts');
    const monitor = await runWithPrincipalOwner(
      { ownerId: actor.id, ownerGeneration: actor.generation ?? 0 },
      async () => {
        const monitors = await PRMonitorStore.load(path.join(farm, '.pr-monitors.json'));
        const created = await monitors.subscribe(actor.id, {
          pr: { host: 'github.com', repo: REPO, number: PR_NUMBER },
          account: { host: 'github.com', login: 'proof-primary' },
          project: PROJECT,
          policy: { mode: 'notify-only' },
          pollIntervalMs: 300000,
          watchedChecks: [],
          automaticAttemptLimit: 1,
          cooldownMs: 300000,
        });
        return monitors.setLifecycle(created.id, actor.id, created.revision, 'paused');
      },
    );
    const runsDirectory = path.join(home, 'runs');
    assert.equal(path.resolve(process.env.FARMSLOT_RUNS_DIR), runsDirectory);
    const runId = 'upstream-proof-' + randomUUID();
    const runAt = new Date(Date.now() - 10 * 60_000).toISOString();
    // Completed run metadata only: no task, session, worker or command.
    await put(path.join(runsDirectory, `${runId}.json`), {
      id: runId,
      familyId: runId,
      parentRunId: null,
      familyRootTicketOrPr: 'Upstream collector run-backed PR',
      lane: 'production',
      variant: null,
      flowType: 'dev',
      mode: 'interactive',
      status: 'done',
      project: PROJECT,
      ticketOrPr: 'Upstream collector run-backed PR',
      slotId: SLOT,
      branch: LIST_BRANCH,
      prNumber: LIST_PR_NUMBER,
      steps: [{ name: 'complete', status: 'done' }],
      decisions: [],
      metrics: {
        nudgeCount: 0,
        model: null,
        runner: null,
        runnerSessionId: null,
        runnerSessionPath: null,
      },
      createdAt: runAt,
      updatedAt: runAt,
      completedAt: runAt,
    });
    const profileInfo = await lstat(profileFile);
    await save('actor.json', {
      principalId: actor.id,
      credentialId: issued.record.id,
      custodianId: custodian.id,
      profile: {
        path: profileFile,
        dev: profileInfo.dev,
        ino: profileInfo.ino,
        sha256: digest(await readFile(profileFile)),
      },
    });
    const node = await realpath(process.execPath);
    const marker = 'FAKE-RAW-STDERR-' + randomUUID();
    await put(stateFile, {
      revision: 0,
      marker,
      authPath: path.join(osHome, '.config', 'fake-auth.json'),
      github: {
        token: 'gho_FAKE' + randomUUID().replaceAll('-', ''),
        accounts: [{ login: 'proof-primary', active: true }],
        fail: false,
      },
      pr: {
        repo: REPO,
        number: PR_NUMBER,
        title: 'Offline upstream collectors proof',
        author: 'proof-author',
        head: 'proof/upstream-branch',
        createdAt: '2026-10-20T10:00:00Z',
        updatedAt: '2026-10-21T09:00:00Z',
        checks: [
          {
            name: 'build',
            bucket: 'pass',
            state: 'SUCCESS',
            startedAt: '2026-10-21T09:01:00Z',
            completedAt: '2026-10-21T09:05:00Z',
          },
          {
            name: 'lint',
            bucket: 'pending',
            state: 'IN_PROGRESS',
            startedAt: '2026-10-21T09:01:00Z',
            completedAt: '',
          },
        ],
        fail: false,
      },
      listPr: {
        repo: REPO,
        number: LIST_PR_NUMBER,
        title: 'Run-backed upstream collector proof',
        author: 'proof-author',
        head: LIST_BRANCH,
        createdAt: '2026-10-22T10:00:00Z',
        updatedAt: '2026-10-23T09:00:00Z',
        checks: [
          {
            name: 'build',
            bucket: 'pass',
            state: 'SUCCESS',
            startedAt: '2026-10-23T09:01:00Z',
            completedAt: '2026-10-23T09:05:00Z',
          },
        ],
        fail: false,
      },
      seats: {
        claudeEmail: 'seat-a@example.invalid',
        codexEmail: 'seat-codex@example.invalid',
        cursorEmail: 'seat-cursor@example.invalid',
        usedPercent: 30,
        resetsAt: '2026-10-27T00:00:00Z',
        fail: false,
      },
    });
    await mkdir(fakeBin, { recursive: true });
    const quote = (value) => `'${value.replaceAll("'", `'\\''`)}'`;
    for (const tool of FAKE_TOOLS) {
      const file = path.join(fakeBin, tool);
      await writeFile(
        file,
        `#!/bin/sh\nexec ${quote(node)} ${quote(fixtureFile)} fake ${quote(root)} ${tool} "$@"\n`,
      );
      await chmod(file, 0o700);
    }
    // Local Git stays real (private farm only) but every call is recorded.
    await writeFile(
      path.join(fakeBin, 'git'),
      '#!/usr/bin/python3\nimport os,sys,time,json,subprocess\n' +
        'rows={int(p):(int(pp),int(g)) for p,pp,g in (l.split() for l in subprocess.run(["/bin/ps","-A","-o","pid=,ppid=,pgid="],capture_output=True,text=True).stdout.splitlines())}\n' +
        'chain=[];cur=os.getpid()\n' +
        'while cur in rows and len(chain)<6:\n chain.append({"pid":cur,"ppid":rows[cur][0],"pgid":rows[cur][1]});cur=rows[cur][0]\n' +
        `with open(${JSON.stringify(path.join(root, 'git-invocations.jsonl'))},"a") as f:` +
        'f.write(json.dumps({"args":sys.argv[1:],"at":time.time(),"cwd":os.getcwd(),"ppid":os.getppid(),"ancestry":chain})+"\\n")\n' +
        'os.execv("/usr/bin/git",["git",*sys.argv[1:]])\n',
    );
    await chmod(path.join(fakeBin, 'git'), 0o700);
    await symlink(node, path.join(fakeBin, 'node'));
    await save('fixture.json', {
      ...config,
      farm,
      home,
      osHome,
      fakeBin,
      stateFile,
      node,
      marker,
      tools: FAKE_TOOLS,
      repo: REPO,
      pr: PR_NUMBER,
      listPr: LIST_PR_NUMBER,
      runId,
      project: PROJECT,
      machine: MACHINE,
      slotId: SLOT,
      actorId: actor.id,
      monitorId: monitor.id,
      setupComplete: true,
      fixtureOnly: true,
      providerExecution: false,
    });
    console.log(JSON.stringify({ fixturePrepared: true, actorId: actor.id, fakeBin }));
  } else {
    const fixture = JSON.parse(await readFile(path.join(root, 'fixture.json'), 'utf8'));
    assert(fixture.setupComplete && fixture.farm === farm && fixture.sourceRoot === source);
    if (mode === 'cleanup') {
      const actor = JSON.parse(await readFile(path.join(root, 'actor.json'), 'utf8'));
      assert.equal(actor.profile.path, path.join(home, 'gateways.json'));
      const info = await lstat(actor.profile.path);
      assert(info.isFile() && !info.isSymbolicLink());
      assert.equal(info.dev, actor.profile.dev);
      assert.equal(info.ino, actor.profile.ino);
      assert.equal(info.mode & 0o777, 0o600);
      assert.equal(digest(await readFile(actor.profile.path)), actor.profile.sha256);
      const { CredentialStoreRuntime, CredentialStoreWriter } =
        await import('../../../packages/credential-store/src/index.ts');
      const runtime = new CredentialStoreRuntime({ ...process.env, FARMSLOT_HOME: home });
      const writer = new CredentialStoreWriter(runtime, true);
      assert.equal(runtime.findCredential(actor.credentialId)?.principalId, actor.principalId);
      writer.revokeCredential(actor.credentialId);
      const retirement = writer.retirePrincipals([actor.principalId]);
      assert.equal(runtime.findPrincipal(actor.principalId), undefined);
      assert(runtime.findPrincipal(actor.custodianId));
      await unlink(actor.profile.path);
      await save('credential-cleanup.json', {
        actorRetired: true,
        credentialRevoked: true,
        exactProfileRemoved: true,
        custodianPreserved: true,
        retirement,
      });
      console.log(JSON.stringify({ credentialRetired: true }));
    } else if (mode === 'source') {
      const apply = TRANSITIONS[transition];
      assert(apply, 'Unknown fake source transition');
      const state = JSON.parse(await readFile(stateFile, 'utf8'));
      apply(state);
      state.revision += 1;
      await writeFile(stateFile + '.tmp', JSON.stringify(state, null, 2) + '\n');
      await rename(stateFile + '.tmp', stateFile);
      const record = { transition, revision: state.revision, at: Date.now() };
      await save(`source/${String(state.revision).padStart(2, '0')}-${transition}.json`, record);
      console.log(JSON.stringify({ sourceWriter: transition, completed: true, ...record }));
    } else {
      throw new Error('Unknown private upstream fixture operation');
    }
  }
}
