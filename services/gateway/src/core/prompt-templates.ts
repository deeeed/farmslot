// prompt-templates.ts — Load project-specific LLM prompt templates (ADR-021)
// Templates live in projects/<name>/templates/prompts/<template>.md
// Returns null if template doesn't exist — caller uses hardcoded fallback.

import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { farmslotRoot } from './config.js';

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
  try {
    const raw = await readFile(templatePath, 'utf-8');
    let expanded = raw;
    for (const [key, val] of Object.entries(vars)) {
      expanded = expanded.replaceAll(`{{${key}}}`, val);
      expanded = expanded.replaceAll(`{{${key.toUpperCase()}}}`, val);
      expanded = expanded.replaceAll(`{{${key.toLowerCase()}}}`, val);
    }
    return expanded;
  } catch {
    return null;
  }
}
