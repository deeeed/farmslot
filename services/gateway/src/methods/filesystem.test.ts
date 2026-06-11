import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test, { type TestContext } from 'node:test';

import { WebSocket } from 'ws';

import { poolDir } from '../core/config.js';
import { registerNode, unregisterByWs } from '../fleet/machine-registry.js';
import { handleNodeResponse } from '../fleet/node-rpc.js';
import { createRun, deleteRun, updateRun } from '../runs/store.js';

import {
  fsDelete,
  fsList,
  fsRead,
  fsWrite,
  serveFile,
  serveRunArtifact,
  shouldServeRecipeArtifactFromLocalCache,
} from './filesystem.js';

class FakeNodeWebSocket {
  readyState = WebSocket.OPEN;
  listCalls = 0;
  readTextCalls = 0;
  statCalls = 0;
  readCalls = 0;
  realpathCalls = 0;

  constructor(
    private readonly handlers: {
      onList?: (params: { path: string }) => {
        entries: Array<{ name: string; type: string; size?: number }>;
      };
      onReadText?: (params: { path: string }) => { content: string };
      onStat?: (params: { path: string }) => { size: number };
      onRead?: (params: { path: string }) => { content: string };
      onRealpath?: (params: { path: string }) => { path: string };
    },
  ) {}

  send(raw: string) {
    const frame = JSON.parse(raw) as { id: string; method: string; params: { path: string } };
    queueMicrotask(() => {
      if (frame.method === 'fs.list') {
        this.listCalls += 1;
        handleNodeResponse(frame.id, true, this.handlers.onList?.(frame.params) ?? { entries: [] });
        return;
      }
      if (frame.method === 'fs.read') {
        this.readTextCalls += 1;
        if (!this.handlers.onReadText) {
          handleNodeResponse(frame.id, false, null, `ENOENT: ${frame.params.path}`);
          return;
        }
        handleNodeResponse(frame.id, true, this.handlers.onReadText(frame.params));
        return;
      }
      if (frame.method === 'fs.stat') {
        this.statCalls += 1;
        handleNodeResponse(frame.id, true, this.handlers.onStat?.(frame.params) ?? { size: 0 });
        return;
      }
      if (frame.method === 'fs.readBase64') {
        this.readCalls += 1;
        handleNodeResponse(
          frame.id,
          true,
          this.handlers.onRead?.(frame.params) ?? { content: Buffer.from('ok').toString('base64') },
        );
        return;
      }
      if (frame.method === 'fs.realpath') {
        this.realpathCalls += 1;
        handleNodeResponse(
          frame.id,
          true,
          this.handlers.onRealpath?.(frame.params) ?? frame.params,
        );
        return;
      }
      handleNodeResponse(frame.id, false, null, `unexpected method ${frame.method}`);
    });
  }
}

class MockResponse extends PassThrough {
  statusCode = 200;
  headers: Record<string, string | number | string[]> = {};
  body = '';

  constructor() {
    super();
    this.on('data', (chunk) => {
      this.body += chunk.toString();
    });
  }

  writeHead(statusCode: number, headers: Record<string, string | number | string[]>) {
    this.statusCode = statusCode;
    this.headers = headers;
    return this;
  }
}

async function withLocalSlot(
  t: TestContext,
  fn: (args: { slotId: string; repoDir: string }) => Promise<void>,
) {
  const repoDir = await mkdtemp(path.join(tmpdir(), 'farmslot-local-filesystem-'));
  await mkdir(poolDir, { recursive: true });
  const slotId = `local-slot-${path.basename(repoDir)}`;
  const poolFile = path.join(poolDir, `${slotId}.json`);
  await writeFile(
    poolFile,
    JSON.stringify({
      machine: 'local-test-machine',
      project: 'demo-project',
      platform: 'ios',
      os: process.platform === 'darwin' ? 'darwin' : 'linux',
      host: 'localhost',
      ssh_user: 'tester',
      slots: [
        {
          id: slotId,
          repo: repoDir,
          session: 'slot',
        },
      ],
    }),
    'utf-8',
  );

  t.after(async () => {
    await rm(repoDir, { recursive: true, force: true });
    await rm(poolFile, { force: true });
  });

  await fn({ slotId, repoDir });
}

async function withRemoteRun(
  t: TestContext,
  fn: (args: {
    runId: string;
    liveRecipeRunId: string;
    liveGroupId: string;
    taskDir: string;
    liveRunDir: string;
    remoteArtifactRoot: string;
    remoteLatestValidPointerPath: string;
    poolFile: string;
  }) => Promise<void>,
) {
  const root = await mkdtemp(path.join(tmpdir(), 'farmslot-filesystem-'));
  const taskDir = path.join(root, 'tasks', 'remote-artifacts');
  const artifactsDir = path.join(taskDir, 'artifacts');
  const liveRunDir = path.join(artifactsDir, 'recipe-runs', 'live-run');
  const remoteArtifactRoot = '/tmp/repo/.task/remote-artifacts/artifacts/recipe-runs/live-run';
  const remoteLatestValidPointerPath =
    '/tmp/repo/.task/remote-artifacts/artifacts/latest-valid-recipe-run.json';
  await mkdir(liveRunDir, { recursive: true });
  await writeFile(path.join(taskDir, 'TASK.md'), '# task\n', 'utf-8');
  await writeFile(
    path.join(liveRunDir, 'summary.json'),
    JSON.stringify({ status: 'pass' }),
    'utf-8',
  );
  await writeFile(
    path.join(artifactsDir, 'latest-valid-recipe-run.json'),
    JSON.stringify({
      version: 1,
      runId: 'live-run',
      relativeArtifactRoot: 'recipe-runs/live-run',
      updatedAt: '2026-05-28T00:00:00.000Z',
    }),
    'utf-8',
  );
  const run = createRun({
    flowType: 'dev',
    project: 'demo-project',
    ticketOrPr: 'PROJ-1',
    mode: 'interactive',
    slotId: 'remote-slot',
    taskFile: path.join(taskDir, 'TASK.md'),
  });
  updateRun(run.id, {
    status: 'done',
    liveRecipeContext: {
      source: 'recipe-run-artifacts',
      recipeRunId: 'live-run',
      artifactRoot: liveRunDir,
      artifactManifest: [{ path: 'artifacts/summary.json', purpose: 'other' }],
      recipeJson: null,
      recipeQualityArtifact: null,
      qualityReport: null,
      workerLearnings: null,
      isStale: false,
      selectionReason: 'user-selected',
    },
  });

  await mkdir(poolDir, { recursive: true });
  const poolFile = path.join(poolDir, `remote-slot-test-${run.id}.json`);
  await writeFile(
    poolFile,
    JSON.stringify({
      machine: 'remote-machine',
      project: 'demo-project',
      platform: 'ios',
      os: 'linux',
      host: '203.0.113.10',
      ssh_user: 'tester',
      slots: [
        {
          id: 'remote-slot',
          repo: '/tmp/repo',
          session: 'slot',
        },
      ],
    }),
    'utf-8',
  );

  t.after(async () => {
    await deleteRun(run.id);
    await rm(root, { recursive: true, force: true });
    await rm(poolFile, { force: true });
  });

  await fn({
    runId: run.id,
    liveRecipeRunId: 'live-run',
    liveGroupId: 'live-run',
    taskDir,
    liveRunDir,
    remoteArtifactRoot,
    remoteLatestValidPointerPath,
    poolFile,
  });
}

test('serveRunArtifact rejects traversal before resolving recipe-run groups', async (t) => {
  await withRemoteRun(t, async ({ runId, liveRecipeRunId }) => {
    const req = {
      url: `/api/run-artifact?runId=${encodeURIComponent(runId)}&recipeRunId=${encodeURIComponent(liveRecipeRunId)}&path=${encodeURIComponent('artifacts/../../secret.txt')}`,
      headers: { host: 'localhost' },
    } as any;
    const res = new MockResponse();
    await serveRunArtifact(req, res as any);
    assert.equal(res.statusCode, 403);
    assert.match(res.body, /Path traversal not allowed/);
  });
});

test('serveRunArtifact serves recipe-run artifacts from a local cache even when the slot is remote', async (t) => {
  await withRemoteRun(t, async ({ runId, liveGroupId, liveRunDir }) => {
    const videoPath = path.join(liveRunDir, 'video.mp4');
    await writeFile(videoPath, 'cached-video', 'utf-8');

    const fakeWs = new FakeNodeWebSocket({
      onStat: () => ({ size: 30 * 1024 * 1024 }),
      onRead: () => ({ content: Buffer.from('remote-video').toString('base64') }),
    });
    registerNode('remote-machine', 123, fakeWs as any);
    t.after(() => {
      unregisterByWs(fakeWs as any);
    });

    const req = {
      url: `/api/run-artifact?runId=${encodeURIComponent(runId)}&recipeRunId=${encodeURIComponent(liveGroupId)}&path=${encodeURIComponent('artifacts/video.mp4')}`,
      headers: { host: 'localhost' },
    } as any;
    const res = new MockResponse();
    await serveRunArtifact(req, res as any);
    await new Promise((resolve) => res.on('finish', resolve));
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['Accept-Ranges'], 'bytes');
    assert.equal(res.body, 'cached-video');
    assert.equal(fakeWs.statCalls, 0);
    assert.equal(fakeWs.readCalls, 0);
  });
});

test('serveRunArtifact supports byte ranges for local recipe-run cache videos', async (t) => {
  await withRemoteRun(t, async ({ runId, liveGroupId, liveRunDir }) => {
    const videoPath = path.join(liveRunDir, 'video.mp4');
    await writeFile(videoPath, 'cached-video', 'utf-8');

    const fakeWs = new FakeNodeWebSocket({
      onStat: () => ({ size: 30 * 1024 * 1024 }),
      onRead: () => ({ content: Buffer.from('remote-video').toString('base64') }),
    });
    registerNode('remote-machine', 123, fakeWs as any);
    t.after(() => {
      unregisterByWs(fakeWs as any);
    });

    const req = {
      url: `/api/run-artifact?runId=${encodeURIComponent(runId)}&recipeRunId=${encodeURIComponent(liveGroupId)}&path=${encodeURIComponent('artifacts/video.mp4')}`,
      headers: { host: 'localhost', range: 'bytes=0-5' },
    } as any;
    const res = new MockResponse();
    await serveRunArtifact(req, res as any);
    await new Promise((resolve) => res.on('finish', resolve));
    assert.equal(res.statusCode, 206);
    assert.equal(res.headers['Content-Range'], 'bytes 0-5/12');
    assert.equal(res.headers['Content-Length'], 6);
    assert.equal(res.headers['Accept-Ranges'], 'bytes');
    assert.equal(res.body, 'cached');
    assert.equal(fakeWs.statCalls, 0);
    assert.equal(fakeWs.readCalls, 0);
  });
});

test('serveRunArtifact rejects unsatisfiable byte ranges for local recipe-run cache videos', async (t) => {
  await withRemoteRun(t, async ({ runId, liveGroupId, liveRunDir }) => {
    const videoPath = path.join(liveRunDir, 'video.mp4');
    await writeFile(videoPath, 'cached-video', 'utf-8');

    const req = {
      url: `/api/run-artifact?runId=${encodeURIComponent(runId)}&recipeRunId=${encodeURIComponent(liveGroupId)}&path=${encodeURIComponent('artifacts/video.mp4')}`,
      headers: { host: 'localhost', range: 'bytes=99-100' },
    } as any;
    const res = new MockResponse();
    await serveRunArtifact(req, res as any);
    assert.equal(res.statusCode, 416);
    assert.equal(res.headers['Content-Range'], 'bytes */12');
    assert.equal(res.headers['Accept-Ranges'], 'bytes');
    assert.match(res.body, /Requested Range Not Satisfiable/);
  });
});

test('serveRunArtifact falls back to the latest recipe package when recipeRunId is omitted', async (t) => {
  await withRemoteRun(t, async ({ runId, liveRunDir }) => {
    const videoPath = path.join(liveRunDir, 'video.mp4');
    await writeFile(videoPath, 'cached-video', 'utf-8');

    const req = {
      url: `/api/run-artifact?runId=${encodeURIComponent(runId)}&path=${encodeURIComponent('artifacts/video.mp4')}&vsize=12`,
      headers: { host: 'localhost', range: 'bytes=7-' },
    } as any;
    const res = new MockResponse();
    await serveRunArtifact(req, res as any);
    await new Promise((resolve) => res.on('finish', resolve));
    assert.equal(res.statusCode, 206);
    assert.equal(res.headers['Content-Range'], 'bytes 7-11/12');
    assert.equal(res.headers['Accept-Ranges'], 'bytes');
    assert.equal(res.body, 'video');
  });
});

test('serveRunArtifact prefers a recipe package when an omitted recipeRunId points at stale root media', async (t) => {
  await withRemoteRun(t, async ({ runId, liveRunDir, taskDir }) => {
    const videoPath = path.join(liveRunDir, 'video.mp4');
    await writeFile(videoPath, 'cached-video', 'utf-8');
    await writeFile(path.join(taskDir, 'artifacts', 'video.mp4'), 'stale', 'utf-8');

    const req = {
      url: `/api/run-artifact?runId=${encodeURIComponent(runId)}&path=${encodeURIComponent('artifacts/video.mp4')}&vsize=12`,
      headers: { host: 'localhost' },
    } as any;
    const res = new MockResponse();
    await serveRunArtifact(req, res as any);
    await new Promise((resolve) => res.on('finish', resolve));
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['Content-Length'], 12);
    assert.equal(res.headers['Accept-Ranges'], 'bytes');
    assert.equal(res.body, 'cached-video');
  });
});

test('serveRunArtifact falls back to the remote slot when a local recipe-run mirror is incomplete', async (t) => {
  await withRemoteRun(t, async ({ runId, liveGroupId, remoteArtifactRoot }) => {
    const fakeWs = new FakeNodeWebSocket({
      onRealpath: ({ path: requestedPath }) => ({ path: requestedPath }),
      onStat: ({ path: requestedPath }) => {
        assert.equal(requestedPath, path.join(remoteArtifactRoot, 'video.mp4'));
        return { size: 'remote-video'.length };
      },
      onRead: ({ path: requestedPath }) => {
        assert.equal(requestedPath, path.join(remoteArtifactRoot, 'video.mp4'));
        return { content: Buffer.from('remote-video').toString('base64') };
      },
    });
    registerNode('remote-machine', 123, fakeWs as any);
    t.after(() => {
      unregisterByWs(fakeWs as any);
    });

    const req = {
      url: `/api/run-artifact?runId=${encodeURIComponent(runId)}&recipeRunId=${encodeURIComponent(liveGroupId)}&path=${encodeURIComponent('artifacts/video.mp4')}`,
      headers: { host: 'localhost' },
    } as any;
    const res = new MockResponse();
    await serveRunArtifact(req, res as any);
    await new Promise((resolve) => res.on('finish', resolve));
    assert.equal(res.statusCode, 200);
    assert.equal(res.body, 'remote-video');
    assert.equal(fakeWs.statCalls, 1);
    assert.equal(fakeWs.readCalls, 1);
  });
});

test('shouldServeRecipeArtifactFromLocalCache only trusts roots under the local task artifacts tree for remote slots', () => {
  const run = { taskFile: '/tmp/orchestrator/tasks/task-1/TASK.md' } as any;
  assert.equal(
    shouldServeRecipeArtifactFromLocalCache(
      run,
      '/tmp/orchestrator/tasks/task-1/artifacts/recipe-runs/pass-run',
      false,
    ),
    true,
  );
  assert.equal(
    shouldServeRecipeArtifactFromLocalCache(
      run,
      '/tmp/repo/.task/task-1/artifacts/recipe-runs/pass-run',
      false,
    ),
    false,
  );
  assert.equal(
    shouldServeRecipeArtifactFromLocalCache(
      run,
      '/tmp/repo/.task/task-1/artifacts/recipe-runs/pass-run',
      true,
    ),
    true,
  );
});

test('updateRun invalidates cached recipe-run groups when live recipe context changes', async (t) => {
  await withRemoteRun(t, async ({ runId, liveGroupId, liveRunDir }) => {
    await writeFile(
      path.join(liveRunDir, 'summary.json'),
      JSON.stringify({ status: 'fail' }),
      'utf-8',
    );
    const initialReq = {
      url: `/api/run-artifact?runId=${encodeURIComponent(runId)}&recipeRunId=${encodeURIComponent(liveGroupId)}&path=${encodeURIComponent('artifacts/summary.json')}`,
      headers: { host: 'localhost' },
    } as any;
    const initialRes = new MockResponse();
    await serveRunArtifact(initialReq, initialRes as any);
    await new Promise((resolve) => initialRes.on('finish', resolve));
    assert.equal(initialRes.statusCode, 200);

    const nextRunDir = path.join(path.dirname(liveRunDir), 'next-run');
    await mkdir(nextRunDir, { recursive: true });
    await writeFile(
      path.join(nextRunDir, 'summary.json'),
      JSON.stringify({ status: 'pass' }),
      'utf-8',
    );
    updateRun(runId, {
      liveRecipeContext: {
        source: 'recipe-run-live',
        recipeRunId: 'next-run',
        artifactRoot: nextRunDir,
        artifactManifest: [{ path: 'artifacts/summary.json', purpose: 'other' }],
        recipeJson: null,
        recipeQualityArtifact: null,
        qualityReport: null,
        workerLearnings: null,
        isStale: false,
        selectionReason: 'user-selected',
      },
    });

    const nextReq = {
      url: `/api/run-artifact?runId=${encodeURIComponent(runId)}&recipeRunId=${encodeURIComponent('live-run:next-run')}&path=${encodeURIComponent('artifacts/summary.json')}`,
      headers: { host: 'localhost' },
    } as any;
    const nextRes = new MockResponse();
    await serveRunArtifact(nextReq, nextRes as any);
    await new Promise((resolve) => nextRes.on('finish', resolve));
    assert.equal(nextRes.statusCode, 200);
    assert.match(nextRes.body, /pass/);
  });
});

test('serveRunArtifact rejects symlink escapes from local recipe-run caches', async (t) => {
  await withRemoteRun(t, async ({ runId, liveGroupId, liveRunDir, taskDir }) => {
    const outsidePath = path.join(taskDir, 'secret.txt');
    await writeFile(outsidePath, 'outside', 'utf-8');
    await symlink(outsidePath, path.join(liveRunDir, 'escape.txt'));

    const req = {
      url: `/api/run-artifact?runId=${encodeURIComponent(runId)}&recipeRunId=${encodeURIComponent(liveGroupId)}&path=${encodeURIComponent('artifacts/escape.txt')}`,
      headers: { host: 'localhost' },
    } as any;
    const res = new MockResponse();
    await serveRunArtifact(req, res as any);
    assert.equal(res.statusCode, 403);
    assert.match(res.body, /Path traversal not allowed/);
  });
});

test('serveRunArtifact rejects symlinked recipe-run roots before serving local caches', async (t) => {
  await withRemoteRun(t, async ({ runId, liveGroupId, liveRunDir, taskDir }) => {
    const outsideDir = path.join(taskDir, 'outside-run');
    await mkdir(outsideDir, { recursive: true });
    await writeFile(
      path.join(outsideDir, 'summary.json'),
      JSON.stringify({ status: 'pass' }),
      'utf-8',
    );
    await writeFile(path.join(outsideDir, 'video.mp4'), 'outside-video', 'utf-8');
    await rm(liveRunDir, { recursive: true, force: true });
    await symlink(outsideDir, liveRunDir);

    const req = {
      url: `/api/run-artifact?runId=${encodeURIComponent(runId)}&recipeRunId=${encodeURIComponent(liveGroupId)}&path=${encodeURIComponent('artifacts/video.mp4')}`,
      headers: { host: 'localhost' },
    } as any;
    const res = new MockResponse();
    await serveRunArtifact(req, res as any);
    assert.equal(res.statusCode, 403);
    assert.match(res.body, /Path traversal not allowed/);
  });
});

test('fsList classifies local symlinked directories as directories', async (t) => {
  await withLocalSlot(t, async ({ slotId, repoDir }) => {
    const linkedDir = path.join(repoDir, 'temp', 'recipe', 'runtime', '.observability');
    await mkdir(linkedDir, { recursive: true });
    await writeFile(path.join(linkedDir, 'statusline.json'), '{}', 'utf-8');
    await symlink(linkedDir, path.join(repoDir, '.observability'));

    const result = await fsList({ slotId, path: '.', includeIgnored: true });

    assert.deepEqual(
      result.entries.find((entry) => entry.name === '.observability'),
      { name: '.observability', type: 'directory', path: '.observability' },
    );
  });
});

test('fsRead rejects local symlink escapes from slot repos', async (t) => {
  await withLocalSlot(t, async ({ slotId, repoDir }) => {
    const outsideDir = await mkdtemp(path.join(tmpdir(), 'farmslot-outside-'));
    t.after(() => rm(outsideDir, { recursive: true, force: true }));
    await writeFile(path.join(outsideDir, 'secret.txt'), 'outside', 'utf-8');
    await symlink(path.join(outsideDir, 'secret.txt'), path.join(repoDir, 'escape.txt'));

    await assert.rejects(
      () => fsRead({ slotId, path: 'escape.txt' }),
      /Path traversal not allowed/,
    );
  });
});

test('fsWrite rejects local symlink escapes from slot repos', async (t) => {
  await withLocalSlot(t, async ({ slotId, repoDir }) => {
    const outsideDir = await mkdtemp(path.join(tmpdir(), 'farmslot-outside-'));
    t.after(() => rm(outsideDir, { recursive: true, force: true }));
    const outsideFile = path.join(outsideDir, 'secret.txt');
    await writeFile(outsideFile, 'outside', 'utf-8');
    await symlink(outsideFile, path.join(repoDir, 'escape.txt'));

    await assert.rejects(
      () => fsWrite({ slotId, path: 'escape.txt', content: 'changed' }),
      /Path traversal not allowed/,
    );
  });
});

test('fsDelete rejects local symlink-directory escapes from slot repos', async (t) => {
  await withLocalSlot(t, async ({ slotId, repoDir }) => {
    const outsideDir = await mkdtemp(path.join(tmpdir(), 'farmslot-outside-'));
    t.after(() => rm(outsideDir, { recursive: true, force: true }));
    await writeFile(path.join(outsideDir, 'secret.txt'), 'outside', 'utf-8');
    await symlink(outsideDir, path.join(repoDir, 'escape-dir'));

    await assert.rejects(
      () => fsDelete({ slotId, path: 'escape-dir/secret.txt' }),
      /Path traversal not allowed/,
    );
  });
});

test('serveFile rejects local symlink escapes from slot repos', async (t) => {
  await withLocalSlot(t, async ({ slotId, repoDir }) => {
    const outsideDir = await mkdtemp(path.join(tmpdir(), 'farmslot-outside-'));
    t.after(() => rm(outsideDir, { recursive: true, force: true }));
    await writeFile(path.join(outsideDir, 'secret.txt'), 'outside', 'utf-8');
    await symlink(path.join(outsideDir, 'secret.txt'), path.join(repoDir, 'escape.txt'));

    const req = {
      url: `/api/file?slotId=${encodeURIComponent(slotId)}&path=${encodeURIComponent('escape.txt')}`,
      headers: { host: 'localhost' },
    } as any;
    const res = new MockResponse();
    await serveFile(req, res as any);

    assert.equal(res.statusCode, 403);
    assert.match(res.body, /Path traversal not allowed/);
  });
});
