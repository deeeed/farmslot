import { readFile } from 'node:fs/promises';

export async function readJsonFile(filePath: string): Promise<unknown> {
  return JSON.parse(await readFile(filePath, 'utf-8'));
}
