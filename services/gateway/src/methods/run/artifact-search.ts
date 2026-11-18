import type { RunArtifactSearchResult } from '@farmslot/protocol';

const TEXT_EXTENSIONS = new Set(['log', 'txt', 'md', 'markdown', 'json', 'jsonl']);
const MAX_FILES = 200;
const MAX_FILE_BYTES = 512 * 1024;
const MAX_TOTAL_BYTES = 5 * 1024 * 1024;
const MAX_HITS = 100;

export interface ArtifactSearchDocument {
  bytes: number;
  sha256: string;
  read(): Promise<string>;
}

/** Literal, case-insensitive search; every file read yields through asynchronous IO. */
export async function searchArtifactText(
  paths: readonly string[],
  query: string,
  document: (path: string) => Promise<ArtifactSearchDocument>,
): Promise<Omit<RunArtifactSearchResult, 'runId' | 'bundleDigest'>> {
  const needle = query.trim().toLowerCase();
  if (!needle || needle.length > 200)
    throw new Error('Search query must contain 1–200 characters.');
  const result: Omit<RunArtifactSearchResult, 'runId' | 'bundleDigest'> = {
    files: [],
    searchedFiles: 0,
    skippedFiles: 0,
    partial: false,
  };
  let bytes = 0,
    hits = 0;
  const unique = [...new Set(paths)].filter((file) =>
    TEXT_EXTENSIONS.has(file.split('.').at(-1)?.toLowerCase() ?? ''),
  );
  for (const file of unique.slice(0, MAX_FILES)) {
    if (!TEXT_EXTENSIONS.has(file.split('.').at(-1)?.toLowerCase() ?? '')) continue;
    try {
      const source = await document(file);
      if (source.bytes > MAX_FILE_BYTES || bytes + source.bytes > MAX_TOTAL_BYTES) {
        result.skippedFiles++;
        continue;
      }
      bytes += source.bytes;
      const text = await source.read();
      if (Buffer.byteLength(text) > MAX_FILE_BYTES || text.includes('\0')) {
        result.skippedFiles++;
        continue;
      }
      result.searchedFiles++;
      const matches: RunArtifactSearchResult['files'][number]['hits'] = [];
      const lines = text.split('\n');
      for (let index = 0; index < lines.length; index++) {
        const line = lines[index].endsWith('\r') ? lines[index].slice(0, -1) : lines[index];
        const at = line.toLowerCase().indexOf(needle);
        if (at < 0) continue;
        const start = Math.max(0, at - 60);
        matches.push({ line: index + 1, text: line.slice(start, start + 240) });
        if (++hits === MAX_HITS) {
          result.partial = true;
          break;
        }
      }
      if (matches.length) result.files.push({ path: file, sha256: source.sha256, hits: matches });
      if (hits === MAX_HITS) break;
    } catch {
      result.skippedFiles++;
    }
  }
  result.partial ||= result.skippedFiles > 0 || unique.length > MAX_FILES;
  return result;
}
