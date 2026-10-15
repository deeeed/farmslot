import { createHash } from 'node:crypto';
import { closeSync, openSync, readSync } from 'node:fs';

export function sha256File(filePath: string): string {
  const hash = createHash('sha256');
  const fd = openSync(filePath, 'r');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let bytes: number;
    while ((bytes = readSync(fd, buffer, 0, buffer.length, null)) > 0)
      hash.update(buffer.subarray(0, bytes));
  } finally {
    closeSync(fd);
  }
  return hash.digest('hex');
}

export function sha256Text(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}
