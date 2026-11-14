import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

await import('../runtime/mock-pty.test-support.js');
const root = await mkdtemp(path.join(os.tmpdir(), 'doctor-git-objects-'));
Object.assign(process.env, {
  FARMSLOT_HOME: root,
  FARMSLOT_POOL_DIR: path.join(root, 'pool'),
  FARMSLOT_PROJECTS_DIR: path.join(root, 'projects'),
});
after(() => rm(root, { recursive: true, force: true }));

const independent = path.join(root, 'independent');
const borrowed = path.join(root, 'borrowed');
const linked = path.join(root, 'linked');
const common = path.join(root, 'common');
for (const repo of [independent, borrowed, common]) {
  await mkdir(path.join(repo, '.git/refs/heads'), { recursive: true });
  await writeFile(path.join(repo, '.git/HEAD'), 'ref: refs/heads/main\n');
  await writeFile(path.join(repo, '.git/refs/heads/main'), 'a'.repeat(40) + '\n');
}
const linkedGit = path.join(common, '.git/worktrees/linked');
await mkdir(linkedGit, { recursive: true });
await mkdir(linked);
await writeFile(path.join(linked, '.git'), `gitdir: ${linkedGit}\n`);
await writeFile(path.join(linkedGit, 'HEAD'), 'ref: refs/heads/main\n');
await writeFile(path.join(linkedGit, 'commondir'), '../..\n');
const files = [borrowed, common].map((repo) => path.join(repo, '.git/objects/info/alternates'));
for (const file of files) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, '/mutable/slot/.git/objects\n');
}
await mkdir(path.join(root, 'pool'));
await mkdir(path.join(root, 'projects/fixture'), { recursive: true });
await writeFile(
  path.join(root, 'projects/fixture/project.json'),
  JSON.stringify({ name: 'fixture' }),
);
await writeFile(
  path.join(root, 'pool/fixture.json'),
  JSON.stringify({
    machine: 'fixture',
    host: 'localhost',
    os: 'darwin',
    project: 'fixture',
    platform: 'cli',
    slots: [independent, borrowed, linked].map((repo, i) => ({ id: `fixture-${i}`, repo })),
  }),
);
const { gatewayDoctor } = await import('./gateway-doctor.js');

test('workspace doctor flags borrowed objects for normal and linked slots, then observes removal', async () => {
  const result = await gatewayDoctor({ sectionId: 'workspace' });
  const check = result.sections[0]?.checks.find((check) => check.id === 'git-object-stores');
  assert.ok(check, 'Missing slot Git object ownership check');
  assert.equal(check.ok, false);
  assert.match(check.detail, /fixture-1/);
  assert.match(check.detail, /fixture-2/);
  assert.doesNotMatch(check.detail, /fixture-0:/);
  for (const file of files) await rm(file);
  const cleared = (await gatewayDoctor({ sectionId: 'workspace' })).sections[0]?.checks.find(
    (check) => check.id === 'git-object-stores',
  );
  assert.equal(cleared?.ok, true);
  assert.equal(cleared?.warn, undefined);
});

test('workspace doctor detects a missing cache-tree object in a prunable linked index', async () => {
  const index = path.join(common, '.git/worktrees/scratch/index');
  await mkdir(path.dirname(index), { recursive: true });
  await writeFile(path.join(path.dirname(index), 'HEAD'), 'a'.repeat(40) + '\n');
  await writeFile(path.join(path.dirname(index), 'gitdir'), '/absent/scratch/.git\n');
  const header = Buffer.alloc(12);
  header.write('DIRC');
  header.writeUInt32BE(2, 4);
  const tree = Buffer.concat([Buffer.from('\0' + '0 0\n'), Buffer.alloc(20, 0xbb)]);
  const extension = Buffer.alloc(8);
  extension.write('TREE');
  extension.writeUInt32BE(tree.length, 4);
  const body = Buffer.concat([header, extension, tree]);
  const bytes = Buffer.concat([body, createHash('sha1').update(body).digest()]);
  await writeFile(index, bytes);
  const result = await gatewayDoctor({ sectionId: 'workspace' });
  const check = result.sections[0]?.checks.find((check) => check.id === 'git-object-stores');
  assert.equal(check?.ok, false);
  assert.match(check?.detail ?? '', /fixture-2:.*worktrees\/scratch\/index/);
  assert.match(check?.detail ?? '', /missing cache-tree object b{40}/);
  await rm(index);
  assert.equal(
    (await gatewayDoctor({ sectionId: 'workspace' })).sections[0]?.checks.find(
      (check) => check.id === 'git-object-stores',
    )?.ok,
    true,
  );
});
