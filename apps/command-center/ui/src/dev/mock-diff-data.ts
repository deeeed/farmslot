// Every context line MUST start with a single space — including blank lines.
// Without the leading space, diff2html can't parse side-by-side correctly.
export const MOCK_UNIFIED_DIFF = [
  'diff --git a/src/config.ts b/src/config.ts',
  'index 1a2b3c4..5d6e7f8 100644',
  '--- a/src/config.ts',
  '+++ b/src/config.ts',
  '@@ -1,15 +1,25 @@',
  " import { readFile } from 'node:fs/promises';",
  "+import { existsSync } from 'node:fs';",
  ' ',
  ' interface Config {',
  '   port: number;',
  '   host: string;',
  '+  debug?: boolean;',
  "+  logLevel?: 'info' | 'warn' | 'error';",
  ' }',
  ' ',
  '-export function loadConfig(path: string): Promise<Config> {',
  "-  const raw = await readFile(path, 'utf-8');",
  '-  return JSON.parse(raw);',
  '+export async function loadConfig(path: string): Promise<Config> {',
  '+  if (!existsSync(path)) {',
  '+    throw new Error(`Config file not found: ${path}`);',
  '+  }',
  "+  const raw = await readFile(path, 'utf-8');",
  '+  const config = JSON.parse(raw) as Config;',
  '+  if (!validateConfig(config)) {',
  "+    throw new Error('Invalid config');",
  '+  }',
  '+  return config;',
  ' }',
  ' ',
  ' export function validateConfig(config: Config): boolean {',
  '-  return config.port > 0 && config.port < 65536;',
  '+  if (config.port <= 0 || config.port >= 65536) return false;',
  '+  if (!config.host || config.host.length === 0) return false;',
  '+  return true;',
  ' }',
].join('\n');

/** The final (modified) file content — what the code-viewer shows */
export const MOCK_MODIFIED_SOURCE = `import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';

interface Config {
  port: number;
  host: string;
  debug?: boolean;
  logLevel?: 'info' | 'warn' | 'error';
}

export async function loadConfig(path: string): Promise<Config> {
  if (!existsSync(path)) {
    throw new Error(\`Config file not found: \${path}\`);
  }
  const raw = await readFile(path, 'utf-8');
  const config = JSON.parse(raw) as Config;
  if (!validateConfig(config)) {
    throw new Error('Invalid config');
  }
  return config;
}

export function validateConfig(config: Config): boolean {
  if (config.port <= 0 || config.port >= 65536) return false;
  if (!config.host || config.host.length === 0) return false;
  return true;
}
`;

/** 1-based line numbers that were added or modified */
export const MOCK_CHANGED_LINES = [2, 7, 8, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 25, 26, 27];
