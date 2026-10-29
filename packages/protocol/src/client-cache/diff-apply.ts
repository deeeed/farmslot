/** One line of a hunk. `text` keeps its newline unless git marked "\ No newline at end of file". */
export interface UnifiedDiffLine {
  op: ' ' | '-' | '+';
  text: string;
}

export interface UnifiedDiffHunk {
  oldStart: number;
  oldLines: number;
  lines: UnifiedDiffLine[];
}

/** One file section of a git diff. An undefined path is `/dev/null`. */
export interface UnifiedDiffFile {
  oldPath?: string;
  newPath?: string;
  /** Blob ids from the `index` line, abbreviated unless the diff used `--full-index`. */
  oldId?: string;
  newId?: string;
  oldMode?: string;
  newMode?: string;
  binary: boolean;
  /** A hunk could not be read; the file cannot be rebuilt from this diff. */
  malformed: boolean;
  hunks: UnifiedDiffHunk[];
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const HEADER_FIELDS = [
  'new file mode',
  'deleted file mode',
  'old mode',
  'new mode',
  'rename from',
  'rename to',
  'copy from',
  'copy to',
  'index',
] as const;

/** C-style quoting, which git applies to unusual paths even with core.quotePath=false. */
function readQuoted(text: string, start: number): { value: string; end: number } | undefined {
  const escapes: Record<string, number> = {
    a: 7,
    b: 8,
    t: 9,
    n: 10,
    v: 11,
    f: 12,
    r: 13,
    '"': 34,
    '\\': 92,
  };
  const encoder = new TextEncoder();
  const bytes: number[] = [];
  for (let index = start + 1; index < text.length; index++) {
    const char = text[index];
    if (char === '"')
      return { value: new TextDecoder().decode(new Uint8Array(bytes)), end: index + 1 };
    if (char !== '\\') {
      const point = String.fromCodePoint(text.codePointAt(index)!);
      bytes.push(...encoder.encode(point));
      index += point.length - 1;
      continue;
    }
    const next = text[++index];
    if (next !== undefined && escapes[next] !== undefined) bytes.push(escapes[next]);
    else if (/^[0-7]{3}$/.test(text.slice(index, index + 3))) {
      bytes.push(parseInt(text.slice(index, index + 3), 8));
      index += 2;
    } else return undefined;
  }
  return undefined;
}

function unquotePath(raw: string): string | undefined {
  return raw.startsWith('"') ? readQuoted(raw, 0)?.value : raw;
}

/** Only `diff --git`, `---` and `+++` paths carry the a/ and b/ prefixes. */
function prefixedPath(raw: string): string | undefined {
  return unquotePath(raw)?.replace(/^[ab]\//, '');
}

/** `diff --git a/P b/P` names one path twice when no other header names it. */
function headerPaths(rest: string): [string, string] | undefined {
  if (rest.startsWith('"')) {
    const first = readQuoted(rest, 0);
    const second = first && prefixedPath(rest.slice(first.end + 1));
    return first && second !== undefined ? [first.value.replace(/^[ab]\//, ''), second] : undefined;
  }
  const half = (rest.length - 1) / 2;
  const [a, b] = [rest.slice(0, half), rest.slice(half + 1)];
  return Number.isInteger(half) && a.slice(2) === b.slice(2) ? [a.slice(2), b.slice(2)] : undefined;
}

function readHunk(lines: string[], start: number): { hunk?: UnifiedDiffHunk; next: number } {
  const header = HUNK_HEADER.exec(lines[start]);
  if (!header) return { next: start + 1 };
  const hunk: UnifiedDiffHunk = {
    oldStart: Number(header[1]),
    oldLines: header[2] === undefined ? 1 : Number(header[2]),
    lines: [],
  };
  let oldLeft = hunk.oldLines;
  let newLeft = header[4] === undefined ? 1 : Number(header[4]);
  let index = start + 1;
  while (oldLeft > 0 || newLeft > 0) {
    const line = lines[index];
    const op = line?.[0];
    if (op !== ' ' && op !== '-' && op !== '+') return { next: index };
    if (op !== '+') oldLeft--;
    if (op !== '-') newLeft--;
    if (oldLeft < 0 || newLeft < 0) return { next: index };
    hunk.lines.push({ op, text: `${line.slice(1)}\n` });
    index++;
    if (lines[index]?.startsWith('\\')) {
      const last = hunk.lines[hunk.lines.length - 1];
      last.text = last.text.slice(0, -1);
      index++;
    }
  }
  return { hunk, next: index };
}

/** Parses git's unified diff output, including rename, mode and binary headers. */
export function parseUnifiedDiff(text: string): UnifiedDiffFile[] {
  const lines = text.split('\n');
  const files: UnifiedDiffFile[] = [];
  let index = 0;
  while (index < lines.length) {
    if (!lines[index].startsWith('diff --git ')) {
      index++;
      continue;
    }
    const file: UnifiedDiffFile = { binary: false, malformed: false, hunks: [] };
    const header = headerPaths(lines[index].slice('diff --git '.length));
    const named: { from?: string; to?: string; minus?: string | null; plus?: string | null } = {};
    let added = false;
    let deleted = false;
    for (index++; index < lines.length; index++) {
      const line = lines[index];
      if (line.startsWith('diff --git ') || line.startsWith('@@ ')) break;
      const name = HEADER_FIELDS.find((field) => line.startsWith(`${field} `));
      const value = name ? line.slice(name.length + 1) : '';
      if (name === 'new file mode') [added, file.newMode] = [true, value];
      else if (name === 'deleted file mode') [deleted, file.oldMode] = [true, value];
      else if (name === 'old mode') file.oldMode = value;
      else if (name === 'new mode') file.newMode = value;
      else if (name === 'rename from' || name === 'copy from') named.from = unquotePath(value);
      else if (name === 'rename to' || name === 'copy to') named.to = unquotePath(value);
      else if (name === 'index') {
        const ids = /^([0-9a-f]+)\.\.([0-9a-f]+)(?: ([0-7]{6}))?$/.exec(value);
        if (ids) {
          [file.oldId, file.newId] = [ids[1], ids[2]];
          if (ids[3]) file.oldMode = file.newMode = ids[3];
        }
      } else if (line.startsWith('--- ') || line.startsWith('+++ ')) {
        const path = line.slice(4).replace(/\t$/, '');
        named[line[0] === '-' ? 'minus' : 'plus'] =
          path === '/dev/null' ? null : prefixedPath(path);
      } else if (line === 'GIT binary patch' || /^Binary files .* differ$/.test(line))
        file.binary = true;
    }
    const oldPath = named.minus === undefined ? (named.from ?? header?.[0]) : named.minus;
    const newPath = named.plus === undefined ? (named.to ?? header?.[1]) : named.plus;
    file.oldPath = added ? undefined : (oldPath ?? undefined);
    file.newPath = deleted ? undefined : (newPath ?? undefined);
    while (lines[index]?.startsWith('@@ ')) {
      const read = readHunk(lines, index);
      index = read.next;
      if (read.hunk) file.hunks.push(read.hunk);
      else {
        file.malformed = true;
        while (index < lines.length && !lines[index].startsWith('diff --git ')) index++;
      }
    }
    files.push(file);
  }
  return files;
}

function splitLines(text: string): string[] {
  const lines: string[] = [];
  for (let start = 0; start < text.length; ) {
    const end = text.indexOf('\n', start);
    lines.push(text.slice(start, end < 0 ? text.length : end + 1));
    start = end < 0 ? text.length : end + 1;
  }
  return lines;
}

/** Applies a file's hunks exactly, without offsets or fuzz. Undefined when they do not apply. */
export function applyUnifiedDiff(
  base: string,
  file: Pick<UnifiedDiffFile, 'binary' | 'malformed' | 'hunks'>,
): string | undefined {
  if (file.binary || file.malformed) return undefined;
  const source = splitLines(base);
  const output: string[] = [];
  let index = 0;
  for (const hunk of file.hunks) {
    const start = hunk.oldLines === 0 ? hunk.oldStart : hunk.oldStart - 1;
    if (start < index || start > source.length) return undefined;
    output.push(...source.slice(index, start));
    index = start;
    for (const line of hunk.lines) {
      if (line.op === '+') {
        output.push(line.text);
        continue;
      }
      if (source[index] !== line.text) return undefined;
      if (line.op === ' ') output.push(line.text);
      index++;
    }
  }
  output.push(...source.slice(index));
  return output.join('');
}
