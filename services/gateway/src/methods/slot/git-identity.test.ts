import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { SlotVars } from '../../core/config.js';

import {
  checkCommitSigning,
  type GitIdentity,
  loadGitIdentity,
  readGitIdentity,
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
  await writeFile(path.join(root, 'git-identity.json'), JSON.stringify(FARM_IDENTITY));
  assert.deepEqual(loadGitIdentity(root), FARM_IDENTITY);
  await writeFile(path.join(root, 'git-identity.json'), JSON.stringify({ 'core.editor': 'vi' }));
  assert.throws(() => loadGitIdentity(root), /core\.editor must be one of user\.name/);
});

test('syncGitIdentity writes missing or different keys into the local config once', async (t) => {
  const { repo, gpg } = await fixture(t);
  const slot = repo('mini-mmt-1', { 'commit.gpgsign': 'false', 'user.name': 'Slot Signer' });
  const identity = { ...FARM_IDENTITY, 'gpg.program': await gpg('gpg-signs', GPG_SIGNS) };

  assert.equal(
    await syncGitIdentity(slot, identity),
    'Git identity written: user.email, user.signingkey, commit.gpgsign, gpg.program',
  );
  assert.deepEqual(await readGitIdentity(slot, 'local'), identity);
  assert.equal(await syncGitIdentity(slot, identity), 'Git identity up to date');
});

test('syncGitIdentity skips a gpg.program the slot machine does not have', async (t) => {
  const { repo } = await fixture(t);
  const slot = repo('slot');

  assert.match(
    await syncGitIdentity(slot, {
      'user.email': 'signer@example.com',
      'gpg.program': '/nonexistent/bin/gpg',
    }),
    /written: user\.email, gpg\.program \(skipped gpg\.program: \/nonexistent\/bin\/gpg not found\)$/,
  );
  assert.equal((await readGitIdentity(slot, 'local'))['gpg.program'], undefined);
});

test('checkCommitSigning skips a repo that does not sign when the farm does not ask it to', async (t) => {
  const { repo } = await fixture(t);
  const step = await checkCommitSigning(repo('slot', { 'commit.gpgsign': 'false' }), null);
  assert.deepEqual(step, { name: 'git.signing', status: 'skip', detail: 'Commit signing is off' });
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
  // The probe writes no ref.
  assert.equal(execFileSync('git', ['-C', slot.remoteRepo, 'for-each-ref']).toString().trim(), '');
});

test('checkCommitSigning passes when the slot repo signs', async (t) => {
  const { repo, gpg } = await fixture(t);
  const slot = repo('slot', { ...FARM_IDENTITY, 'gpg.program': await gpg('gpg-signs', GPG_SIGNS) });
  assert.deepEqual(await checkCommitSigning(slot, null), {
    name: 'git.signing',
    status: 'pass',
    detail: 'Commits sign with key A41FEC143503D502',
  });
});
