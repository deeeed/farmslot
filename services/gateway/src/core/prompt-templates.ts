// prompt-templates.ts — Load project-specific LLM prompt templates (ADR-021)
// Templates live in projects/<name>/templates/prompts/<template>.md
// Returns null if template doesn't exist — caller uses hardcoded fallback.

import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { farmslotRoot } from './config.js';
import { assertNoUnknownPlaceholders } from './hooks.js';

export async function loadPromptTemplate(
  project: string,
  templateName: string,
  vars: Record<string, string>,
): Promise<string | null> {
  const templatePath = path.join(
    farmslotRoot,
    'projects',
    project,
    'templates',
    'prompts',
    templateName,
  );
  let raw: string;
  try {
    raw = await readFile(templatePath, 'utf-8');
  } catch (err) {
    // Missing template is an expected state — caller uses its fallback.
    // Anything else (EACCES, EIO, ...) is a real failure and must surface.
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    return null;
  }
  const known = new Set<string>();
  let expanded = raw;
  for (const [key, val] of Object.entries(vars)) {
    expanded = expanded.replaceAll(`{{${key}}}`, val);
    expanded = expanded.replaceAll(`{{${key.toUpperCase()}}}`, val);
    expanded = expanded.replaceAll(`{{${key.toLowerCase()}}}`, val);
    known.add(key);
    known.add(key.toUpperCase());
    known.add(key.toLowerCase());
  }
  assertNoUnknownPlaceholders(raw, known, `Prompt template ${templatePath}`);
  return expanded;
}
