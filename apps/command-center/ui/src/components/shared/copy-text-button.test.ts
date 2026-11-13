import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

import { litBinding, litText } from '../../testing/lit-text.js';

const copies: string[] = [];
let refuse = false;
mock.module('../../utils/clipboard.js', {
  namedExports: {
    copyTextToClipboard: async (text: string) => {
      if (refuse) throw new Error('Clipboard copy failed: denied');
      copies.push(text);
    },
  },
});

const { CopyTextButton } = await import('./copy-text-button.js');

const label = (button: InstanceType<typeof CopyTextButton>) =>
  /<button[^>]*>([^<]*)<\/button>/.exec(litText(button.render()))?.[1].trim();

test('clicking Copy puts the exact message text on the clipboard, then shows Copied', async () => {
  copies.length = 0;
  const button = new CopyTextButton();
  const text = 'See https://example.com/a.\n\n  - indented <b>raw</b>\n';
  button.text = text;
  assert.equal(label(button), 'Copy');
  const click = litBinding(button.render(), '@click=');
  assert.equal(typeof click, 'function');
  (click as () => void)();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(copies, [text]);
  assert.equal(label(button), 'Copied');
  // A streamed reply whose text grew starts over.
  button.text = `${text} more`;
  assert.equal(label(button), 'Copy');
});

test('a refused copy shows Copy failed with the reason, never Copied', async () => {
  refuse = true;
  const button = new CopyTextButton();
  button.text = 'text';
  await button.copy();
  refuse = false;
  assert.equal(label(button), 'Copy failed');
  assert.equal(litBinding(button.render(), 'title='), 'Clipboard copy failed: denied');
});
