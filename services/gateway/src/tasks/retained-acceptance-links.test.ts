import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createEvidenceReviewModel } from '@farmslot/adapter-sdk/evidence';

import '../runtime/mock-pty.test-support.js';

import { readAcceptanceStatusForDisplay } from './acceptance-status.js';
import {
  importRetainedAcceptanceLinks,
  RETAINED_LINK_HELPER_SHA256,
  RETAINED_LINK_SOURCE,
  retainedAcceptanceLinksPath,
} from './retained-acceptance-links.js';

const LOCAL = { host: 'localhost', machine: 'local', sshTarget: '' };
const CRITERIA = [{ id: 'AC-1', text: 'The existing panel image remains available' }];
const LINKS = [{ id: 'AC-1', evidence: ['artifacts/old.png'] }];
const hash = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'retained-links-'));
  const taskDir = path.join(root, 'task');
  await mkdir(path.join(taskDir, 'inputs'), { recursive: true });
  await mkdir(path.join(taskDir, 'artifacts'));
  const handoff = JSON.stringify({ task: { acceptanceCriteria: CRITERIA.map((row) => row.text) } });
  const manifest = JSON.stringify({
    standalone: [{ file: 'artifacts/old.png', covers: ['AC-1'] }],
  });
  await writeFile(path.join(taskDir, 'inputs/handoff.json'), handoff);
  await writeFile(path.join(taskDir, 'artifacts/evidence-manifest.json'), manifest);
  await writeFile(path.join(taskDir, 'artifacts/old.png'), 'original image bytes');
  const inventory = {
    frozenSource: RETAINED_LINK_SOURCE,
    helperSha256: RETAINED_LINK_HELPER_SHA256,
    records: [
      {
        task: 'task',
        handoffSha256: hash(handoff),
        manifestSha256: hash(manifest),
        links: LINKS,
        refs: [
          {
            path: 'artifacts/old.png',
            sha256: hash('original image bytes'),
            contained: true,
            present: true,
          },
        ],
      },
    ],
  };
  const bytes = () => Buffer.from(JSON.stringify(inventory));
  const snapshotPath = retainedAcceptanceLinksPath(taskDir);
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(snapshotPath, { force: true });
  });
  return { root, taskDir, inventory, bytes, snapshotPath };
}

test('one-time import preserves original bytes and untimed links; identical retry is a no-op', async (t) => {
  const f = await fixture(t);
  const original = await Promise.all(
    ['inputs/handoff.json', 'artifacts/evidence-manifest.json', 'artifacts/old.png'].map((ref) =>
      readFile(path.join(f.taskDir, ref)),
    ),
  );
  assert.deepEqual(await importRetainedAcceptanceLinks(f.bytes(), f.root), {
    tasks: 1,
    links: 1,
    files: 1,
  });
  const before = await readFile(f.snapshotPath);
  const beforeStat = await stat(f.snapshotPath);
  assert.equal(beforeStat.mode & 0o777, 0o600);
  await importRetainedAcceptanceLinks(f.bytes(), f.root);
  assert.deepEqual(await readFile(f.snapshotPath), before);
  assert.equal((await stat(f.snapshotPath)).mtimeMs, beforeStat.mtimeMs);
  const display = await readAcceptanceStatusForDisplay(LOCAL, f.taskDir);
  assert.deepEqual(display, { criteria: CRITERIA, ledger: null, evidenceLinks: LINKS });
  const model = createEvidenceReviewModel({
    context: 'run-detail',
    criteria: display.criteria,
    evidenceLinks: display.evidenceLinks,
  });
  assert.equal(model.claims[0].status, null);
  assert.deepEqual(model.claims[0].moments, []);
  assert.equal(model.selectClaim('AC-1')?.timing, 'untimed');
  assert.deepEqual(
    await Promise.all(
      ['inputs/handoff.json', 'artifacts/evidence-manifest.json', 'artifacts/old.png'].map((ref) =>
        readFile(path.join(f.taskDir, ref)),
      ),
    ),
    original,
  );
});

test('changed linked bytes produce a separate caption without deriving a replacement', async (t) => {
  const f = await fixture(t);
  await importRetainedAcceptanceLinks(f.bytes(), f.root);
  await writeFile(path.join(f.taskDir, 'artifacts/old.png'), 'different bytes');
  const result = await readAcceptanceStatusForDisplay(LOCAL, f.taskDir);
  assert.equal(result.error, undefined);
  assert.equal(result.evidenceLinks, undefined);
  assert.match(result.evidenceLinksError ?? '', /retained bytes changed: artifacts\/old.png/);
});

test('changed manifest or handoff cannot silently rebind retained links', async (t) => {
  for (const ref of ['artifacts/evidence-manifest.json', 'inputs/handoff.json']) {
    const f = await fixture(t);
    await importRetainedAcceptanceLinks(f.bytes(), f.root);
    // Whitespace changes preserve registered criteria but alter the original digest.
    await writeFile(
      path.join(f.taskDir, ref),
      `${await readFile(path.join(f.taskDir, ref), 'utf8')}\n`,
    );
    const result = await readAcceptanceStatusForDisplay(LOCAL, f.taskDir);
    assert.equal(result.evidenceLinks, undefined);
    assert.match(result.evidenceLinksError ?? '', /retained bytes changed/);
  }
});

test('a ledger takes precedence, including its own corruption error', async (t) => {
  const f = await fixture(t);
  await importRetainedAcceptanceLinks(f.bytes(), f.root);
  await writeFile(path.join(f.taskDir, 'artifacts/old.png'), 'changed retained bytes');
  const ledger = {
    schemaVersion: 2,
    recipeRunId: 'execution',
    recording: { status: 'not-required', segments: [] },
    criteria: [
      {
        ...CRITERIA[0],
        kind: 'acceptance',
        verdict: 'proven',
        proofMode: 'state',
        evidence: [],
        recipeNodes: ['assert'],
        assertionIndices: [0],
        moments: [],
      },
    ],
  };
  await writeFile(path.join(f.taskDir, 'artifacts/acceptance-status.json'), JSON.stringify(ledger));
  assert.deepEqual(await readAcceptanceStatusForDisplay(LOCAL, f.taskDir), {
    criteria: CRITERIA,
    ledger,
    source: 'ledger',
  });
  await writeFile(path.join(f.taskDir, 'artifacts/acceptance-status.json'), '{ broken');
  const corrupt = await readAcceptanceStatusForDisplay(LOCAL, f.taskDir);
  assert.match(corrupt.error ?? '', /invalid .*acceptance-status/);
  assert.equal(corrupt.evidenceLinksError, undefined);
  assert.equal(corrupt.evidenceLinks, undefined);
});

test('validation of the entire inventory precedes writes', async (t) => {
  const f = await fixture(t);
  f.inventory.records.push({ ...f.inventory.records[0], task: 'missing-task' });
  await assert.rejects(() => importRetainedAcceptanceLinks(f.bytes(), f.root), /ENOENT/);
  await assert.rejects(() => readFile(f.snapshotPath), /ENOENT/);
});

test('inventory refuses unknown criteria, paths, extra references and changed bytes', async (t) => {
  for (const kind of ['id', 'path', 'extra', 'digest', 'source']) {
    const f = await fixture(t);
    f.inventory = structuredClone(f.inventory);
    const row = f.inventory.records[0];
    if (kind === 'id') row.links = [{ id: 'AC-99', evidence: ['artifacts/old.png'] }];
    if (kind === 'path') row.links = [{ id: 'AC-1', evidence: ['artifacts/../outside.png'] }];
    if (kind === 'extra') row.refs.push({ ...row.refs[0], path: 'artifacts/extra.png' });
    if (kind === 'digest') row.manifestSha256 = 'f'.repeat(64);
    if (kind === 'source') f.inventory.frozenSource = 'f'.repeat(40);
    await assert.rejects(() =>
      importRetainedAcceptanceLinks(Buffer.from(JSON.stringify(f.inventory)), f.root),
    );
    await assert.rejects(() => readFile(f.snapshotPath), /ENOENT/);
  }
});

test('task and asset symlink escapes refuse import', async (t) => {
  const f = await fixture(t);
  const outside = path.join(f.root, 'outside.png');
  await writeFile(outside, 'original image bytes');
  await rm(path.join(f.taskDir, 'artifacts/old.png'));
  await symlink(outside, path.join(f.taskDir, 'artifacts/old.png'));
  await assert.rejects(() => importRetainedAcceptanceLinks(f.bytes(), f.root), /escapes task/);
  await assert.rejects(() => readFile(f.snapshotPath), /ENOENT/);
  await symlink(f.taskDir, path.join(f.root, 'alias'));
  f.inventory.records[0].task = 'alias';
  await assert.rejects(() => importRetainedAcceptanceLinks(f.bytes(), f.root), /not a symlink/);
});

test('an existing ledger or different snapshot refuses replacement', async (t) => {
  const f = await fixture(t);
  const ledgerPath = path.join(f.taskDir, 'artifacts/acceptance-status.json');
  await writeFile(ledgerPath, '{}');
  await assert.rejects(() => importRetainedAcceptanceLinks(f.bytes(), f.root), /existing ledger/);
  await rm(ledgerPath);
  await importRetainedAcceptanceLinks(f.bytes(), f.root);
  const before = await readFile(f.snapshotPath);
  f.inventory.records[0].links = [];
  f.inventory.records[0].refs = [];
  await assert.rejects(
    () => importRetainedAcceptanceLinks(f.bytes(), f.root),
    /replacement refused/,
  );
  assert.deepEqual(await readFile(f.snapshotPath), before);
});

test('corrupt snapshot fields and copied identities produce a display error', async (t) => {
  const f = await fixture(t);
  await importRetainedAcceptanceLinks(f.bytes(), f.root);
  const snapshot = JSON.parse(await readFile(f.snapshotPath, 'utf8'));
  for (const changed of [
    { ...snapshot, taskDir: f.root },
    { ...snapshot, verdict: 'proven' },
    { ...snapshot, schemaVersion: 2 },
  ]) {
    await writeFile(f.snapshotPath, JSON.stringify(changed));
    const result = await readAcceptanceStatusForDisplay(LOCAL, f.taskDir);
    assert.equal(result.evidenceLinks, undefined);
    assert.match(result.evidenceLinksError ?? '', /retained acceptance links:/);
    assert.equal(result.error, undefined);
  }
});
