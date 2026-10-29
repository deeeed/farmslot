// Private source-file writers for the gateway-update client recipe. Never updates the real checkout.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const source = fileURLToPath(new URL('../../../', import.meta.url)).replace(/\/$/, '');
assert.equal(process.env.FARMSLOT_OFFLINE_PROOF, '1');
const [mode, configFile] = process.argv.slice(2);
const config = JSON.parse(await readFile(configFile, 'utf8'));
const root = path.resolve(config.caseRoot);
assert(process.env.FARMSLOT_GATEWAY_UPDATE_ARTIFACT_ROOT);
assert.equal(path.dirname(root), path.resolve(process.env.FARMSLOT_GATEWAY_UPDATE_ARTIFACT_ROOT));
assert(path.basename(root).startsWith('d08-gateway-'));
assert.notEqual(root, source);
const farm = path.join(root, 'farm');
const home = path.join(root, 'home');
const upstream = path.join(root, 'upstream');
const git = async (directory, ...args) =>
  (await execute('/usr/bin/git', args, { cwd: directory, timeout: 20000 })).stdout.trim();
const save = async (name, value) => {
  const file = path.join(root, name);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
};
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

if (mode === 'setup') {
  assert.equal(config.sourceRoot, source);
  await mkdir(upstream, { recursive: true });
  await git(upstream, '-c', 'init.defaultBranch=main', 'init');
  await git(upstream, 'config', 'user.name', 'Offline proof');
  await git(upstream, 'config', 'user.email', 'offline-proof@invalid');
  for (const [name, text] of Object.entries({
    'CLAUDE.md': 'Private gateway observation fixture.\n',
    'scripts/dev.sh': '#!/bin/sh\nexit 0\n',
    'services/gateway/package.json': JSON.stringify({
      name: '@farmslot/gateway',
      version: '0.0.1-proof',
    }),
    '.gitignore': '.farm-cache/\n.farm-status.json\n.runs/\npool/\nprojects/\n',
  })) {
    const file = path.join(upstream, name);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, text);
  }
  await git(upstream, 'add', '.');
  await git(
    upstream,
    '-c',
    'commit.gpgSign=false',
    'commit',
    '-m',
    'chore: seed private update fixture',
  );
  await git(root, 'clone', upstream, farm);
  await writeFile(path.join(upstream, 'remote-change'), 'available update\n');
  await git(upstream, 'add', 'remote-change');
  await git(
    upstream,
    '-c',
    'commit.gpgSign=false',
    'commit',
    '-m',
    'chore: advance private upstream',
  );
  await mkdir(path.join(farm, 'pool'), { recursive: true });
  await mkdir(path.join(farm, 'projects'), { recursive: true });
  await writeFile(
    path.join(farm, '.farm-status.json'),
    JSON.stringify({
      checked_at: new Date().toISOString(),
      slots: [],
    }),
    { mode: 0o600 },
  );
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
  const issued = writer.issueCredential(actor.id, 'private gateway observation browser');
  saveProfiles(
    {
      active: config.name,
      gateways: {
        [config.name]: {
          url: config.gatewayUrl,
          authMode: 'token',
          secret: issued.secret,
        },
      },
    },
    path.join(home, 'gateways.json'),
  );
  const profileFile = path.join(home, 'gateways.json');
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
  await save('fixture.json', {
    ...config,
    farm,
    home,
    upstream,
    actorId: actor.id,
    localSha: await git(farm, 'rev-parse', 'HEAD'),
    targetSha: await git(upstream, 'rev-parse', 'HEAD'),
    setupComplete: true,
    fixtureOnly: true,
    providerExecution: false,
  });
  console.log(JSON.stringify({ fixturePrepared: true, actorId: actor.id }));
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
  } else if (mode === 'operation') {
    const leaf = await git(farm, 'rev-parse', '--git-path', 'farmslot-checkout-update.json');
    const file = path.resolve(farm, leaf);
    const record = {
      id: randomUUID(),
      phase: 'running',
      localSha: fixture.localSha,
      targetSha: fixture.targetSha,
      message: 'Private source operation notice',
      updatedAt: new Date().toISOString(),
      pid: process.pid,
    };
    const bytes = JSON.stringify(record);
    await writeFile(file + '.fixture.tmp', bytes, { mode: 0o600 });
    await rename(file + '.fixture.tmp', file);
    await save('writer-operation.json', {
      kind: 'atomic-source-record',
      file,
      sha256: digest(bytes),
      record,
    });
  } else if (mode === 'installed') {
    await git(farm, 'checkout', '--detach', fixture.targetSha);
    await save('writer-installed.json', {
      kind: 'git-checkout',
      actualHead: await git(farm, 'rev-parse', 'HEAD'),
    });
  } else if (mode === 'outage' || mode === 'repair') {
    await git(
      farm,
      'remote',
      'set-url',
      'origin',
      mode === 'outage' ? path.join(root, 'unavailable-remote') : upstream,
    );
    await save('writer-' + mode + '.json', { kind: 'remote-availability', mode });
  } else {
    throw new Error('Unknown private source fixture operation');
  }
  console.log(JSON.stringify({ sourceWriter: mode, completed: true }));
}
