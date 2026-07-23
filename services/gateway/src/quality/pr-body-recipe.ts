// pr-body-recipe.ts — LLM extraction of validation recipes from PR descriptions.
//
// When a follow-up flow (typically pr-complete) has no recipe inheritable
// through the family chain, this module scans the PR body for an embedded
// `## Validation Recipe` block + dependency recipe files and materializes them as
// the run's local recipe artifacts. Strictly LLM-driven (no regex parsers) so
// it survives format drift across PR templates.
//
// SECURITY — UNTRUSTED INPUT:
// PR bodies are author-controlled. Any external GitHub user who can open a PR
// can write arbitrary content into the description, including hostile prompt
// content and adversarial recipe payloads. Recipes from this extractor are
// **untrusted**; recipes from family inheritance (authored by a previous
// farmslot worker run) are trusted.
//
// Current shipped enforcement (don't oversell — describe what actually
// runs):
//   1. `materializeExtractedRecipe` writes the candidate recipe ONLY under
//      `inputs/inherited/recipe.json` (+ a library under
//      `inputs/inherited/recipe-library/`). It never seeds
//      `artifacts/recipe.json`, so the recipe runner (validate-recipe.js)
//      cannot resolve and execute the staged content by default.
//   2. `materializeExtractedRecipe` writes a sidecar
//      `inputs/inherited/recipe-source.json` with provenance tag
//      `pr-body-llm-extracted-untrusted`.
//   3. `task-writer.ts` sets `vars.RECIPE_SOURCE = 'pr-body-llm'` on a
//      successful extraction and leaves `HAS_RECIPE='no'` because nothing
//      is in the artifacts dir. The pr-complete worker template renders
//      `{{RECIPE_SOURCE}}` in the Task header AND includes a Recipe
//      Provenance section instructing the worker LLM to (a) read the
//      staged recipe + sidecar, (b) refuse on adversarial-shaped step
//      types, and (c) only copy to `artifacts/recipe.json` after the
//      trust check passes. Skipping the copy keeps the recipe runner
//      blind to the untrusted content even if the worker decides to
//      ignore the template instructions.
//
// What is NOT yet enforced (TODO before granting external-PR autopilot):
//   - The recipe runner (`methods/recipe.ts`) does not yet refuse risky
//     step types based on provenance. A worker that copies the staged
//     recipe into artifacts/ without validating can still execute every
//     step. The lack of seeding is a defense-in-depth speedbump; the
//     code-level control still owes a runner-side gate.
//   - Trusting the worker LLM to honor the advisory is part of the
//     existing autonomous-agent threat model; this PR does not change it.

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { StepLLMUsage } from '@farmslot/protocol';

import { callLLM, type LLMCallResult } from '../llm/index.js';

export interface ExtractedRecipeBundle {
  recipe: unknown;
  recipes: Record<string, unknown>;
}

export type PRBodyRecipeReason =
  | 'extracted'
  | 'no-body'
  | 'body-too-large'
  | 'no-recipe-detected'
  | 'parse-failed'
  | 'parse-truncated'
  | 'llm-failed';

export interface PRBodyRecipeExtractionResult {
  bundle: ExtractedRecipeBundle | null;
  reason: PRBodyRecipeReason;
  usage: StepLLMUsage;
  /** Provider stopReason (e.g. 'maxTokens') when surfaced — distinguishes truncation from format failures. */
  stopReason?: string;
}

const EMPTY_USAGE: StepLLMUsage = {
  provider: '',
  model: '',
  inputTokens: 0,
  outputTokens: 0,
  durationMs: 0,
};

const SYSTEM_PROMPT = `You analyze GitHub PR descriptions and extract embedded validation recipes.

A "validation recipe" is a JSON object describing automated UI/integration test steps. Some PRs inline them in a "Validation Recipe" (or similar) section as fenced JSON code blocks. PRs may also inline reusable Recipe v1 dependency documents referenced from the main recipe.

Your task:
- Locate the recipe JSON block (label/<summary>/filename hint mentions "recipe.json", "artifacts/recipe.json", or "Validation Recipe").
- Locate dependency recipe blocks (label/<summary> mentions "recipe-library/recipes/<path>.recipe.json").
- Return their JSON content. Preserve the full structure — workflow nodes, steps, schema metadata, etc. Do not paraphrase descriptions; do not summarize.
- If a section only describes a recipe in prose without an inline JSON block, return found=false.

Recipe keys must be relative paths under recipes/ ending in ".recipe.json".

Respond with ONLY a single JSON object, no markdown, no fences, no commentary, no <thinking> blocks, no preamble. Your entire response must be parseable by JSON.parse.

{
  "found": true | false,
  "recipe": <recipe JSON> | null,
  "recipes": { "<path>.recipe.json": <recipe JSON>, ... }
}

If no embedded recipe is present: {"found": false, "recipe": null, "recipes": {}}`;

// Hard ceiling. PRs that approach this size are exceptional and the recipe
// almost certainly doesn't fit anyway. Bail with a clear reason rather than
// silently slicing through the recipe block.
const MAX_BODY_CHARS = 200_000;

const PROVENANCE_FILE = 'recipe-source.json';
export const PR_BODY_PROVENANCE = 'pr-body-llm-extracted-untrusted';

/**
 * Extract a validation recipe from a GitHub PR description.
 *
 * Caller is responsible for materialising the result to disk (see
 * {@link materializeExtractedRecipe}). Errors are non-fatal — pre-fetch
 * resilience: a failure here just leaves HAS_RECIPE=no and the worker uses
 * its existing fallback path.
 */
export async function extractRecipeFromPRBody(
  prBody: string,
): Promise<PRBodyRecipeExtractionResult> {
  const body = (prBody ?? '').trim();
  if (body.length < 200) {
    return { bundle: null, reason: 'no-body', usage: EMPTY_USAGE };
  }
  if (body.length > MAX_BODY_CHARS) {
    console.warn(
      `[pr-body-recipe] body too large (${body.length} chars > ${MAX_BODY_CHARS}); skipping extraction to avoid mid-fence truncation`,
    );
    return { bundle: null, reason: 'body-too-large', usage: EMPTY_USAGE };
  }

  // Recipe extraction emits structured JSON up to ~10k output tokens with a
  // ~60k-char input prompt. openai-codex via pi-ai (verified through 0.74.2)
  // returns content=[] under that combined load even on gpt-5.5. Anthropic
  // sonnet handles it cleanly, so we pin this specific call to anthropic
  // unless explicitly overridden — separate from the gateway-wide default
  // provider used by lighter intelligence tasks.
  const provider = process.env.PR_BODY_RECIPE_PROVIDER ?? 'anthropic';
  const model = process.env.PR_BODY_RECIPE_MODEL ?? 'sonnet';
  let result: LLMCallResult;
  try {
    result = await callLLM({
      systemPrompt: SYSTEM_PROMPT,
      userPrompt: `PR description:\n\n${body}`,
      provider,
      model,
      // Root and dependency recipes for a multi-AC PR routinely exceed 10k output
      // tokens. Default LLM caps would truncate mid-JSON and the parser
      // would reject the partial response.
      maxTokens: 32_000,
    });
  } catch (err) {
    console.warn(`[pr-body-recipe] callLLM failed: ${(err as Error).message}`);
    return { bundle: null, reason: 'llm-failed', usage: EMPTY_USAGE };
  }
  if (process.env.DEBUG_PR_BODY_RECIPE) {
    console.warn(`[pr-body-recipe] raw response (first 500 chars): ${result.text.slice(0, 500)}`);
  }

  // Some models prefix the JSON with `<thinking>...</thinking>` blocks, prose
  // preambles, or markdown fences even when explicitly told not to. A greedy
  // regex (`/\{[\s\S]*\}/`) would match across those, breaking JSON.parse.
  // Scan backward from the trailing `}` to find the matching `{`.
  const candidate = extractTrailingJsonObject(result.text);
  const stopReason = result.stopReason;
  if (!candidate) {
    if (process.env.DEBUG_PR_BODY_RECIPE) {
      console.warn(
        `[pr-body-recipe] no balanced JSON object in response (stopReason=${stopReason ?? 'unknown'}): ${result.text.slice(0, 400)}`,
      );
    }
    return {
      bundle: null,
      reason: stopReason === 'length' ? 'parse-truncated' : 'parse-failed',
      usage: result.usage,
      stopReason,
    };
  }

  let parsed: { found?: boolean; recipe?: unknown; recipes?: Record<string, unknown> };
  try {
    parsed = JSON.parse(candidate);
  } catch (err) {
    if (process.env.DEBUG_PR_BODY_RECIPE) {
      console.warn(
        `[pr-body-recipe] JSON.parse failed (${(err as Error).message}, stopReason=${stopReason ?? 'unknown'}): ${candidate.slice(0, 400)}`,
      );
    }
    return {
      bundle: null,
      reason: stopReason === 'length' ? 'parse-truncated' : 'parse-failed',
      usage: result.usage,
      stopReason,
    };
  }

  if (!parsed.found || !parsed.recipe || typeof parsed.recipe !== 'object') {
    return { bundle: null, reason: 'no-recipe-detected', usage: result.usage, stopReason };
  }

  // If the provider explicitly signaled max-tokens truncation, reject the
  // candidate even when the JSON happens to be syntactically balanced —
  // for a multi-AC PR bundle the model can close earlier braces "in time"
  // and emit a parseable object that's missing later dependencies or has a
  // partial last recipe. We'd rather surface parse-truncated and let the
  // worker fall through to its smoke fallback than stage an incomplete
  // recipe that looks complete.
  if (stopReason === 'length') {
    if (process.env.DEBUG_PR_BODY_RECIPE) {
      console.warn(
        `[pr-body-recipe] rejecting balanced-but-truncated extraction (stopReason=length, recipes=${parsed.recipes ? Object.keys(parsed.recipes).length : 0})`,
      );
    }
    return { bundle: null, reason: 'parse-truncated', usage: result.usage, stopReason };
  }

  const recipes: Record<string, unknown> = {};
  if (parsed.recipes && typeof parsed.recipes === 'object') {
    for (const [rawName, value] of Object.entries(parsed.recipes)) {
      if (!value || typeof value !== 'object') continue;
      const safeName = sanitizeRecipePath(rawName);
      if (safeName) recipes[safeName] = value;
    }
  }

  return {
    bundle: { recipe: parsed.recipe, recipes },
    reason: 'extracted',
    usage: result.usage,
    stopReason,
  };
}

/**
 * Walk backward from the last `}` to its matching `{`, ignoring brace
 * characters that appear inside double-quoted strings. Returns the substring
 * (inclusive) on success, null when no balanced object is found. This is
 * safer than `/\{[\s\S]*\}/` which spans across multiple objects, and safer
 * than `/\{[\s\S]*?\}/` which stops at the first inner `}`.
 *
 * Unicode-escape note: JSON `}` / `{` are six raw characters in the
 * source text (`\`, `u`, `0`, `0`, `7`, `D|B`) — none of which is a literal
 * `{` or `}`. They only DECODE to braces when JSON.parse runs. Since this
 * scanner operates on the pre-parse byte stream, escape-encoded braces never
 * trip the depth counter. Same for `"` (encoded `"`): the literal
 * source bytes contain no `"` character, so it doesn't toggle string state.
 * The `pr-body-recipe.test.ts` regression covers this directly.
 */
export function extractTrailingJsonObject(text: string): string | null {
  const lastClose = text.lastIndexOf('}');
  if (lastClose < 0) return null;
  let depth = 0;
  let inString = false;
  for (let i = lastClose; i >= 0; i--) {
    const ch = text[i];
    // Quote toggling: only count the quote if it isn't escaped. Walk back to
    // count preceding backslashes — even count means the quote is real.
    if (ch === '"') {
      let backslashes = 0;
      for (let j = i - 1; j >= 0 && text[j] === '\\'; j--) backslashes++;
      if (backslashes % 2 === 0) inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === '}') depth++;
    else if (ch === '{') {
      depth--;
      if (depth === 0) return text.slice(i, lastClose + 1);
    }
  }
  return null;
}

/**
 * Stage the extracted root and dependency recipes under the run's task directory at
 * `inputs/inherited/` ONLY. We deliberately do NOT seed
 * `artifacts/recipe.json` because the recipe runner (validate-recipe.js)
 * resolves recipes from the artifacts dir without consulting
 * `recipe-source.json`, so seeding would silently expose author-controlled
 * recipe steps to execution. The worker template's provenance gate is
 * responsible for reading + validating the staged recipe and copying it
 * to `artifacts/` only after the trust check passes.
 *
 * Also writes a sidecar `inputs/inherited/recipe-source.json` with
 * provenance metadata so any downstream consumer (worker LLM, future
 * recipe-runner enforcement) can branch on trust state.
 */
export async function materializeExtractedRecipe(
  bundle: ExtractedRecipeBundle,
  taskAbsDir: string,
): Promise<{
  inheritedRecipePath: string;
  inheritedRecipeFiles: string[];
  provenancePath: string;
}> {
  const recipeJson = JSON.stringify(bundle.recipe, null, 2);

  const inheritedDir = path.join(taskAbsDir, 'inputs', 'inherited');
  await mkdir(inheritedDir, { recursive: true });
  const inheritedRecipePath = path.join(inheritedDir, 'recipe.json');
  await writeFile(inheritedRecipePath, recipeJson, 'utf-8');

  const provenancePath = path.join(inheritedDir, PROVENANCE_FILE);
  await writeFile(
    provenancePath,
    JSON.stringify(
      {
        source: PR_BODY_PROVENANCE,
        generatedAt: new Date().toISOString(),
        note: 'Recipe content extracted by LLM from author-controlled PR description. Staged at inputs/inherited/ and NOT seeded into artifacts/. Worker template MUST validate recipe shape against the trusted-step-types schema and copy to artifacts/recipe.json only after the trust check passes.',
      },
      null,
      2,
    ),
    'utf-8',
  );

  const recipeNames = Object.keys(bundle.recipes);
  if (recipeNames.length === 0)
    return { inheritedRecipePath, inheritedRecipeFiles: [], provenancePath };

  const inheritedLibraryDir = path.join(inheritedDir, 'recipe-library');
  await mkdir(inheritedLibraryDir, { recursive: true });
  await writeFile(
    path.join(inheritedLibraryDir, 'library.json'),
    `${JSON.stringify({ kind: 'recipe-library', name: 'pr-body' }, null, 2)}\n`,
    'utf-8',
  );
  const inheritedRecipeFiles: string[] = [];
  for (const name of recipeNames) {
    const recipeJson = JSON.stringify(bundle.recipes[name], null, 2);
    const inheritedPath = path.join(inheritedLibraryDir, 'recipes', name);
    await mkdir(path.dirname(inheritedPath), { recursive: true });
    await writeFile(inheritedPath, recipeJson, 'utf-8');
    inheritedRecipeFiles.push(inheritedPath);
  }
  return { inheritedRecipePath, inheritedRecipeFiles, provenancePath };
}

export function sanitizeRecipePath(raw: string): string | null {
  const normalized = raw
    .trim()
    .replaceAll('\\', '/')
    .replace(/^.*?recipes\//, '');
  if (!normalized || path.posix.isAbsolute(normalized)) return null;
  const segments = normalized.split('/');
  if (segments.some((segment) => !/^[A-Za-z0-9._-]+$/.test(segment))) return null;
  if (segments.some((segment) => segment === '.' || segment === '..')) return null;
  return normalized.endsWith('.recipe.json') ? normalized : `${normalized}.recipe.json`;
}
