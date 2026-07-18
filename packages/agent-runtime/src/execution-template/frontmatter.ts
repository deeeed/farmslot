import type { ExecutionRunMode, ExecutionTemplateFrontmatter } from './types.js';

const RUN_MODES = new Set<ExecutionRunMode>(['autonomous', 'interactive', 'validation']);

export interface ParsedMarkdownDocument {
  frontmatter: ExecutionTemplateFrontmatter | null;
  body: string;
  heading: string | null;
}

function stripQuotes(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function parseScalar(raw: string): string | number | boolean {
  const value = stripQuotes(raw.trim());
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  return value;
}

function parseInlineArray(raw: string): unknown[] {
  const inner = raw.trim().slice(1, -1).trim();
  if (!inner) return [];
  return inner.split(',').map((part) => parseScalar(part.trim()));
}

/**
 * Minimal frontmatter parser for optional execution-template metadata.
 * Supports `key: value` and `key: [a, b]` only — no nested YAML documents.
 */
export function parseMarkdownDocument(text: string): ParsedMarkdownDocument {
  const normalized = text.replace(/^\uFEFF/, '');
  let frontmatter: ExecutionTemplateFrontmatter | null = null;
  let body = normalized;

  if (normalized.startsWith('---\n') || normalized.startsWith('---\r\n')) {
    // Search from 3 (the opening fence's own newline) so an EMPTY block
    // (`---\n---`) still finds its closing fence.
    const end = normalized.indexOf('\n---', 3);
    if (end !== -1) {
      const fmBlock = normalized.slice(4, end).replace(/\r/g, '');
      const rest = normalized.slice(end + '\n---'.length).replace(/^\r?\n/, '');
      frontmatter = {};
      for (const line of fmBlock.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const colon = trimmed.indexOf(':');
        if (colon <= 0) continue;
        const key = trimmed.slice(0, colon).trim();
        const rawValue = trimmed.slice(colon + 1).trim();
        if (!key) continue;
        const value =
          rawValue.startsWith('[') && rawValue.endsWith(']')
            ? parseInlineArray(rawValue)
            : parseScalar(rawValue);
        frontmatter[key] = value;
      }
      body = rest;
    }
  }

  const headingMatch = body.match(/^#\s+(.+)$/m);
  const heading = headingMatch?.[1]?.trim() ?? null;
  return { frontmatter, body, heading };
}

export function normalizeRunMode(value: unknown): ExecutionRunMode | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  return RUN_MODES.has(normalized as ExecutionRunMode) ? (normalized as ExecutionRunMode) : null;
}

export function normalizePlatforms(value: unknown): string[] | null {
  if (value == null) return null;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed ? [trimmed] : null;
  }
  if (!Array.isArray(value)) return null;
  const platforms = value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter(Boolean);
  return platforms.length > 0 ? platforms : null;
}

export function frontmatterRunMode(
  frontmatter: ExecutionTemplateFrontmatter | null,
): ExecutionRunMode | null {
  if (!frontmatter) return null;
  return normalizeRunMode(frontmatter.runMode ?? frontmatter.run_mode);
}

export function frontmatterPlatforms(
  frontmatter: ExecutionTemplateFrontmatter | null,
): string[] | null {
  if (!frontmatter) return null;
  return normalizePlatforms(frontmatter.platforms);
}
