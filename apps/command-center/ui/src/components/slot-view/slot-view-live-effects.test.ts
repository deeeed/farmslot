import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

const gateway = { connectionState: 'disconnected', connectionEpoch: 1 };
mock.module('../../gateway-client.js', { namedExports: { gateway } });
mock.module('../../resource-cache.js', {
  namedExports: {
    getEditorDraftScopeId: () => undefined,
    getResourceCache: () => ({}),
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

const { handleSlotViewChangeSelect, loadSlotViewDiffContent } =
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
