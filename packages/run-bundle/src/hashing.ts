import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

export function sha256File(filePath: string): string {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

export function sha256Text(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}