// fixtures.ts — Fixture compose/render decision core.
//
// TypeScript port of the template/compose selection + render loop that used to
// live in scripts/sync-fixtures.sh. Collapsing it here removes the per-template
// `farmslot internal expand-template` / `render-fixture-template` node cold
// starts (~0.3s each, ~40 per large-pack sync) into a single invocation, and
// makes the compose selection contract testable in one place.
//
// The remote copy (ssh/scp/rsync + skip-worktree marking) and the directory
// rsync stay in sync-fixtures.sh: those are side-effect edges, not decision
// logic.

import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

import type { ProjectVars, SlotVars } from './config.js';
import { expandFixturePath, expandTemplate, fixtureTemplateVars } from './hooks.js';

export interface FixturePlanLog {
  /**
   * `PLAN` marks a file the plan will render for copy — the caller emits the
   * `[OK]` line only after the copy actually lands, so a failed scp/update-index
   * never leaves a log claiming success for a file that was never installed.
   */
  level: 'PLAN' | 'SKIP' | 'WARN';
  /** Operator-facing message, without the leading indent sync-fixtures.sh adds. */
  message: string;
}

export interface FixturePlanFile {
  /** Destination path relative to the slot repo, with placeholders resolved. */
  dst: string;
  /** Fully rendered file content ready to copy to the slot. */
  content: string;
}

export interface FixturePlan {
  files: FixturePlanFile[];
  logs: FixturePlanLog[];
}

export interface FixturePlanOptions {
  slotVars: SlotVars;
  projectVars: ProjectVars;
  /**
   * Values a compose entry's `var` (e.g. `FLOW_TYPE`, `APP`) is looked up in.
   * Assembled by the caller from the sync flags/env; the core never reads the
   * environment itself.
   */
  selectionVars?: Record<string, string>;
  /** Runtime overlay vars forwarded to template expansion (e.g. `domain`). */
  extraVars?: Record<string, string>;
}

interface ComposeVariant {
  file?: string;
  includes?: unknown[];
}

async function fixtureExists(p: string, directory = false): Promise<boolean> {
  try {
    const s = await stat(p);
    return directory ? s.isDirectory() : s.isFile();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return false;
    throw error;
  }
}

function missingRequiredFixture(src: string, dst: string, project: ProjectVars): Error {
  return Object.assign(
    new Error(
      `Required fixture ${src || '<empty source>'} not found for ${dst} (${project.projectConfig})`,
    ),
    {
      code: 'REQUIRED_FIXTURE_MISSING',
      userAction:
        'Restore the source in the project pack or correct its fixture declaration. ' +
        'Mark a template or include optional only when the input is genuinely optional.',
    },
  );
}

/**
 * Compute the fixture plan for a slot: which template/compose destinations to
 * write (with rendered content) and the operator log lines, in the same order
 * and wording sync-fixtures.sh emitted. Directories are handled by the caller.
 */
export async function computeFixturePlan(opts: FixturePlanOptions): Promise<FixturePlan> {
  const { slotVars, projectVars, selectionVars = {} } = opts;
  const extraVars = fixtureTemplateVars(slotVars, projectVars, opts.extraVars);
  const templates = projectVars.projectJson.fixtures?.templates ?? [];
  const fixturesDir = projectVars.projectFixturesDir;

  const files: FixturePlanFile[] = [];
  const logs: FixturePlanLog[] = [];
  const expandPath = (text: string): string =>
    expandFixturePath(text, slotVars, projectVars, extraVars);
  const render = (content: string): string =>
    expandTemplate(content, slotVars, projectVars, extraVars);

  for (const entry of templates) {
    const dst = expandPath(entry.dst);
    // The dst→staged-file manifest sync-fixtures.sh reads is tab/newline
    // delimited (unvalidated project.json input). A tab or newline in a
    // destination would split one record into two and copy from the wrong
    // staged path, so reject it at plan time with a clear error.
    if (/[\t\n]/.test(dst)) {
      throw Object.assign(
        new Error(`Fixture destination must not contain a tab or newline: ${JSON.stringify(dst)}`),
        {
          code: 'INVALID_FIXTURE_DST',
          userAction:
            'Fix the fixtures.templates[].dst value in project.json — destinations are file paths without tabs or newlines.',
        },
      );
    }
    const src = entry.src ? expandPath(entry.src) : '';
    const optional = Boolean(entry.optional);
    const compose = (entry.compose as Record<string, unknown> | undefined) ?? undefined;
    const composeVar = compose ? String(compose.var ?? '') : '';

    if (composeVar) {
      // === Compose entry (variant-based) ===
      let flowVal = selectionVars[composeVar] ?? '';
      if (flowVal === 'default') flowVal = '';
      const variants = (compose?.variants as Record<string, unknown> | undefined) ?? {};
      if (!flowVal) {
        const available = Object.keys(variants)
          .map((k) => (k === '' ? 'default' : k))
          .join(' ');
        logs.push({
          level: 'SKIP',
          message: `${dst} — ${composeVar} not set (variants: ${available})`,
        });
        continue;
      }

      const v = variants[flowVal];
      const isObj = v !== null && typeof v === 'object';
      const variantObj = isObj ? (v as ComposeVariant) : undefined;
      let variantFile = variantObj ? (variantObj.file ?? '') : typeof v === 'string' ? v : '';
      if (variantFile) variantFile = expandPath(variantFile);
      const includes: unknown[] = variantObj
        ? (variantObj.includes ?? [])
        : ((compose?.includes as unknown[] | undefined) ?? []);

      let composed = '';
      if (variantFile && (await fixtureExists(path.join(fixturesDir, variantFile)))) {
        composed = await readFile(path.join(fixturesDir, variantFile), 'utf-8');
      } else if (variantFile) {
        if (!optional) throw missingRequiredFixture(variantFile, dst, projectVars);
        logs.push({ level: 'SKIP', message: `${dst} — optional src ${variantFile} not present` });
        continue;
      }

      for (const inc of includes) {
        const incIsObj = inc !== null && typeof inc === 'object';
        let incFile = incIsObj ? String((inc as { file?: unknown }).file ?? '') : String(inc);
        const incOptional = incIsObj && Boolean((inc as { optional?: unknown }).optional);
        if (incFile) incFile = expandPath(incFile);
        if (incFile && (await fixtureExists(path.join(fixturesDir, incFile)))) {
          composed += `\n${await readFile(path.join(fixturesDir, incFile), 'utf-8')}`;
        } else if (incOptional) {
          logs.push({
            level: 'SKIP',
            message: `optional include ${incFile || '<empty>'} not present`,
          });
        } else {
          throw missingRequiredFixture(incFile, dst, projectVars);
        }
      }

      files.push({ dst, content: render(composed) });
      logs.push({ level: 'PLAN', message: `${dst} (composed: ${variantFile || 'includes'})` });
    } else if (src) {
      // === Template or plain file entry ===
      const localTpl = path.join(fixturesDir, src);
      if (await fixtureExists(localTpl)) {
        files.push({ dst, content: render(await readFile(localTpl, 'utf-8')) });
        logs.push({ level: 'PLAN', message: dst });
      } else if (optional) {
        logs.push({ level: 'SKIP', message: `${dst} — optional src ${src} not present` });
      } else {
        throw missingRequiredFixture(src, dst, projectVars);
      }
    } else {
      logs.push({ level: 'SKIP', message: `${dst} — no src or compose` });
    }
  }

  // Directory copies remain shell edges, but source admission belongs to this
  // same planner so prepare cannot accept a missing declared directory either.
  for (const entry of projectVars.projectJson.fixtures?.directories ?? []) {
    if (!(await fixtureExists(path.join(fixturesDir, entry.src), true))) {
      throw missingRequiredFixture(entry.src, expandPath(entry.dst), projectVars);
    }
  }

  return { files, logs };
}
