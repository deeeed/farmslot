import assert from 'node:assert/strict';
import test from 'node:test';

import { nativeDiffDocument, nativeDiffTokens } from './native-diff-rows';

const diff = `diff --git a/src/demo.ts b/src/demo.ts
--- a/src/demo.ts
+++ b/src/demo.ts
@@ -1,3 +1,3 @@
 const a = 1;
-const b = 2;
+const b = 3;
 export { a, b };
`;

test('a unified diff becomes a file header, its hunk and numbered lines', () => {
  const document = nativeDiffDocument(diff);
  assert.deepEqual(
    document.rows.map((row) => [row.kind, row.change, row.oldLineNumber, row.newLineNumber]),
    [
      ['file', undefined, undefined, undefined],
      ['hunk', undefined, undefined, undefined],
      ['line', 'context', 1, 1],
      ['line', 'delete', 2, null],
      ['line', 'add', null, 2],
      ['line', 'context', 3, 3],
    ],
  );
  assert.equal(document.rows[0]?.filePath, 'src/demo.ts');
  assert.equal(document.rows[0]?.changeType, 'modified');
  assert.equal(document.additions, 1);
  assert.equal(document.deletions, 1);
});

test('a new file is marked new', () => {
  const document = nativeDiffDocument(
    'diff --git a/notes.md b/notes.md\n--- /dev/null\n+++ b/notes.md\n@@ -0,0 +1 @@\n+# Plan\n',
  );
  assert.equal(document.rows[0]?.changeType, 'new');
  assert.deepEqual(document.rows.at(-1)?.newLineNumber, 1);
});

test('each side highlights as one text and every line row gets its tokens', () => {
  const document = nativeDiffDocument(diff);
  const sides: string[] = [];
  const tokens = nativeDiffTokens(document, (code) => {
    sides.push(code);
    return code.split('\n').map((line) => [{ content: line, color: '#fff', fontStyle: null }]);
  });
  assert.deepEqual(sides, [
    'const a = 1;\nconst b = 2;\nexport { a, b };',
    'const a = 1;\nconst b = 3;\nexport { a, b };',
  ]);
  const lines = document.rows.filter((row) => row.kind === 'line');
  assert.deepEqual(
    lines.map((row) => tokens[row.id]?.[0]?.content),
    ['const a = 1;', 'const b = 2;', 'const b = 3;', 'export { a, b };'],
  );
});

test('a language without a lexer leaves the rows plain', () => {
  assert.deepEqual(
    nativeDiffTokens(nativeDiffDocument(diff), () => null),
    {},
  );
});

test('a path inside the session folder shows relative to it', () => {
  // As nativeToolDiffText writes an absolute tool path: `diff --git a//repo/src/demo.ts ...`.
  const absolute = diff.replaceAll('src/demo.ts', '/repo/src/demo.ts');
  assert.equal(nativeDiffDocument(absolute, '/repo').rows[0]?.filePath, 'src/demo.ts');
  assert.equal(nativeDiffDocument(absolute).rows[0]?.filePath, '/repo/src/demo.ts');
});
