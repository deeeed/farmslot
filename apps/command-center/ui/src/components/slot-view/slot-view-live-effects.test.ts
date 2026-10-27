import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
let reply: () => Promise<unknown> = async () => ({ ok: true });
const gateway = {
  connectionState: 'disconnected',
  connectionEpoch: 1,
  authenticatedConnection: { capabilities: { conditionalFileWrites: true } },
  request: (method: string, params: Record<string, unknown>) => {
    requests.push({ method, params });
    return reply();
  },
};
mock.module('../../gateway-client.js', { namedExports: { gateway } });
let hashRead: () => Promise<unknown> = async () => ({ status: 'ready', data: { hash: 'h1' } });
mock.module('../../resource-cache.js', {
  namedExports: {
    getEditorDraftScopeId: () => undefined,
    getResourceCache: () => ({ retry: () => hashRead() }),
    getResourceNativeOwnerId: () => undefined,
    getResourceWorkspaceKey: () => undefined,
    subscribeResourceCache: () => () => undefined,
  },
});
const heldReads: Array<{ path: string; signal?: AbortSignal }> = [];
mock.module('../../held-run-diff.js', {
  namedExports: {
    heldRunFileDiff: async (
      _cache: unknown,
      _run: unknown,
      path: string,
      { signal }: { signal?: AbortSignal } = {},
    ) => {
      heldReads.push({ path, signal });
      return path === 'src/held.ts' ? 'diff --git a/src/held.ts b/src/held.ts' : undefined;
    },
    heldRunFileContent: async (
      _cache: unknown,
      _run: unknown,
      path: string,
      { signal }: { signal?: AbortSignal } = {},
    ) => {
      heldReads.push({ path, signal });
      return path === 'notes/untracked.md' ? 'held new side\n' : undefined;
    },
  },
});

const { handleSlotViewChangeSelect, handleSlotViewTreeAction, loadSlotViewDiffContent } =
  await import('./slot-view-live-effects.js');
type View = Parameters<typeof loadSlotViewDiffContent>[0];

function makeView(): View {
  return {
    slotId: 'slot-a',
    _isLive: true,
    _recoveryEpoch: 1,
    _linkedRun: { id: 'run-1', slotId: 'slot-a' },
    _liveDiffContents: new Map(),
    _liveFileContents: new Map(),
    _liveFileHashes: new Map(),
    _openFiles: [],
    _activeFile: '',
    // Offline with nothing stored, the per-file read never answers.
    _workspaceReads: { version: 0, read: () => new Promise(() => {}), owns: () => false },
  } as unknown as View;
}

// Without the fallback the read never answers, so the test fails by its timeout, not a hang.
test(
  "offline, a per-file diff with nothing stored shows the held run diff's section",
  { timeout: 5000 },
  async () => {
    heldReads.length = 0;
    gateway.connectionState = 'disconnected';
    const view = makeView();
    assert.equal(await loadSlotViewDiffContent(view, 'src/held.ts'), true);
    assert.equal(
      view._liveDiffContents.get('src/held.ts'),
      'diff --git a/src/held.ts b/src/held.ts',
    );
    assert.equal(heldReads[0].signal?.aborted, true, 'the held read stops once a section is shown');

    // Online, the per-file read alone answers; the held diff is never observed.
    gateway.connectionState = 'connected';
    void loadSlotViewDiffContent(makeView(), 'src/held.ts');
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(heldReads.length, 1);
  },
);

// Without the fallback the fs.read never answers, so the test fails by its timeout, not a hang.
test(
  'offline, selecting an untracked change opens it read-only from the held run diff',
  { timeout: 5000 },
  async () => {
    heldReads.length = 0;
    gateway.connectionState = 'disconnected';
    const view = makeView();
    await handleSlotViewChangeSelect(view, 'notes/untracked.md', '?');
    assert.equal(view._liveFileContents.get('notes/untracked.md'), 'held new side\n');
    assert.equal(view._liveFileHashes.get('notes/untracked.md'), undefined, 'no hash: read-only');
    assert.deepEqual(view._openFiles, [
      { path: 'notes/untracked.md', type: 'file', pinned: false },
    ]);
    assert.equal(view._activeFile, 'notes/untracked.md');
    assert.equal(heldReads[0].signal?.aborted, true, 'the held read stops once the file opens');

    // Online, fs.read alone answers; the held diff is never observed.
    gateway.connectionState = 'connected';
    void handleSlotViewChangeSelect(makeView(), 'notes/untracked.md', 'A');
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(heldReads.length, 1);
  },
);

test("a file deleted from slot A after the view moved to slot B leaves B's tabs and notices alone", async () => {
  gateway.connectionState = 'connected';
  Object.assign(globalThis, { confirm: () => true });
  const slotFor = (slot: string, currentRunId: string) => ({
    slot,
    machine: 'mac',
    health: { ssh: 'LOCAL' },
    currentRunId,
  });
  for (const outcome of ['deleted', 'refused'] as const) {
    requests.length = 0;
    let reloads = 0;
    const view = Object.assign(makeView(), {
      _slot: slotFor('slot-a', 'run-1'),
      _isRecoveryBlocked: false,
      _conditionalWritesRefused: new Set(),
      _nodesQuery: { state: { data: { nodes: [] } } },
      _openFiles: [{ path: 'src/a.ts', type: 'file', pinned: true }],
      _activeFile: 'src/a.ts',
      _editNotice: '',
      _reloadTree: () => reloads++,
    });
    Object.assign(view._workspaceReads, { ready: true });
    let readHash!: () => void;
    hashRead = () =>
      new Promise((resolve) => {
        readHash = () => resolve({ status: 'ready', data: { hash: 'h1' } });
      });
    reply = async () => {
      if (outcome === 'deleted') return { ok: true };
      throw Object.assign(new Error('changed'), {
        code: 'FS_CONFLICT',
        details: { reason: 'hash' },
      });
    };
    const deleting = handleSlotViewTreeAction(view, {
      action: 'delete',
      path: 'src/a.ts',
      type: 'file',
    });
    // While A's file hash is read, the view moves to slot B, which has the same path open.
    Object.assign(view, {
      slotId: 'slot-b',
      _slot: slotFor('slot-b', 'run-b'),
      _linkedRun: { id: 'run-b', slotId: 'slot-b' },
    });
    readHash();
    await deleting;
    assert.deepEqual(
      requests.map(({ params }) => [params.slotId, params.runId]),
      [['slot-a', 'run-1']],
      `${outcome}: the delete goes to the slot and run it was asked for`,
    );
    assert.deepEqual(view._openFiles, [{ path: 'src/a.ts', type: 'file', pinned: true }], outcome);
    assert.equal(view._activeFile, 'src/a.ts', outcome);
    assert.equal(view._editNotice, '', outcome);
    assert.equal(reloads, 0, outcome);
  }
});
