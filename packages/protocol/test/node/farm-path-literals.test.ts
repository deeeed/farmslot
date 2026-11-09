import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';

interface AllowedLiteral {
  file: string;
  literal: string;
  reason: string;
  count: number;
}
const root = fileURLToPath(new URL('../../../../', import.meta.url));
const watched = /farmslot-node|\.farmslot|\/pool|\.runs|run-archive/;
function sources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (/^(?:node_modules|dist|__tests__|fixtures|test)$/.test(entry.name)) return [];
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) return sources(file);
    return /\.(?:ts|tsx|js|mjs|cjs|py)$/.test(file) &&
      !/(?:\.test\.[^.]+$|\.live(?:-support)?\.[^.]+$|[.-](?:test-support|test-fixtures|test-fixture|fixture|fixtures)\.[^.]+$)/.test(
        entry.name,
      )
      ? [file]
      : [];
  });
}
function literals(): AllowedLiteral[] {
  const found: AllowedLiteral[] = [];
  for (const base of ['services', 'packages']) {
    for (const entry of readdirSync(path.join(root, base), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const directory = path.join(root, base, entry.name, 'src');
      let files: string[];
      try {
        files = sources(directory);
      } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') continue;
        throw error;
      }
      for (const absolute of files) {
        const file = path.relative(root, absolute);
        if (/^packages\/protocol\/src\/node\/farm-paths[^/]*\.ts$/.test(file)) continue;
        const source = ts.createSourceFile(
          file,
          readFileSync(absolute, 'utf8'),
          ts.ScriptTarget.Latest,
          true,
        );
        const visit = (node: ts.Node) => {
          if (
            (ts.isStringLiteralLike(node) ||
              ts.isTemplateHead(node) ||
              ts.isTemplateMiddle(node) ||
              ts.isTemplateTail(node)) &&
            watched.test(node.text)
          ) {
            found.push({ file, literal: node.text, reason: '', count: 1 });
          }
          ts.forEachChild(node, visit);
        };
        visit(source);
      }
    }
  }
  return found;
}

test('farm path literals outside the resolver have an explicit reviewed reason', () => {
  const allowed: AllowedLiteral[] = JSON.parse(
    readFileSync(new URL('./farm-path-literals.json', import.meta.url), 'utf8'),
  );
  assert.ok(allowed.every((entry) => entry.reason.trim().length > 0));
  const key = (entry: AllowedLiteral) => JSON.stringify([entry.file, entry.literal]);
  const allowlist = new Map(allowed.map((entry) => [key(entry), entry.count]));
  const seen = new Map<string, number>();
  const unexpected = literals().filter((entry) => {
    const identity = key(entry);
    const count = (seen.get(identity) ?? 0) + 1;
    seen.set(identity, count);
    return count > (allowlist.get(identity) ?? 0);
  });
  assert.deepEqual(unexpected, [], 'New farm roots belong in protocol/node/farm-paths*.ts');
});
