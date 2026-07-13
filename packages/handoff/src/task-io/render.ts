import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveContent, type ResolveContext } from '../resolve/resolve-file.js';
import type { ResolutionSource, SourceDocument } from '../spec/types.js';

/** Tier roots for template resolution. All optional except the shipped default. */
export interface RenderContext extends ResolveContext {
  /** $FARMSLOT_HOME - personal tier root. */
  farmslotHome?: string;
  /** Farm repo root - farm/domain tiers. */
  farmRoot?: string;
  /** Active domain overlay key, if any. */
  domain?: string;
}

export interface RenderTaskMarkdownOptions {
  /** The normalized task (source.json shape) the template renders against. */
  task: SourceDocument;
  /** Flow type selecting the template file, e.g. "dev", "fix-bug". */
  flowType: string;
  /** Explicit template path - bypasses the resolution chain when set. */
  templateRef?: string;
  /** Extra {{placeholder}} substitutions the caller provides. */
  vars?: Record<string, string>;
}

export interface RenderTaskMarkdownResult {
  markdown: string;
  resolvedTemplate: string;
  /** The resolution event for provenance.json (spec section 4.3). */
  templateProvenance: ResolutionSource;
}

/** Shipped default template, sitting beside src/ and dist/ at the package root. */
const DEFAULT_TEMPLATE = fileURLToPath(new URL('../../templates/task-default.md', import.meta.url));

/** An empty template renders an empty task doc - treat as broken so the chain
 * degrades to the shipped default instead (unhappy-path contract). */
function parseTemplate(raw: string, templatePath: string): string {
  if (raw.trim() === '') {
    throw new Error(`template ${templatePath} is empty`);
  }
  return raw;
}

function substitutions(task: SourceDocument, vars: Record<string, string>): Record<string, string> {
  return {
    title: task.title ?? 'Untitled task',
    sourceKind: task.sourceKind,
    sourceRef: task.sourceRef ?? '',
    sourceRefLine: task.sourceRef ? `\n- Ref: ${task.sourceRef}` : '',
    ticket: task.ticket ?? '',
    ticketLine: task.ticket ? `\n- Ticket: ${task.ticket}` : '',
    description: task.description ?? '_No description provided by the source._',
    acceptanceCriteria:
      task.acceptanceCriteria && task.acceptanceCriteria.trim() !== ''
        ? task.acceptanceCriteria
        : '_No acceptance criteria provided by the source (stub - refine before starting)._',
    ...vars,
  };
}

/**
 * Render the task document markdown (spec section 3.1) from the first-match
 * template in the `personal > domain > farm > default` chain. A broken override
 * template warns and degrades to the shipped default - it never aborts. Which
 * template won (and what it shadowed) is returned for provenance.json; it is
 * never embedded in the markdown itself.
 */
export function renderTaskMarkdown(
  options: RenderTaskMarkdownOptions,
  ctx: RenderContext = {},
): RenderTaskMarkdownResult {
  const flowFile = `${options.flowType}.md`;

  // An EXPLICITLY configured template path that does not exist is a broken
  // override (unlike a merely absent tier file, which falls through silently
  // per the unhappy-path contract): warn before degrading through the chain.
  if (options.templateRef && !existsSync(options.templateRef)) {
    ctx.warn?.(
      `renderTaskMarkdown: configured templateRef ${options.templateRef} does not exist; ` +
        'falling back through the resolution chain. Next: fix or remove the explicit ' +
        'template path - the run continues on the resolved template.',
    );
  }

  const resolved = resolveContent(
    {
      kind: 'task-template',
      personal: [
        ...(options.templateRef ? [options.templateRef] : []),
        ...(ctx.farmslotHome ? [path.join(ctx.farmslotHome, 'handoff/templates', flowFile)] : []),
      ],
      domain:
        ctx.farmRoot && ctx.domain
          ? [path.join(ctx.farmRoot, 'domains', ctx.domain, 'templates', flowFile)]
          : [],
      farm: ctx.farmRoot ? [path.join(ctx.farmRoot, 'templates/worker', flowFile)] : [],
      defaultPath: DEFAULT_TEMPLATE,
    },
    parseTemplate,
    ctx,
  );

  const subs = substitutions(options.task, options.vars ?? {});
  const markdown = resolved.value.replace(/\{\{([a-zA-Z0-9_-]+)\}\}/g, (whole, name: string) =>
    name in subs ? subs[name] : whole,
  );

  return {
    markdown,
    resolvedTemplate: resolved.resolution.resolvedPath,
    templateProvenance: resolved.resolution,
  };
}
