import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import type { ContentPrefetchMediaEntry } from '@farmslot/protocol/client-cache';

import { artifactSource, artifactUrl, setHeldArtifactLookup } from './artifact-url';
import { createEvidenceMediaHolder, type EvidenceMediaFiles } from './evidence-media';

const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const bytes = (fill: number, length: number) => new Uint8Array(length).fill(fill);

/** Files in memory, with the gateway's artifacts by URL. */
function memoryFiles(served: Map<string, Uint8Array>) {
  const disk = new Map<string, Uint8Array | string>();
  const downloads: string[] = [];
  const files: EvidenceMediaFiles = {
    directory: 'file:///docs/evidence-media/',
    async size(uri) {
      const value = disk.get(uri);
      return value === undefined
        ? undefined
        : typeof value === 'string'
          ? value.length
          : value.length;
    },
    async download(source, to) {
      downloads.push(source.uri);
      const body = served.get(source.uri);
      if (!body) throw new Error('HTTP 404');
      disk.set(to, body);
      return body.length;
    },
    async read(uri, position, length) {
      return (disk.get(uri) as Uint8Array).slice(position, position + length);
    },
    async move(from, to) {
      disk.set(to, disk.get(from)!);
      disk.delete(from);
    },
    async remove(uri) {
      disk.delete(uri);
    },
    async readText(uri) {
      const value = disk.get(uri);
      return typeof value === 'string' ? value : undefined;
    },
    async writeText(uri, text) {
      disk.set(uri, text);
    },
  };
  return { files, disk, downloads };
}

function setup({ limitBytes = 1000, allowed = true } = {}) {
  const served = new Map<string, Uint8Array>();
  const memory = memoryFiles(served);
  const network = { allowed };
  const holder = createEvidenceMediaHolder({
    files: memory.files,
    source: (entry) => ({ uri: `https://gw/${entry.runId}/${entry.path}` }),
    allowed: () => network.allowed,
    limitBytes,
  });
  const entry = (
    runId: string,
    path: string,
    body: Uint8Array,
    gateAt = 1,
    sha256 = digest(body),
  ): ContentPrefetchMediaEntry => {
    served.set(`https://gw/${runId}/${path}`, body);
    return { runId, path, sha256, sizeBytes: body.length, gateAt };
  };
  return { holder, entry, network, ...memory };
}

const signal = new AbortController().signal;

test('a decided gate drops its media; a file another gate still uses stays', async () => {
  const { holder, entry, disk } = setup();
  const shared = bytes(1, 100);
  assert.equal(await holder.hold(entry('a', 'evidence/run.mp4', shared), signal), true);
  assert.equal(await holder.hold(entry('a', 'evidence/only-a.mp4', bytes(2, 50)), signal), true);
  assert.equal(await holder.hold(entry('b', 'evidence/run.mp4', shared), signal), true);

  await holder.keep(new Set(['b']));
  assert.equal(holder.localUri('a', 'evidence/only-a.mp4'), undefined);
  assert.equal(disk.has(`file:///docs/evidence-media/${digest(bytes(2, 50))}.mp4`), false);
  assert.equal(
    holder.localUri('b', 'evidence/run.mp4'),
    `file:///docs/evidence-media/${digest(shared)}.mp4`,
  );

  await holder.keep(new Set());
  assert.deepEqual(holder.totals(), { bytes: 0, files: 0, runs: 0 });
});

test('a digest is downloaded once, even for two gates at the same time', async () => {
  const { holder, entry, downloads } = setup();
  const body = bytes(3, 80);
  const first = entry('a', 'evidence/run.mp4', body);
  const second = entry('b', 'evidence/other-name.mp4', body);
  assert.deepEqual(await Promise.all([holder.hold(first, signal), holder.hold(second, signal)]), [
    true,
    true,
  ]);
  assert.equal(await holder.hold(first, signal), true);
  assert.equal(downloads.length, 1);
  assert.equal(
    holder.localUri('b', 'evidence/other-name.mp4'),
    holder.localUri('a', 'evidence/run.mp4'),
  );
});

test('past the bound the oldest gate goes first, and media larger than the bound is skipped', async () => {
  const { holder, entry, downloads } = setup({ limitBytes: 100 });
  assert.equal(await holder.hold(entry('old', 'a.mp4', bytes(4, 60), 1), signal), true);
  assert.equal(await holder.hold(entry('new', 'b.mp4', bytes(5, 60), 2), signal), true);
  assert.equal(holder.localUri('old', 'a.mp4'), undefined);
  assert.ok(holder.localUri('new', 'b.mp4'));
  assert.equal(holder.totals().bytes, 60);

  assert.equal(await holder.hold(entry('big', 'c.mp4', bytes(6, 101), 3), signal), false);
  assert.equal(downloads.length, 2);
});

test('off a LAN route nothing large downloads; media already held still serves', async () => {
  const { holder, entry, network, downloads } = setup();
  const body = bytes(7, 40);
  assert.equal(await holder.hold(entry('a', 'run.mp4', body), signal), true);
  network.allowed = false;
  assert.equal(await holder.hold(entry('b', 'other.mp4', bytes(8, 40)), signal), false);
  assert.equal(await holder.hold(entry('c', 'same.mp4', body), signal), true);
  assert.equal(downloads.length, 1);
});

test('bytes that do not hash to the manifest digest are never kept', async () => {
  const { holder, entry, disk } = setup();
  const wrong = entry('a', 'run.mp4', bytes(9, 30), 1, 'f'.repeat(64));
  assert.equal(await holder.hold(wrong, signal), false);
  assert.equal(holder.localUri('a', 'run.mp4'), undefined);
  assert.deepEqual(
    [...disk.keys()].filter((key) => !key.endsWith('index.json')),
    [],
  );
});

test('the index survives a restart, so held media plays offline from a cold start', async () => {
  const first = setup();
  const body = bytes(10, 20);
  await first.holder.hold(first.entry('a', 'run.mp4', body), signal);
  const restarted = createEvidenceMediaHolder({
    files: first.files,
    source: () => ({ uri: 'unused' }),
    allowed: () => false,
  });
  await restarted.keep(new Set(['a']));
  assert.equal(restarted.localUri('a', 'run.mp4'), first.holder.localUri('a', 'run.mp4'));
});

test('artifactSource reads held evidence silently from the device, anything else from the gateway', () => {
  const held = 'file:///docs/evidence-media/abc.mp4';
  setHeldArtifactLookup((runId, path) =>
    runId === 'run-1' && path === 'evidence/run 1.mp4' ? held : undefined,
  );
  try {
    const url = artifactUrl(
      'ws://gw:7801',
      'run-1',
      'evidence/run 1.mp4',
      undefined,
      undefined,
      'bundle',
    );
    assert.deepEqual(artifactSource(url, { Authorization: 'Bearer x' }), { uri: held });
    const recipe = artifactUrl('ws://gw:7801', 'run-1', 'evidence/run 1.mp4', 'recipe-1');
    assert.equal(artifactSource(recipe).uri, recipe);
    const other = artifactUrl('ws://gw:7801', 'run-1', 'evidence/other.mp4');
    assert.equal(artifactSource(other).uri, other);
  } finally {
    setHeldArtifactLookup(undefined);
  }
});
