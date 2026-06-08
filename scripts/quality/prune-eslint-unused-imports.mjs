#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '../..');
const COMPANION = path.join(ROOT, 'apps/companion');

const targets = process.argv.slice(2);
if (targets.length === 0) {
  console.error('usage: prune-eslint-unused-imports.mjs <file>...');
  process.exit(1);
}

function unusedNames(file) {
  const rel = path.relative(COMPANION, path.resolve(file));
  let json;
  try {
    json = execFileSync('npx', ['eslint', rel, '-f', 'json'], {
      cwd: COMPANION,
      encoding: 'utf8',
      maxBuffer: 20 * 1024 * 1024,
    });
  } catch (error) {
    json = error.stdout?.toString() ?? '[]';
  }
  const results = JSON.parse(json || '[]');
  const names = new Set();
  for (const result of results) {
    for (const message of result.messages ?? []) {
      const match = message.message?.match(/^'([^']+)' is defined but never used/);
      if (match) names.add(match[1]);
    }
  }
  return names;
}

function pruneMultilineImports(content, unused) {
  const lines = content.split('\n');
  const out = [];
  let i = 0;
  while (i < lines.length) {
    if (!lines[i].startsWith('import ')) {
      out.push(lines[i]);
      i++;
      continue;
    }
    let block = lines[i];
    i++;
    while (i < lines.length && !block.includes(" from '") && !block.includes(' from "')) {
      block += `\n${lines[i]}`;
      i++;
    }
    const pruned = pruneImportBlock(block, unused);
    if (pruned.trim()) out.push(...pruned.split('\n'));
  }
  return out.join('\n');
}

function pruneImportBlock(block, unused) {
  const fromMatch = block.match(/\sfrom\s+(['"][^'"]+['"])\s*;?\s*$/s);
  if (!fromMatch) return block;

  const from = fromMatch[1];
  const head = block.slice(0, block.indexOf('from')).trim();

  if (head.startsWith('import type ')) {
    const inner = head
      .replace(/^import\s+type\s*\{/, '{')
      .replace(/\{$/, '{')
      .trim();
    return pruneNamed(head.includes('{') ? `import type ${inner}` : block, unused, from, true);
  }

  const defaultMatch = head.match(/^import\s+(\w+)$/);
  if (defaultMatch && unused.has(defaultMatch[1])) return '';

  const nsMatch = head.match(/^import\s+\*\s+as\s+(\w+)$/);
  if (nsMatch && unused.has(nsMatch[1])) return '';

  if (head.includes('{')) {
    const inner = head.slice(head.indexOf('{'));
    return pruneNamed(`import ${inner}`, unused, from, false);
  }

  return block;
}

function pruneNamed(prefix, unused, from, isType) {
  const inner = prefix.match(/\{([\s\S]+)\}/)?.[1] ?? '';
  const parts = inner
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean)
    .filter((part) => {
      const name = part
        .replace(/^type\s+/, '')
        .split(/\s+as\s+/)
        .pop()
        ?.trim();
      return name && !unused.has(name);
    });
  if (parts.length === 0) return '';
  const kw = isType ? 'import type ' : 'import ';
  return `${kw}{ ${parts.join(', ')} } from ${from};`;
}

for (const file of targets) {
  const abs = path.resolve(file);
  let content = readFileSync(abs, 'utf8');
  for (let pass = 0; pass < 8; pass++) {
    const unused = unusedNames(abs);
    if (unused.size === 0) break;
    const next = pruneMultilineImports(content, unused);
    if (next === content) break;
    content = next.replace(/\n{3,}/g, '\n\n');
  }
  writeFileSync(abs, content);
  const remaining = unusedNames(abs).size;
  console.log(`${path.relative(ROOT, abs)}: ${remaining} unused remaining`);
}
