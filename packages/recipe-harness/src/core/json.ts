import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

export async function readJsonFile(filePath: string): Promise<unknown> {
  const text = await readFile(filePath, 'utf-8');
  try {
    return JSON.parse(text);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to parse JSON file ${filePath}: ${message}`);
  }
}

export async function writeJsonFile(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

export function asString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return value;
}

export function asOptionalString(value: unknown, label: string): string | undefined {
  if (value == null) return undefined;
  return asString(value, label);
}

export function asNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${label} must be a finite number.`);
  }
  return value;
}

export function normalizeRelativePath(relativePath: string): string {
  if (path.isAbsolute(relativePath) || /^[A-Za-z]:/.test(relativePath)) {
    throw new Error(`Path ${relativePath} must be relative.`);
  }
  const normalized = path.normalize(relativePath);
  if (normalized === '..' || normalized.startsWith(`..${path.sep}`)) {
    throw new Error(`Path ${relativePath} must not escape its root.`);
  }
  return normalized;
}

export function getJsonPathValue(value: unknown, jsonPath: string): unknown {
  if (jsonPath === '$') return value;
  if (!jsonPath.startsWith('$.')) {
    throw new Error(`Only simple $.path JSON paths are supported, received ${jsonPath}.`);
  }
  const parts = jsonPath
    .slice(2)
    .replaceAll('[', '.')
    .replaceAll(']', '')
    .split('.')
    .filter(Boolean);
  let current = value;
  for (const part of parts) {
    if (Array.isArray(current)) {
      const index = Number(part);
      if (!Number.isInteger(index)) return undefined;
      current = current[index];
      continue;
    }
    if (!isRecord(current)) return undefined;
    current = current[part];
  }
  return current;
}
