import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import type { ContentPrefetchMediaEntry } from '@farmslot/protocol/client-cache';

import {
  artifactSource,
  artifactUrl,
  heldArtifactFile,
  heldArtifactsRevision,
  setHeldArtifactLookup,
  subscribeHeldArtifacts,
} from './artifact-url';
import { createEvidenceMediaHolder, type EvidenceMediaFiles } from './evidence-media';

const DIRECTORY = 'file:///cache/evidence-media/scope/';
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const bytes = (fill: number, length: number) => new Uint8Array(length).fill(fill);
const signal = new AbortController().signal;

/** Files in memory, with the gateway's artifacts by URL. `gate` pauses hashing when set. */
function memoryFiles(served: Map<string, Uint8Array>) {
  const disk = new Map<string, Uint8Array | string>();
  const downloads: string[] = [];
  const control: { gate?: Promise<void>; removal?: Promise<void>; stall?: boolean } = {};
  const files: EvidenceMediaFiles = {
    directory: DIRECTORY,
    async size(uri) {
      const value = disk.get(uri);
      return value instanceof Uint8Array ? value.length : undefined;
    },
    async download(source, to, signal) {
      downloads.push(source.uri);
      const body = served.get(source.uri);
      if (!body) throw new Error('HTTP 404');
      if (control.stall) {
        // Half the body arrives, then the transfer waits until it is cancelled.
        disk.set(to, body.slice(0, body.length / 2));
        await new Promise((resolve) => signal.addEventListener('abort', resolve));
        throw new Error('Download cancelled');
      }
      disk.set(to, body);
      return body.length;
    },
    async read(uri, position, length) {
      await control.gate;
      return (disk.get(uri) as Uint8Array).slice(position, position + length);
    },
    async move(from, to) {
      disk.set(to, disk.get(from)!);
      disk.delete(from);
    },
    async remove(uri) {
      await control.removal;
      disk.delete(uri);
    },
    async readText(uri) {
      const value = disk.get(uri);
      return typeof value === 'string' ? value : undefined;
    },
    async writeText(uri, text) {
      disk.set(uri, text);
    },
    async clear() {
      for (const key of [...disk.keys()]) if (key.startsWith(DIRECTORY)) disk.delete(key);
    },
  };
  const media = () => [...disk.keys()].filter((key) => !key.endsWith('index.json'));
  return { files, disk, downloads, control, media };
}

function setup({ limitBytes = 1000, allowed = true } = {}) {
  const served = new Map<string, Uint8Array>();
  const memory = memoryFiles(served);
  const network = { allowed };
  const logs: string[] = [];
  const holder = createEvidenceMediaHolder({
    files: memory.files,
    source: (entry) => ({ uri: `https://gw/${entry.runId}/${entry.bundleDigest}/${entry.path}` }),
    allowed: () => network.allowed,
    limitBytes,
    log: (message) => logs.push(message),
  });
  const entry = (
    runId: string,
    path: string,
    body: Uint8Array,
    { gateAt = 1, bundleDigest = 'b1', sha256 = digest(body) } = {},
  ): ContentPrefetchMediaEntry => {
    served.set(`https://gw/${runId}/${bundleDigest}/${path}`, body);
    return { runId, path, bundleDigest, sha256, sizeBytes: body.length, gateAt };
  };
  return { holder, entry, network, logs, ...memory };
}

test('a decided gate drops its media; a file another gate still uses stays', async () => {
  const { holder, entry, media } = setup();
  const shared = bytes(1, 100);
  assert.equal(await holder.hold(entry('a', 'run.mp4', shared), signal), true);
  assert.equal(await holder.hold(entry('a', 'only-a.mp4', bytes(2, 50)), signal), true);
  assert.equal(await holder.hold(entry('b', 'run.mp4', shared), signal), true);

  await holder.keep(new Set(['b']));
  assert.equal(holder.byPath('a', 'only-a.mp4', 'b1'), undefined);
  assert.deepEqual(media(), [`${DIRECTORY}${digest(shared)}.mp4`]);
  assert.equal(holder.byPath('b', 'run.mp4', 'b1'), `${DIRECTORY}${digest(shared)}.mp4`);

  await holder.keep(new Set());
  assert.deepEqual(holder.totals(), { bytes: 0, files: 0, runs: 0 });
  assert.deepEqual(media(), []);
});

test('a digest is downloaded once, even for two gates at the same time', async () => {
  const { holder, entry, downloads } = setup();
  const body = bytes(3, 80);
  const first = entry('a', 'run.mp4', body);
  const second = entry('b', 'other-name.mp4', body);
  assert.deepEqual(await Promise.all([holder.hold(first, signal), holder.hold(second, signal)]), [
    true,
    true,
  ]);
  assert.equal(await holder.hold(first, signal), true);
  assert.equal(downloads.length, 1);
  assert.equal(holder.byPath('b', 'other-name.mp4', 'b1'), holder.byPath('a', 'run.mp4', 'b1'));
});

test('a republished gate never shows the previous package, even when its media cannot load', async () => {
  const { holder, entry, network, media } = setup();
  const first = bytes(4, 40);
  assert.equal(
    await holder.hold(entry('g1', 'run.mp4', first, { bundleDigest: 'p1' }), signal),
    true,
  );
  network.allowed = false;
  const next = entry('g1', 'run.mp4', bytes(5, 40), { bundleDigest: 'p2' });
  assert.equal(await holder.hold(next, signal), false);
  assert.equal(holder.byPath('g1', 'run.mp4', 'p2'), undefined);
  assert.equal(holder.byPath('g1', 'run.mp4', 'p1'), undefined);
  assert.deepEqual(media(), []);
});

test('the bound displaces only older gates; an older gate filling late is skipped', async () => {
  const { holder, entry, downloads } = setup({ limitBytes: 100 });
  assert.equal(
    await holder.hold(entry('newer', 'b.mp4', bytes(6, 60), { gateAt: 2 }), signal),
    true,
  );
  // Prefetch fills newest first, so an older gate arrives last: it must not evict the newer one.
  assert.equal(
    await holder.hold(entry('older', 'a.mp4', bytes(7, 60), { gateAt: 1 }), signal),
    false,
  );
  assert.ok(holder.byPath('newer', 'b.mp4', 'b1'));
  assert.equal(downloads.length, 1);
  // A newest gate does displace the older ones.
  assert.equal(
    await holder.hold(entry('newest', 'c.mp4', bytes(8, 60), { gateAt: 3 }), signal),
    true,
  );
  assert.equal(holder.byPath('newer', 'b.mp4', 'b1'), undefined);
  assert.equal(holder.totals().bytes, 60);
});

test('two downloads at once never exceed the bound', async () => {
  const { holder, entry } = setup({ limitBytes: 100 });
  const results = await Promise.all([
    holder.hold(entry('a', 'a.mp4', bytes(9, 60), { gateAt: 1 }), signal),
    holder.hold(entry('b', 'b.mp4', bytes(10, 60), { gateAt: 2 }), signal),
  ]);
  // Both verify at once; commits run one at a time, and the newer gate displaces the older.
  assert.ok(results[1]);
  assert.ok(holder.totals().bytes <= 100);
  assert.ok(holder.byPath('b', 'b.mp4', 'b1'));
  assert.equal(holder.byPath('a', 'a.mp4', 'b1'), undefined);
});

test('off a LAN route nothing large downloads; media already held still serves', async () => {
  const { holder, entry, network, downloads } = setup();
  const body = bytes(11, 40);
  assert.equal(await holder.hold(entry('a', 'run.mp4', body), signal), true);
  network.allowed = false;
  assert.equal(await holder.hold(entry('b', 'other.mp4', bytes(12, 40)), signal), false);
  assert.equal(await holder.hold(entry('c', 'same.mp4', body), signal), true);
  assert.equal(downloads.length, 1);
});

test('bytes that do not hash to the manifest digest are never kept', async () => {
  const { holder, entry, media } = setup();
  const wrong = entry('a', 'run.mp4', bytes(13, 30), { sha256: 'f'.repeat(64) });
  assert.equal(await holder.hold(wrong, signal), false);
  assert.equal(holder.byPath('a', 'run.mp4', 'b1'), undefined);
  assert.deepEqual(media(), []);
});

test('sign-out while a file is verifying keeps nothing, and destroy deletes every held file', async () => {
  const { holder, entry, control, media } = setup();
  assert.equal(await holder.hold(entry('a', 'kept.mp4', bytes(14, 20)), signal), true);
  let release!: () => void;
  control.gate = new Promise((resolve) => (release = resolve));
  const pending = holder.hold(entry('b', 'late.mp4', bytes(15, 20)), signal);
  await new Promise((resolve) => setImmediate(resolve));
  const destroyed = holder.destroy();
  release();
  assert.equal(await pending, false);
  await destroyed;
  assert.deepEqual(media(), []);
  assert.equal(holder.byPath('a', 'kept.mp4', 'b1'), undefined);
  assert.equal(holder.byDigest(digest(bytes(14, 20))), undefined);
});

test('sign-out cancels a download in flight and deletes its partial file', async () => {
  const { holder, entry, control, disk, logs } = setup();
  control.stall = true;
  const pending = holder.hold(entry('a', 'run.mp4', bytes(17, 20)), signal);
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok([...disk.keys()].some((key) => key.endsWith('.part')));
  await holder.destroy();
  assert.equal(await pending, false);
  assert.deepEqual([...disk.keys()], []);
  // A cancelled transfer is no download failure.
  assert.deepEqual(logs, ['[evidence-media] cleared']);
});

test('the index survives a restart; an unreadable one is cleared rather than trusted', async () => {
  const first = setup();
  const body = bytes(16, 20);
  await first.holder.hold(first.entry('a', 'run.mp4', body), signal);
  const restarted = createEvidenceMediaHolder({
    files: first.files,
    source: () => ({ uri: 'unused' }),
    allowed: () => false,
  });
  await restarted.keep(new Set(['a']));
  assert.equal(restarted.byPath('a', 'run.mp4', 'b1'), first.holder.byPath('a', 'run.mp4', 'b1'));

  first.disk.set(`${DIRECTORY}index.json`, '{not json');
  const corrupt = createEvidenceMediaHolder({
    files: first.files,
    source: () => ({ uri: 'unused' }),
    allowed: () => false,
  });
  await corrupt.keep(new Set(['a']));
  assert.equal(corrupt.byPath('a', 'run.mp4', 'b1'), undefined);
  assert.deepEqual(first.media(), []);
});

test('a file the OS reclaimed is forgotten at start and downloads again', async () => {
  const first = setup();
  const body = bytes(17, 20);
  const held = first.entry('a', 'run.mp4', body);
  assert.equal(await first.holder.hold(held, signal), true);
  first.disk.delete(`${DIRECTORY}${digest(body)}.mp4`);
  const restarted = createEvidenceMediaHolder({
    files: first.files,
    source: (entry) => ({ uri: `https://gw/${entry.runId}/${entry.bundleDigest}/${entry.path}` }),
    allowed: () => true,
  });
  await restarted.keep(new Set(['a']));
  assert.equal(restarted.byPath('a', 'run.mp4', 'b1'), undefined);
  assert.equal(await restarted.hold(held, signal), true);
  assert.equal(first.downloads.length, 2);
  assert.ok(restarted.byPath('a', 'run.mp4', 'b1'));
});

test("a package replacement in progress never deletes another gate's hold of the same file", async () => {
  const { holder, entry, control, media } = setup();
  const shared = bytes(18, 30);
  assert.equal(
    await holder.hold(entry('g1', 'run.mp4', shared, { bundleDigest: 'p1' }), signal),
    true,
  );
  let release!: () => void;
  control.removal = new Promise((resolve) => (release = resolve));
  // g1 moves to a package whose media fails verification: its old file, no longer used, is
  // removed, and that removal is paused while another gate asks for the same file.
  const next = entry('g1', 'run.mp4', bytes(19, 30), {
    bundleDigest: 'p2',
    sha256: 'f'.repeat(64),
  });
  const replaced = holder.hold(next, signal);
  await new Promise((resolve) => setImmediate(resolve));
  const other = holder.hold(entry('g2', 'same.mp4', shared), signal);
  release();
  assert.deepEqual(await Promise.all([replaced, other]), [false, true]);
  // The other gate's mapping points at a file that is really there.
  assert.equal(holder.byPath('g2', 'same.mp4', 'b1'), `${DIRECTORY}${digest(shared)}.mp4`);
  assert.deepEqual(media(), [`${DIRECTORY}${digest(shared)}.mp4`]);
});

test('readers hear when the held index is read and when held files change', async () => {
  const { holder, entry } = setup();
  let heard = 0;
  setHeldArtifactLookup(holder);
  const stop = subscribeHeldArtifacts(() => heard++);
  try {
    const start = heldArtifactsRevision();
    await holder.keep(new Set(['a']));
    assert.equal(await holder.hold(entry('a', 'run.mp4', bytes(20, 10)), signal), true);
    assert.ok(heldArtifactsRevision() > start);
    assert.ok(heard >= 2, 'the index read and the new file both signal');
  } finally {
    stop();
    setHeldArtifactLookup(undefined);
  }
});

test('the log says how many gates wait and why an entry was skipped', async () => {
  const served = new Map<string, Uint8Array>();
  const memory = memoryFiles(served);
  const lines: string[] = [];
  const network = { allowed: false };
  const holder = createEvidenceMediaHolder({
    files: memory.files,
    source: () => ({ uri: 'https://gw/none' }),
    allowed: () => network.allowed,
    limitBytes: 50,
    log: (line) => lines.push(line),
  });
  await holder.keep(new Set());
  await holder.keep(new Set());
  await holder.keep(new Set(['abcdef1234']));
  const body = bytes(21, 10);
  const entry = (sizeBytes: number) => ({
    runId: 'abcdef1234',
    path: 'videos/run.mp4',
    bundleDigest: 'b1',
    sha256: digest(body),
    sizeBytes,
    gateAt: 1,
  });
  assert.equal(await holder.hold(entry(10), signal), false);
  network.allowed = true;
  assert.equal(await holder.hold(entry(60), signal), false);
  assert.deepEqual(lines, [
    '[evidence-media] gates waiting: 0',
    '[evidence-media] gates waiting: 1 (abcdef12)',
    '[evidence-media] skipped videos/run.mp4: not on a LAN route',
    '[evidence-media] skipped videos/run.mp4: no room (60 B)',
  ]);
});

test('artifact sources read held evidence of the same package silently; images by digest', () => {
  const held = 'file:///cache/evidence-media/scope/abc.mp4';
  setHeldArtifactLookup({
    subscribe: () => () => undefined,
    byPath: (runId, path, bundleDigest) =>
      runId === 'run-1' && path === 'evidence/run 1.mp4' && bundleDigest === 'bundle'
        ? held
        : undefined,
    byDigest: (sha256) => (sha256 === 'abc' ? held : undefined),
  });
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
    const otherPackage = artifactUrl(
      'ws://gw:7801',
      'run-1',
      'evidence/run 1.mp4',
      undefined,
      undefined,
      'next',
    );
    assert.equal(artifactSource(otherPackage).uri, otherPackage);
    const recipe = artifactUrl('ws://gw:7801', 'run-1', 'evidence/run 1.mp4', 'recipe-1');
    assert.equal(artifactSource(recipe).uri, recipe);
    assert.equal(heldArtifactFile('abc'), held);
    assert.equal(heldArtifactFile('other'), undefined);
  } finally {
    setHeldArtifactLookup(undefined);
  }
});
