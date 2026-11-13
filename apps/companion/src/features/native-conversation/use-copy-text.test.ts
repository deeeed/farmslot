import assert from 'node:assert/strict';
import test from 'node:test';
import { URL } from 'node:url';

import { mountHook } from '../../hooks/hook-harness.fixtures';

interface CopyText {
  copied?: boolean;
  copy: () => Promise<void>;
}

function isCopyText(value: unknown): value is CopyText {
  return typeof value === 'object' && value !== null && 'copy' in value && 'copied' in value;
}

function copyHook(setStringAsync: (text: string) => Promise<boolean>) {
  const hook = mountHook<[string, string]>(
    new URL('./use-copy-text.ts', import.meta.url),
    'useCopyText',
    {
      'expo-clipboard': { setStringAsync },
    },
  );
  return (text: string, id = 'message-1') => {
    const result = hook.render(id, text);
    assert.ok(isCopyText(result));
    return result;
  };
}

test('Copy puts the exact message text on the clipboard and then reports Copied', async () => {
  const copies: string[] = [];
  const render = copyHook(async (text) => {
    copies.push(text);
    return true;
  });
  const text = 'Line one https://example.com/a.\n  indented line\n';
  assert.equal(render(text).copied, undefined);
  await render(text).copy();
  assert.deepEqual(copies, [text]);
  assert.equal(render(text).copied, true);
  // A recycled row, or a streamed message, with other text starts over.
  assert.equal(render('other').copied, undefined);
});

test('a recycled row showing another message with the same text starts over at Copy', async () => {
  const render = copyHook(async () => true);
  await render('Done.', 'message-1').copy();
  assert.equal(render('Done.', 'message-1').copied, true);
  assert.equal(render('Done.', 'message-2').copied, undefined);
});

test('a refused copy reports Copy failed, never Copied', async () => {
  const refused = copyHook(async () => {
    throw new Error('no clipboard');
  });
  await refused('text').copy();
  assert.equal(refused('text').copied, false);
  const declined = copyHook(async () => false);
  await declined('text').copy();
  assert.equal(declined('text').copied, false);
});
