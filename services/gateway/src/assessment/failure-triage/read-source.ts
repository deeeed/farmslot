import { open } from 'node:fs/promises';

/** Read complete bounded UTF-8 source text, never a truncated prefix. */
export async function readTriageFile(file: string, maxBytes: number): Promise<string> {
  const handle = await open(file, 'r');
  try {
    if (!(await handle.stat()).isFile()) throw new Error('Triage source is not a file');
    const buffer = Buffer.alloc(maxBytes + 1);
    let offset = 0;
    while (offset <= maxBytes) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    if (offset > maxBytes) throw new Error('Triage source exceeds its byte limit');
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, offset));
  } finally {
    await handle.close();
  }
}
