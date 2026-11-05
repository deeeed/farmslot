import type { GitShowBatchParams } from '@farmslot/protocol';

export interface GitShowPageInput {
  ref: string;
  paths: string[];
  have: GitShowBatchParams['have'];
  maxBytes: number;
  maxFileBytes: number;
}

// Selection and byte reads share one host call, including frozen-repository checks.
export const HOST_GIT_SHOW = String.raw`
const cp = require('node:child_process');
const p = JSON.parse(process.argv[1]);
const prefix = p.cache ? ['--no-pager', '--git-dir', p.cache] : [];
function git(args, input, maxBuffer) {
  const r = cp.spawnSync('git', [...prefix, ...args], { input, maxBuffer });
  if (r.error) throw r.error;
  if (r.status !== 0) throw Error(r.stderr.toString() || 'Review Git read failed');
  return r.stdout;
}
if (p.cache) {
  const fs = require('node:fs');
  if (JSON.stringify(JSON.parse(fs.readFileSync(p.cache + '.json', 'utf8'))) !== JSON.stringify(p.identity))
    throw Error('Review repository ownership changed');
  if (p.ref !== p.head && p.ref !== git(['merge-base', p.base, p.head], undefined, 1024).toString().trim())
    throw Error('Review viewer must use the frozen review commits');
}
const batch = p.paths;
const names = [p.ref + '^{commit}', ...batch.map(path => p.ref + ':' + path)];
const input = names.join('\n') + '\n';
const checked = git(['cat-file', '--batch-check'], input, Buffer.byteLength(input) + 128 * names.length).toString().split('\n');
if (!/^[0-9a-f]+ commit \d+$/.test(checked[0])) throw Error('Unknown commit ' + p.ref);
const have = new Set(p.have || []);
const entries = [];
let pageBytes = 0;
for (const [index, path] of batch.entries()) {
  const object = /^([0-9a-f]+) (\S+) (\d+)$/.exec(checked[index + 1] || '');
  if (!object) { entries.push({ path, status: 'missing' }); continue; }
  const [, id, type, sizeText] = object;
  const size = Number(sizeText);
  if (type !== 'blob') entries.push({ path, status: 'not-blob', id });
  else if (have.has(id)) entries.push({ path, status: 'held', id, size });
  else if (size > p.maxFileBytes) entries.push({ path, status: 'too-large', id, size });
  else if (entries.length && pageBytes + size > p.maxBytes) break;
  else { pageBytes += size; entries.push({ path, status: 'ok', id, size }); }
}
const wanted = entries.filter(entry => entry.status === 'ok');
if (wanted.length) {
  const stream = git(['cat-file', '--batch'], wanted.map(entry => entry.id).join('\n') + '\n', pageBytes + 128 * wanted.length);
  let offset = 0;
  for (const entry of wanted) {
    const headerEnd = stream.indexOf(0x0a, offset);
    const end = headerEnd + 1 + entry.size;
    if (headerEnd < 0 || stream.toString('latin1', offset, headerEnd) !== entry.id + ' blob ' + entry.size || stream[end] !== 0x0a)
      throw Error('git.show could not read ' + entry.path);
    entry.content = stream.subarray(headerEnd + 1, end).toString('base64');
    offset = end + 1;
  }
}
process.stdout.write(JSON.stringify({ entries, cursor: entries[entries.length - 1].path, hasMore: entries.length < p.paths.length }));
`;
