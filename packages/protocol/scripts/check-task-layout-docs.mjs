#!/usr/bin/env node
// Check task-relative paths in Markdown and HTML against the protocol contract.
import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { TASK_DIRECTORY_LAYOUT } from '../dist/task-layout.js';

const entries = Object.values(TASK_DIRECTORY_LAYOUT);
const filenames = new Set(
  entries
    .filter(({ kind }) => kind === 'file')
    .map(({ relativePath }) => path.posix.basename(relativePath)),
);
const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const patterns = entries.map(
  ({ relativePath }) =>
    new RegExp(
      `^${relativePath
        .split(/(\{[^}]+\})/)
        .map((part) => (part.startsWith('{') ? (part === '{path}' ? '.+' : '[^/]+') : escape(part)))
        .join('')}$`,
    ),
);
const root = String.raw`(?:<task(?:-dir)?>|<(?:RECIPE_)?TASK_DIR>|\{\{TASK_DIR\}\}|\$\{(?:RECIPE_)?TASK_DIR\}|\$(?:RECIPE_)?TASK_DIR|(?:RECIPE_)?TASK_DIR)`;
const containsTaskRoot = new RegExp(`${root}/`);
const rooted = new RegExp(`${root}/([^\\s\x60";)]*)`, 'g');
const taskRelative = /^(?:artifacts|inputs|assets|subtasks|task-actions)(?:\/|$)/;
const decode = (text) =>
  text.replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&');

/** Returns only explicit task paths, not product paths or shell command arguments. */
export function taskPaths(document) {
  const found = [];
  const lines = decode(document).split('\n');
  let tree = null;
  for (const [index, originalLine] of lines.entries()) {
    const line = originalLine.replace(/<\/(?:code|pre)>/g, '');
    const add = (value) => {
      const expansion = /\{([^{}]*,[^{}]*)\}/.exec(value);
      if (expansion) {
        for (const name of expansion[1].split(',')) add(value.replace(expansion[0], name));
        return;
      }
      const relativePath = value.replace(/[.,:]$/, '').replace(/\/+$/, '');
      // A sibling scratch directory is explicitly outside the task contract.
      if (!relativePath || relativePath.startsWith('../')) return;
      found.push({ line: index + 1, relativePath });
    };
    for (const match of line.matchAll(rooted)) {
      add(match[1]);
    }
    for (const match of originalLine.matchAll(/`([^`\n]+)`|<code>([^<\n]+)<\/code>/g)) {
      const span = match[1] ?? match[2];
      const tokens = /^\s*(?:\{|\[\s*[\{"])/.test(span)
        ? [...span.matchAll(/"(?:\\.|[^"\\])*"/g)].map((value) => JSON.parse(value[0]))
        : span.split(/\s+/);
      for (const raw of tokens) {
        const value = raw.replace(/^[(["']+/, '').replace(/[\],;:"')]+$/, '');
        if (containsTaskRoot.test(value)) continue;
        const namedFile =
          /^[A-Za-z0-9_.-]+\//.test(value) && filenames.has(path.posix.basename(value));
        if (taskRelative.test(value) || namedFile) add(value.replace(/^\.\//, ''));
      }
    }
    if (new RegExp(`^\\s*${root}/$`).test(line.replace(/^.*<pre><code>/, ''))) {
      tree = [];
      continue;
    }
    if (tree === null) continue;
    if (/```|<\/code>/.test(originalLine)) {
      // Keep the final tree row before the HTML closing tag.
      const row = line.replace(/<\/code>.*$/, '');
      if (!/^\s+\S/.test(row)) {
        tree = null;
        continue;
      }
    }
    const row = /^(\s+)([^\s,]+(?:,\s*[^\s,]+)*)/.exec(line);
    if (!row) {
      tree = null;
      continue;
    }
    const indent = row[1].length;
    // Wrapped descriptions are not deeper task entries.
    if (indent > (tree.at(-1)?.indent ?? 0) + 2) continue;
    while (tree.length && tree.at(-1).indent >= indent) tree.pop();
    for (const name of row[2].split(/,\s*/)) {
      const relativePath = [...tree.map((entry) => entry.name), name].join('/');
      add(relativePath);
      if (name.endsWith('/')) tree.push({ indent, name: name.slice(0, -1) });
    }
    if (originalLine.includes('</code>')) tree = null;
  }
  return found;
}

export function taskLayoutDocIssues(document) {
  return taskPaths(document).filter(
    ({ relativePath }) => !patterns.some((pattern) => pattern.test(relativePath)),
  );
}

async function documents(file) {
  if (!(await stat(file)).isDirectory()) return [file];
  const files = [];
  for (const entry of await readdir(file, { withFileTypes: true })) {
    const child = path.join(file, entry.name);
    if (entry.isDirectory()) files.push(...(await documents(child)));
    else if (/\.(md|html)$/.test(entry.name)) files.push(child);
  }
  return files;
}

async function main(files) {
  if (!files.length)
    throw new Error('Pass skills Markdown paths/directories and/or site/task-dir.html.');
  let issues = 0;
  let checked = 0;
  for (const input of files) {
    for (const file of await documents(input)) {
      checked++;
      for (const issue of taskLayoutDocIssues(await readFile(file, 'utf8'))) {
        console.error(`${file}:${issue.line}: undefined task path ${issue.relativePath}`);
        issues++;
      }
    }
  }
  if (!checked) throw new Error('No Markdown or HTML documents found.');
  console.log(`${checked} documents checked; ${issues} undefined task paths.`);
  process.exitCode = issues ? 1 : 0;
}

if (
  process.argv[1] &&
  process.argv[1] !== '-' &&
  (await realpath(process.argv[1])) === fileURLToPath(import.meta.url)
) {
  await main(process.argv.slice(2));
}
