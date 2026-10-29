import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

// The diff widget imports Vite CSS and diff2html's ESM build, which Node 22 cannot load; drawing
// the diff does not decide which diff the modal holds.
mock.module('../diff-viewer/diff-review.js', { namedExports: {} });

Object.defineProperty(globalThis, 'location', {
  configurable: true,
  value: new URL('http://localhost:7777/'),
});

const { DiffViewerModal } = await import('./diff-viewer-modal.js');

const diffA = 'diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-a\n+A\n';
const diffB = 'diff --git a/b.ts b/b.ts\n--- a/b.ts\n+++ b/b.ts\n@@ -1 +1 @@\n-b\n+B\n';

const flush = async () => {
  for (let i = 0; i < 20; i++) await new Promise<void>((resolve) => setImmediate(resolve));
};

/** Applies host property changes and runs the modal's update hook, as a render would. */
function show(
  modal: InstanceType<typeof DiffViewerModal>,
  fields: Partial<Record<'open' | 'artifactUrl' | 'diffText', unknown>>,
) {
  const changed = new Map<string, unknown>();
  for (const [name, value] of Object.entries(fields)) {
    changed.set(name, Reflect.get(modal, name));
    Reflect.set(modal, name, value);
  }
  modal.updated(changed);
}

const loaded = (modal: InstanceType<typeof DiffViewerModal>) => ({
  text: Reflect.get(modal, '_loadedText'),
  error: Reflect.get(modal, '_error'),
  loading: Reflect.get(modal, '_loading'),
});

for (const late of ['response', 'failure'] as const)
  test(`a URL ${late} for a closed modal never replaces the diff opened after it`, async (t) => {
    let settle!: () => void;
    t.mock.method(
      globalThis,
      'fetch',
      () =>
        new Promise<Response>((resolve, reject) => {
          settle = () =>
            late === 'response' ? resolve(new Response(diffA)) : reject(new Error('reset'));
        }),
    );
    const modal = new DiffViewerModal();
    show(modal, { open: true, artifactUrl: '/api/run-artifact?runId=run&path=a.diff' });
    assert.equal(loaded(modal).loading, true);
    show(modal, { open: false });
    show(modal, { open: true, artifactUrl: '', diffText: diffB });
    settle();
    await flush();
    assert.deepEqual(loaded(modal), { text: diffB, error: '', loading: false });
  });

test('a URL read for a replaced source never applies, and the current one does', async (t) => {
  const pending = new Map<string, (response: Response) => void>();
  t.mock.method(globalThis, 'fetch', (input: RequestInfo | URL) => {
    const path = new URL(String(input), 'http://localhost:7777').searchParams.get('path')!;
    return new Promise<Response>((resolve) => pending.set(path, resolve));
  });
  const modal = new DiffViewerModal();
  show(modal, { open: true, artifactUrl: '/api/run-artifact?runId=run&path=a.diff' });
  show(modal, { artifactUrl: '/api/run-artifact?runId=run&path=b.diff' });
  pending.get('b.diff')!(new Response(diffB));
  await flush();
  pending.get('a.diff')!(new Response(diffA));
  await flush();
  assert.deepEqual(loaded(modal), { text: diffB, error: '', loading: false });
});
