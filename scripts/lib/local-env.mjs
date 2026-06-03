import { existsSync, readFileSync } from 'node:fs';

function stripInlineComment(value) {
  let quote = '';
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if ((char === '"' || char === "'") && value[index - 1] !== '\\') {
      quote = quote === char ? '' : quote || char;
      continue;
    }
    if (char === '#' && !quote && /\s/.test(value[index - 1] ?? ' ')) {
      return value.slice(0, index).trimEnd();
    }
  }
  return value;
}

function unquote(value) {
  const trimmed = stripInlineComment(value.trim());
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}

export function loadEnvFile(filePath, { override = false } = {}) {
  if (!existsSync(filePath)) return false;
  const content = readFileSync(filePath, 'utf8');
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const assignment = line.startsWith('export ') ? line.slice('export '.length).trim() : line;
    const equalsIndex = assignment.indexOf('=');
    if (equalsIndex <= 0) continue;
    const key = assignment.slice(0, equalsIndex).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    if (!override && process.env[key] !== undefined) continue;
    const value = unquote(assignment.slice(equalsIndex + 1));
    if (value === '') continue;
    process.env[key] = value;
  }
  return true;
}

export function loadEnvFiles(filePaths, options) {
  return filePaths.filter((filePath) => loadEnvFile(filePath, options));
}
