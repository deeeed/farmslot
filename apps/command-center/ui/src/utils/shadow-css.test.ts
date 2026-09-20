import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';

import { adoptDocumentCss } from './shadow-css.js';

interface Sheet {
  href: string | null;
  ownerNode: { tagName: string; textContent: string };
  cssRules?: { cssText: string }[];
}

function fixture(t: TestContext, sheets: Sheet[]) {
  class Root {
    children: { tagName: string; href?: string; textContent?: string }[] = [];
    appendChild(element: Root['children'][number]) {
      this.children.push(element);
    }
  }
  for (const [key, value] of Object.entries({
    ShadowRoot: Root,
    document: { styleSheets: sheets, createElement: (tagName: string) => ({ tagName }) },
  })) {
    const before = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, value });
    t.after(() => {
      if (before) Object.defineProperty(globalThis, key, before);
      else Reflect.deleteProperty(globalThis, key);
    });
  }
  const root = new Root();
  const el = { getRootNode: () => root } as unknown as HTMLElement;
  return { root, el };
}
const diff = (href: string, text: string) => href.includes('diff2html') || text.includes('.d2h-');
const monaco = (href: string, text: string) =>
  href.includes('monaco') || text.includes('.monaco-editor');

const linked = (cssText: string): Sheet => ({
  href: 'http://localhost/cc/assets/start-AbCd.css',
  ownerNode: { tagName: 'LINK', textContent: '' },
  cssRules: [{ cssText }],
});

test('hashed production stylesheet reaches the gate shadow root and is deduplicated', (t) => {
  const { root, el } = fixture(t, [linked('.d2h-file-side-diff { float:left; width:50%; }')]);
  adoptDocumentCss(el, diff, 'diff2html');
  adoptDocumentCss(el, diff, 'diff2html');
  assert.equal(root.children.length, 1);
  assert.equal(root.children[0].href, 'http://localhost/cc/assets/start-AbCd.css');
});

test('inline development styles still copy their CSS text', (t) => {
  const css = '.d2h-code-line { color: white; }';
  const { root, el } = fixture(t, [
    { href: null, ownerNode: { tagName: 'STYLE', textContent: css } },
  ]);
  adoptDocumentCss(el, diff, 'diff2html');
  assert.equal(root.children[0].textContent, css);
});

test('a missing lazy Monaco stylesheet can be adopted by a later editor in the same host', (t) => {
  const sheets: Sheet[] = [];
  const { root, el } = fixture(t, sheets);
  adoptDocumentCss(el, monaco, 'monaco');
  assert.equal(root.children.length, 0);
  sheets.push(linked('.monaco-editor { position:relative; }'));
  adoptDocumentCss(el, monaco, 'monaco');
  assert.equal(root.children.length, 1);
});

test('unreadable cross-origin CSS is skipped but unexpected failures propagate', (t) => {
  const denied = linked('');
  Object.defineProperty(denied, 'cssRules', {
    get() {
      throw new DOMException('Cross origin', 'SecurityError');
    },
  });
  const sheets = [denied, linked('.d2h-wrapper {}')];
  const { root, el } = fixture(t, sheets);
  adoptDocumentCss(el, diff, 'diff2html');
  assert.equal(root.children.length, 1);
  const broken = linked('');
  Object.defineProperty(broken, 'cssRules', {
    get() {
      throw new Error('Unexpected failure');
    },
  });
  sheets.splice(0, sheets.length, broken);
  assert.throws(() => adoptDocumentCss(el, monaco, 'monaco'), /Unexpected failure/);
});
