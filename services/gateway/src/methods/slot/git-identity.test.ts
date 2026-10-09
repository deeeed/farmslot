import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { RawProjectJson, SlotVars } from '../../core/config.js';

import { checkCommitSigning, readGitIdentity, syncGitIdentity } from './git-identity.js';

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
  return { repo, gpg };
}

const PROJECT = { ci: { repo: 'acme/app' } } as RawProjectJson;
const requiresSignatures = async () => ['non_fast_forward', 'required_signatures'];

test('syncGitIdentity copies the reference identity into the slot repo once', async (t) => {
  const { repo, gpg } = await fixture(t);
  const gpgProgram = await gpg('gpg-signs', GPG_SIGNS);
  const reference = repo('macwork-mmt-1', {
    'user.name': 'Slot Signer',
    'user.email': 'signer@example.com',
    'user.signingkey': 'A41FEC143503D502',
    'commit.gpgsign': 'true',
    'gpg.program': gpgProgram,
  });
  const slot = repo('mini-mmt-1', { 'commit.gpgsign': 'false' });

  assert.equal(
    await syncGitIdentity(slot, reference),
    'Git identity copied from macwork-mmt-1: user.name, user.email, user.signingkey, commit.gpgsign, gpg.program',
  );
  const synced = await readGitIdentity(slot);
  assert.equal(synced['user.email'], 'signer@example.com');
  assert.equal(synced['user.signingkey'], 'A41FEC143503D502');
  assert.equal(synced['commit.gpgsign'], 'true');
  assert.equal(
    execFileSync('git', ['-C', slot.remoteRepo, 'config', '--local', 'user.email']).toString(),
    'signer@example.com\n',
  );
  assert.equal(await syncGitIdentity(slot, reference), 'Git identity matches macwork-mmt-1');
});

test('syncGitIdentity skips a gpg.program the slot machine does not have', async (t) => {
  const { repo } = await fixture(t);
  const reference = repo('ref', {
    'user.email': 'signer@example.com',
    'gpg.program': '/nonexistent/bin/gpg',
  });
  const slot = repo('slot');

  assert.match(
    await syncGitIdentity(slot, reference),
    /copied from ref: user\.email, gpg\.program \(skipped gpg\.program: \/nonexistent\/bin\/gpg not found\)$/,
  );
  assert.notEqual((await readGitIdentity(slot))['gpg.program'], '/nonexistent/bin/gpg');
});

test('checkCommitSigning passes when the branch rules do not require signatures', async (t) => {
  const { repo } = await fixture(t);
  const step = await checkCommitSigning(repo('slot'), PROJECT, 'main', async () => [
    'non_fast_forward',
  ]);
  assert.equal(step.status, 'pass');
  assert.match(step.detail, /acme\/app does not require signed commits/);
});

test('checkCommitSigning fails a slot with commit signing off and names the key', async (t) => {
  const { repo } = await fixture(t);
  const slot = repo('slot', { 'commit.gpgsign': 'false', 'user.signingkey': 'A41FEC143503D502' });
  const step = await checkCommitSigning(slot, PROJECT, 'main', requiresSignatures);
  assert.equal(step.status, 'fail');
  assert.match(
    step.detail,
    /requires signed commits .*commit\.gpgsign is false .*key A41FEC143503D502/,
  );
  assert.match(step.detail, /Fix: set git_identity_slot/);
});

test('checkCommitSigning fails when a test signature from the slot repo fails', async (t) => {
  const { repo, gpg } = await fixture(t);
  const slot = repo('slot', {
    'user.name': 'Slot Signer',
    'user.email': 'signer@example.com',
    'user.signingkey': 'A41FEC143503D502',
    'commit.gpgsign': 'true',
    'gpg.program': await gpg('gpg-no-key', GPG_NO_KEY),
  });
  const step = await checkCommitSigning(slot, PROJECT, 'main', requiresSignatures);
  assert.equal(step.status, 'fail');
  assert.match(step.detail, /test signature with key A41FEC143503D502 failed/);
  assert.match(step.detail, /No secret key/);
  assert.match(step.detail, /Fix: import key A41FEC143503D502/);
  // The probe writes no ref.
  assert.equal(execFileSync('git', ['-C', slot.remoteRepo, 'for-each-ref']).toString().trim(), '');
});

test('checkCommitSigning passes when the slot repo signs', async (t) => {
  const { repo, gpg } = await fixture(t);
  const slot = repo('slot', {
    'user.name': 'Slot Signer',
    'user.email': 'signer@example.com',
    'user.signingkey': 'A41FEC143503D502',
    'commit.gpgsign': 'true',
    'gpg.program': await gpg('gpg-signs', GPG_SIGNS),
  });
  assert.deepEqual(await checkCommitSigning(slot, PROJECT, 'main', requiresSignatures), {
    name: 'git.signing',
    status: 'pass',
    detail: 'Commits on main sign with key A41FEC143503D502',
  });
});

test('checkCommitSigning gives no verdict when the branch rules cannot be read', async (t) => {
  const { repo } = await fixture(t);
  const step = await checkCommitSigning(repo('slot'), PROJECT, 'main', async () => {
    throw new Error('HTTP 404\nbody');
  });
  assert.deepEqual(step, {
    name: 'git.signing',
    status: 'warn',
    detail: 'No verdict: cannot read acme/app branch rules (HTTP 404)',
  });
});
