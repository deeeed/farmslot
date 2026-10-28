import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import type { ActiveVideoRecording } from '../src/core/types.js';
import { createCdpVideoRecorder } from '../src/recording/cdp-video-recorder.js';
import { CdpSession } from '../src/runtime/cdp.js';

test('createCdpVideoRecorder exposes web cdp-screencast recorder metadata', () => {
  const recorder = createCdpVideoRecorder({ cdpPort: 9323, urlIncludes: '#fleet' });
  assert.equal(recorder.name, 'cdp-screencast');
  assert.equal(recorder.platform, 'web');
  assert.equal(typeof recorder.doctor, 'function');
  assert.equal(typeof recorder.start, 'function');
});

test('proof snapshots survive encoder overload and recording resumes after the queue drains', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cdp-snapshot-source-'));
  let active: ActiveVideoRecording | undefined;
  let stopped = false;
  t.after(async () => {
    try {
      if (active && !stopped) await active.stop();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  const encoder = path.join(root, 'encoder');
  await writeFile(
    encoder,
    `#!${process.execPath}\nconst fs=require('node:fs'),path=require('node:path');
const args=process.argv.slice(2),list=args[args.indexOf('-i')+1];
const frames=fs.readFileSync(list,'utf8').split('\\n').filter(line=>line.startsWith('file ')).map(line=>fs.readFileSync(path.join(path.dirname(list),line.slice(6,-1))).subarray(0,16).toString());
fs.writeFileSync(args.at(-1),JSON.stringify(frames));\n`,
    { mode: 0o700 },
  );
  let listener: ((params: Record<string, unknown>) => void) | undefined;
  const acknowledged: unknown[] = [];
  const start = Date.now();
  const emit = (offset: number, text: string) =>
    listener!({
      metadata: { timestamp: (start + offset) / 1000 },
      data: Buffer.from(text).toString('base64'),
      sessionId: offset + 1,
    });
  t.mock.method(
    globalThis,
    'fetch',
    async () =>
      new Response(
        JSON.stringify([
          { id: 'page', type: 'page', url: 'http://fixture', webSocketDebuggerUrl: 'ws://fixture' },
        ]),
      ),
  );
  t.mock.method(CdpSession, 'connect', async () => ({
    on(_event: string, receive: typeof listener) {
      listener = receive;
      return () => {
        listener = undefined;
      };
    },
    close() {},
    async call(method: string, params: Record<string, unknown> = {}) {
      if (method === 'Page.screencastFrameAck') acknowledged.push(params.sessionId);
      if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'main' } } };
      if (method === 'Page.createIsolatedWorld') return { executionContextId: 1 };
      if (method === 'Runtime.evaluate') return { result: { value: Date.now() } };
      if (method === 'Page.startScreencast') emit(0, 'count=1');
      return {};
    },
  }));
  active = await createCdpVideoRecorder({ cdpPort: 9323, ffmpegPath: encoder }).start({
    target: { kind: 'cdp-page', host: '127.0.0.1', port: 9323, targetId: 'page' },
    outputPath: path.join(root, 'source.mp4'),
    nodeId: 'run',
    record: 'full_run',
    maxFps: 15,
  });
  const snapshot = path.join(root, 'proof.png');
  await active.snapshot!(snapshot);
  emit(3, 'count=2');
  // Queue two 6 MiB frames without yielding. The next two must be dropped,
  // rather than growing the queue or interrupting the recording.
  for (const [index, value] of ['a', 'b', 'c', 'd'].entries()) {
    emit((index + 1) * 100, value.repeat(6 * 1024 * 1024));
  }
  await active.snapshot!(path.join(root, 'after-pressure.png'));
  emit(150, 'late-repaint');
  emit(600, 'count=3');
  stopped = true;
  const result = await active.stop();
  const encoded = JSON.parse(await readFile(path.join(root, result.segments[0]!.path), 'utf8'));
  assert.equal(await readFile(snapshot, 'utf8'), 'count=1');
  assert.ok(encoded.includes('count=1'), 'the source frame must survive sampling');
  assert.ok(encoded.includes('count=2'), 'the next repaint must also survive');
  assert.ok(encoded.includes('a'.repeat(16)));
  assert.ok(encoded.includes('b'.repeat(16)));
  assert.ok(!encoded.includes('c'.repeat(16)), 'over-budget frames must be dropped');
  assert.ok(!encoded.includes('d'.repeat(16)), 'the queue must stay bounded');
  assert.ok(!encoded.includes('late-repaint'), 'late source frames must be dropped');
  assert.ok(encoded.includes('count=3'), 'capture must recover after draining');
  assert.equal(result.interruption, undefined);
  assert.deepEqual(acknowledged, [1, 4, 101, 201, 301, 401, 151, 601]);
});
