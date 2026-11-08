import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { SlotVars } from '../../core/config.js';
import { EXEC_TIMEOUT_EXIT_CODE, execOnSlot } from '../../core/exec.js';

import {
  checkCommitSigning,
  type GitIdentity,
  loadGitIdentity,
  readGitIdentity,
  signingKeyFormat,
  syncGitIdentity,
} from './git-identity.js';

function makeSlotVars(slotId: string, remoteRepo: string): SlotVars {
  return {
    slotId,
    machine: os.hostname(),
    platform: 'web',
    host: 'localhost',
    sshUser: 'test',
    osType: 'darwin',
    claudePath: '',
    codexPath: '',
    opencodePath: '',
    cursorPath: '',
    grokPath: '',
    dispatchCmd: '',
    recycleCmd: '',
    repo: remoteRepo,
    session: slotId,
    slotMode: 'dispatch',
    slotEnabled: true,
    sshTarget: '',
    remoteRepo,
    projectName: 'signing-test',
    resourceVars: {},
  };
}

// Stand-ins for gpg as git calls it (`--status-fd=2 -bsau <key>`, payload on stdin).
const GPG_SIGNS = `#!/bin/sh
cat >/dev/null
echo '[GNUPG:] SIG_CREATED D 1 8 00 1700000000 A41FEC143503D502' >&2
printf -- '-----BEGIN PGP SIGNATURE-----\\n\\nfake\\n-----END PGP SIGNATURE-----\\n'
`;
const GPG_NO_KEY = `#!/bin/sh
cat >/dev/null
echo 'gpg: skipped "A41FEC143503D502": No secret key' >&2
echo 'gpg: signing failed: No secret key' >&2
exit 2
`;

async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'farmslot-git-identity-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const repo = (name: string, config: Record<string, string> = {}) => {
    const dir = path.join(root, name);
    execFileSync('git', ['init', '-q', dir]);
    for (const [key, value] of Object.entries(config)) {
      execFileSync('git', ['-C', dir, 'config', '--local', key, value]);
    }
    return makeSlotVars(name, dir);
  };
  const gpg = async (name: string, body: string) => {
    const file = path.join(root, name);
    await writeFile(file, body);
    await chmod(file, 0o755);
    return file;
  };
  return { root, repo, gpg };
}

const FARM_IDENTITY: GitIdentity = {
  'user.name': 'Slot Signer',
  'user.email': 'signer@example.com',
  'user.signingkey': 'A41FEC143503D502',
  'commit.gpgsign': 'true',
};

test('loadGitIdentity reads the farm identity and rejects keys it does not copy', async (t) => {
  const { root } = await fixture(t);
  assert.equal(loadGitIdentity(root), null);
  assert.equal(loadGitIdentity(root, 'farmslot-farm'), null);
  await writeFile(path.join(root, 'git-identity.json'), JSON.stringify(FARM_IDENTITY));
  assert.deepEqual(loadGitIdentity(root), FARM_IDENTITY);
  assert.deepEqual(loadGitIdentity(root, 'farmslot-farm'), FARM_IDENTITY);
  const file = path.join(root, 'git-identity.json');
  await writeFile(file, JSON.stringify({ 'core.editor': 'vi' }));
  assert.throws(() => loadGitIdentity(root), /unknown key core\.editor \(expected user\.name/);
  await writeFile(file, JSON.stringify({ 'commit.gpgsign': true }));
  assert.throws(() => loadGitIdentity(root), /commit\.gpgsign must be a string$/);
  await writeFile(file, JSON.stringify({ 'commit.gpgsign': 'treu' }));
  assert.throws(() => loadGitIdentity(root), /commit\.gpgsign must be a git boolean, got treu$/);
  await writeFile(file, '{"user.email": ');
  assert.throws(
    () => loadGitIdentity(root),
    (err: Error) => err.message.startsWith(`Invalid ${file}: `),
  );
});

test('syncGitIdentity replaces a stale ssh format when the farm uses an OpenPGP key', async (t) => {
  const { repo } = await fixture(t);
  const slot = repo('mini-ff-2', {
    'gpg.format': 'ssh',
    'user.signingkey': '/home/signer/.ssh/signing.pub',
  });
  const identity = {
    ...FARM_IDENTITY,
    'user.signingkey': '6DADC9450892C679EAED32F2A41FEC143503D502',
  };
  await syncGitIdentity(slot, identity);
  assert.deepEqual(await readGitIdentity(slot, 'local'), { ...identity, 'gpg.format': 'openpgp' });
});

test('loadGitIdentity overlays the slot project and keeps defaults for other projects', async (t) => {
  const { root } = await fixture(t);
  const projectIdentity: GitIdentity = {
    'user.name': 'Personal Signer',
    'user.email': 'signer@users.noreply.github.com',
    'user.signingkey': '/home/signer/.ssh/signing.pub',
    'gpg.format': 'ssh',
  };
  await writeFile(
    path.join(root, 'git-identity.json'),
    JSON.stringify({ ...FARM_IDENTITY, projects: { 'farmslot-farm': projectIdentity } }),
  );
  assert.deepEqual(loadGitIdentity(root, 'farmslot-farm'), {
    ...FARM_IDENTITY,
    ...projectIdentity,
  });
  assert.deepEqual(loadGitIdentity(root, 'other-project'), FARM_IDENTITY);
  assert.deepEqual(loadGitIdentity(root), FARM_IDENTITY);
});

test('loadGitIdentity validates all project entries and merged signing formats', async (t) => {
  const { root } = await fixture(t);
  const cases = [
    {
      config: { ...FARM_IDENTITY, 'gpg.format': 'ssh' },
      error: /gpg\.format=ssh contradicts.*openpgp key/,
    },
    { config: { projects: null }, error: /projects must be an object/ },
    { config: { projects: [] }, error: /projects must be an object/ },
    { config: { projects: 'farm' }, error: /projects must be an object/ },
    { config: { projects: { other: null } }, error: /projects\.other: expected an object/ },
    { config: { projects: { other: [] } }, error: /projects\.other: expected an object/ },
    {
      config: { projects: { other: { 'core.editor': 'vi' } } },
      error: /projects\.other: unknown key core\.editor/,
    },
    {
      config: { projects: { other: { 'commit.gpgsign': true } } },
      error: /projects\.other: commit\.gpgsign must be a string/,
    },
    {
      config: { projects: { other: { 'commit.gpgsign': 'treu' } } },
      error: /projects\.other: commit\.gpgsign must be a git boolean/,
    },
    {
      config: { projects: { other: { ...FARM_IDENTITY, 'gpg.format': 'ssh' } } },
      error: /projects\.other: gpg\.format=ssh contradicts.*openpgp key/,
    },
    {
      config: {
        ...FARM_IDENTITY,
        'gpg.format': 'openpgp',
        projects: { other: { 'user.signingkey': '/home/signer/.ssh/signing.pub' } },
      },
      error: /projects\.other: gpg\.format=openpgp contradicts.*ssh key/,
    },
  ];
  for (const { config, error } of cases) {
    await writeFile(path.join(root, 'git-identity.json'), JSON.stringify(config));
    assert.throws(() => loadGitIdentity(root, 'farmslot-farm'), error);
  }
});

test('checkCommitSigning reports an ssh format paired with an OpenPGP key before probing', async (t) => {
  const { repo } = await fixture(t);
  const slot = repo('mini-ff-2', { ...FARM_IDENTITY, 'gpg.format': 'ssh' });
  const step = await checkCommitSigning(slot, FARM_IDENTITY, {
    execute: async () => assert.fail('a mismatched identity must not reach the signing probe'),
  });
  assert.equal(step.name, 'git.signing');
  assert.equal(step.status, 'fail');
  assert.match(step.detail, /gpg\.format=ssh.*user\.signingkey=A41FEC143503D502.*openpgp/);
  assert.match(step.detail, /Fix: run `farmslot slot prepare mini-ff-2`/);
  assert.doesNotMatch(step.detail, /import key/);
});

test('signingKeyFormat treats ssh literals and key paths as ssh, anything else as openpgp', () => {
  for (const key of [
    '/home/signer/.ssh/signing.pub',
    '/home/signer/.ssh/id_ed25519',
    '~/.ssh/id_ed25519',
    'keys/signing',
    'ssh-ed25519 AAAA test@example.com',
    'key::ssh-ed25519 AAAA test@example.com',
  ]) {
    assert.equal(signingKeyFormat(key), 'ssh', key);
  }
  for (const key of [
    'A41FEC143503D502',
    '6DADC9450892C679EAED32F2A41FEC143503D502',
    'Slot Signer <signer@example.com>',
  ]) {
    assert.equal(signingKeyFormat(key), 'openpgp', key);
  }
});

test('loadGitIdentity accepts an ssh private key path and an explicit x509 format', async (t) => {
  const { root } = await fixture(t);
  for (const identity of [
    { 'user.signingkey': '/home/signer/.ssh/id_ed25519', 'gpg.format': 'ssh' },
    { 'user.signingkey': 'A41FEC143503D502', 'gpg.format': 'x509' },
  ]) {
    await writeFile(path.join(root, 'git-identity.json'), JSON.stringify(identity));
    assert.deepEqual(loadGitIdentity(root), identity);
  }
});

test('syncGitIdentity infers ssh formats even when only the format needs updating', async (t) => {
  const { repo } = await fixture(t);
  const key = '/home/signer/.ssh/signing.pub';
  const slot = repo('ssh-0', { 'user.signingkey': key, 'gpg.format': 'openpgp' });
  const identity: GitIdentity = { 'user.signingkey': key };
  assert.equal(await syncGitIdentity(slot, identity), 'Git identity written: gpg.format');
  assert.deepEqual(await readGitIdentity(slot, 'local'), { ...identity, 'gpg.format': 'ssh' });
  assert.equal(await syncGitIdentity(slot, identity), 'Git identity up to date');
});

test('syncGitIdentity writes missing or different keys into the local config once', async (t) => {
  const { repo, gpg } = await fixture(t);
  const slot = repo('mini-mmt-1', { 'commit.gpgsign': 'false', 'user.name': 'Slot Signer' });
  const identity = { ...FARM_IDENTITY, 'gpg.program': await gpg('gpg-signs', GPG_SIGNS) };

  assert.equal(
    await syncGitIdentity(slot, identity),
    'Git identity written: user.email, user.signingkey, commit.gpgsign, gpg.format, gpg.program',
  );
  assert.deepEqual(await readGitIdentity(slot, 'local'), { ...identity, 'gpg.format': 'openpgp' });
  assert.equal(await syncGitIdentity(slot, identity), 'Git identity up to date');
});

test('syncGitIdentity skips a gpg.program the slot machine does not have', async (t) => {
  const { repo } = await fixture(t);
  const slot = repo('slot');

  const identity = { 'user.email': 'signer@example.com', 'gpg.program': '/nonexistent/bin/gpg' };
  const skipped = '(skipped gpg.program: /nonexistent/bin/gpg not found)';
  assert.equal(
    await syncGitIdentity(slot, identity),
    `Git identity written: user.email ${skipped}`,
  );
  assert.equal((await readGitIdentity(slot, 'local'))['gpg.program'], undefined);
  // The skipped key is not reported as written on every later prepare.
  assert.equal(await syncGitIdentity(slot, identity), `Git identity up to date ${skipped}`);
});

test('checkCommitSigning skips a repo that does not sign when the farm does not ask it to', async (t) => {
  const { repo } = await fixture(t);
  const slot = repo('slot', { 'commit.gpgsign': 'false' });
  assert.deepEqual(
    await checkCommitSigning(slot, null, {
      identityPath: '/home/op/.farmslot-dev/git-identity.json',
    }),
    {
      name: 'git.signing',
      status: 'skip',
      detail:
        'Commit signing is off (no farm git identity at /home/op/.farmslot-dev/git-identity.json)',
    },
  );
  assert.deepEqual(await checkCommitSigning(slot, { 'user.email': 'signer@example.com' }), {
    name: 'git.signing',
    status: 'skip',
    detail: 'Commit signing is off',
  });
});

test('checkCommitSigning fails a repo with signing off when the farm identity signs', async (t) => {
  const { repo } = await fixture(t);
  const slot = repo('mini-mmt-1', {
    'commit.gpgsign': 'false',
    'user.signingkey': 'A41FEC143503D502',
  });
  const step = await checkCommitSigning(slot, FARM_IDENTITY);
  assert.equal(step.status, 'fail');
  assert.match(step.detail, /commit\.gpgsign is false .*\(key A41FEC143503D502\)/);
  assert.match(step.detail, /Fix: run `farmslot slot prepare mini-mmt-1`/);
});

test('checkCommitSigning fails when a test signature from the slot repo fails', async (t) => {
  const { repo, gpg } = await fixture(t);
  const slot = repo('slot', {
    ...FARM_IDENTITY,
    'gpg.program': await gpg('gpg-no-key', GPG_NO_KEY),
  });
  const step = await checkCommitSigning(slot, FARM_IDENTITY);
  assert.equal(step.status, 'fail');
  assert.match(step.detail, /test signature with key A41FEC143503D502 failed/);
  assert.match(step.detail, /No secret key/);
  assert.match(step.detail, /Fix: import key A41FEC143503D502 on .* and unlock its gpg-agent/);
});

test('checkCommitSigning reports the default openpgp format paired with an ssh key', async (t) => {
  const { repo } = await fixture(t);
  const slot = repo('slot', {
    ...FARM_IDENTITY,
    'user.signingkey': '/home/signer/.ssh/signing.pub',
  });
  for (const identity of [null, { 'user.email': 'signer@example.com' }]) {
    const step = await checkCommitSigning(slot, identity, {
      execute: async () => assert.fail('a mismatched identity must not reach the signing probe'),
    });
    assert.equal(step.status, 'fail');
    assert.match(step.detail, /gpg\.format=openpgp.*user\.signingkey=.*signing\.pub.*ssh key/);
    assert.match(step.detail, /Fix: set matching user\.signingkey and gpg\.format/);
    assert.doesNotMatch(step.detail, /import key/);
  }
});

test('checkCommitSigning gives ssh key and agent fixes for failed and timed-out probes', async (t) => {
  const { repo } = await fixture(t);
  const key = '/home/signer/.ssh/signing.pub';
  const slot = repo('slot', { ...FARM_IDENTITY, 'user.signingkey': key, 'gpg.format': 'ssh' });
  for (const exitCode of [1, EXEC_TIMEOUT_EXIT_CODE]) {
    const step = await checkCommitSigning(slot, null, {
      execute: async () => ({ exitCode, stdout: "Couldn't load public key", stderr: '' }),
    });
    assert.equal(step.status, 'fail');
    assert.ok(step.detail.includes(`public key file ${key}`));
    assert.ok(step.detail.includes(`private key or ssh-agent on ${slot.machine}`));
    assert.doesNotMatch(step.detail, /import key|gpg-agent|pinentry/);
  }
});

test('checkCommitSigning passes when the slot repo signs', async (t) => {
  const { repo, gpg } = await fixture(t);
  const slot = repo('slot', { ...FARM_IDENTITY, 'gpg.program': await gpg('gpg-signs', GPG_SIGNS) });
  assert.deepEqual(await checkCommitSigning(slot, null), {
    name: 'git.signing',
    status: 'pass',
    detail: 'Commits sign with key A41FEC143503D502',
  });
  // The signed probe commit is created but no ref points at it.
  assert.equal(execFileSync('git', ['-C', slot.remoteRepo, 'for-each-ref']).toString().trim(), '');
});

test('checkCommitSigning fails on a missing user.email before probing the key', async (t) => {
  const { repo, gpg } = await fixture(t);
  const slot = repo('macpro-mmt-1', {
    'user.email': '',
    'user.signingkey': 'A41FEC143503D502',
    'commit.gpgsign': 'true',
    'gpg.program': await gpg('gpg-signs', GPG_SIGNS),
  });
  const step = await checkCommitSigning(slot, FARM_IDENTITY);
  assert.equal(step.status, 'fail');
  assert.match(step.detail, /user\.email is unset .*Fix: run `farmslot slot prepare macpro-mmt-1`/);
});

test('checkCommitSigning names a gpg-agent that does not answer in time', async (t) => {
  const { repo } = await fixture(t);
  const slot = repo('slot', FARM_IDENTITY);
  const step = await checkCommitSigning(slot, FARM_IDENTITY, {
    probeTimeoutMs: 300,
    execute: async () => ({ exitCode: EXEC_TIMEOUT_EXIT_CODE, stdout: '', stderr: '' }),
  });
  assert.equal(step.status, 'fail');
  assert.match(
    step.detail,
    /gpg-agent did not answer within 0\.3 s on .* for key A41FEC143503D502 \(likely a pinentry waiting for a passphrase\)/,
  );
});

test('checkCommitSigning reports a git config it cannot read', async (t) => {
  const { repo } = await fixture(t);
  const slot = repo('slot');
  await writeFile(path.join(slot.remoteRepo, '.git', 'config'), '[core\nbroken = \n');
  const step = await checkCommitSigning(slot, FARM_IDENTITY);
  assert.equal(step.status, 'fail');
  assert.match(step.detail, /^cannot read git config in .* \(exit \d+\): .*bad config/);
});

test('signing probe uses the supplied worker-session executor, not a healthy node shell', async (t) => {
  const { repo, gpg } = await fixture(t);
  const slot = repo('slot', {
    ...FARM_IDENTITY,
    'gpg.program': await gpg(
      'gpg-context',
      `#!/bin/sh
cat >/dev/null
if [ "$SIGNING_WORKER_CONTEXT" != ready ]; then echo 'agent unavailable in worker session' >&2; exit 2; fi
${GPG_SIGNS.split('\n').slice(1).join('\n')}`,
    ),
  });
  const unavailable = await checkCommitSigning(slot, FARM_IDENTITY, {
    execute: (command, timeout) =>
      execOnSlot(slot, `export SIGNING_WORKER_CONTEXT=unavailable; ${command}`, { timeout }),
  });
  assert.equal(unavailable.status, 'fail');
  assert.match(unavailable.detail, /agent unavailable in worker session/);
  const ready = await checkCommitSigning(slot, FARM_IDENTITY, {
    execute: (command, timeout) =>
      execOnSlot(slot, `export SIGNING_WORKER_CONTEXT=ready; ${command}`, { timeout }),
  });
  assert.equal(ready.status, 'pass');
});
