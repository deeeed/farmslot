// roadmap.ts — gateway RPC surface for roadmap planning. Mirrors backlog:
// the gateway owns the store; this module never touches .roadmap on disk.

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import type { Command } from 'commander';

import {
  parsePromotionDraftAttachment,
  type PlanningContextProjection,
  ROADMAP_ITEM_STAGES,
  type RoadmapDeleteResult,
  type RoadmapDeliveryProjection,
  type RoadmapGetResult,
  type RoadmapItem,
  type RoadmapItemSaveInput,
  type RoadmapItemStage,
  type RoadmapListResult,
  type RoadmapPromoteResult,
  type RoadmapPromoteSpecInput,
  type RoadmapPromotionDraftGetResult,
  type RoadmapPromotionDraftListResult,
  type RoadmapPromotionDraftSaveResult,
  type RoadmapPromptGetResult,
  type RoadmapRefinementSessionGetResult,
  type RoadmapRefineResult,
  type RoadmapSaveResult,
} from '@farmslot/protocol';

import { bold, cyan, dim, green, yellow } from '../colors.js';
import { type CommandContext, resolveContext } from '../context.js';
import { createEmitter } from '../envelope.js';
import { repoRoot } from '../onboarding/workspace.js';
import { withProgress } from '../progress.js';
import { TableRenderer } from '../table.js';

import { createRoadmapPromotionRequest } from './roadmap-promotion-request.js';

interface RequestPromotionOptions {
  itemId?: string;
  itemFile?: string;
  title?: string;
  targetProjects?: string;
  roadmapRoute?: string;
}

/**
 * Accepts a full id or a unique id prefix (same refs Command Center routes use).
 * Returns the whole gateway envelope so callers that need delivery lineage read
 * the shared projection instead of re-deriving it from backlog/run listings.
 */
export async function resolveRoadmapGetResult(
  ctx: CommandContext,
  ref: string,
): Promise<RoadmapGetResult> {
  const needle = ref.trim();
  if (!needle) {
    throw Object.assign(new Error('Roadmap item ref is required.'), {
      code: 'ROADMAP_ITEM_REF_REQUIRED',
      userAction: 'Pass an item id (e.g. ri_157e7d66640c) or a unique id prefix.',
    });
  }

  // Prefer exact get — matches Command Center's itemId route param.
  try {
    return await ctx.client.call<RoadmapGetResult>('roadmap.get', { itemId: needle });
  } catch (err) {
    // Only fall through for missing-item errors. Transport/auth/server failures
    // must not be hidden by a list fallback (cross-review P2).
    const message = err instanceof Error ? err.message : String(err);
    const notFound =
      /not found|Roadmap item not found/i.test(message) ||
      ((err as { code?: string }).code === 'METHOD_ERROR' && /not found/i.test(message));
    if (!notFound) throw err;
  }

  const { items } = await ctx.client.call<RoadmapListResult>('roadmap.list', {
    includeArchived: true,
  });
  const exact = items.find((item) => item.id === needle);
  if (exact) return { item: exact };
  const prefixed = items.filter((item) => item.id.startsWith(needle));
  // The list fallback only runs when `roadmap.get` could not answer, so there is
  // no delivery projection to carry here; `roadmap get` prints the item alone.
  if (prefixed.length === 1) return { item: prefixed[0] };
  if (prefixed.length > 1) {
    throw Object.assign(
      new Error(
        `Ambiguous ref '${needle}' matches ${prefixed.length} items: ${prefixed
          .map((item) => item.id)
          .join(', ')}.`,
      ),
      {
        code: 'ROADMAP_ITEM_AMBIGUOUS',
        userAction: 'Pass the full roadmap item id (e.g. ri_157e7d66640c).',
      },
    );
  }
  throw Object.assign(new Error(`No roadmap item matches '${needle}'.`), {
    code: 'ROADMAP_ITEM_NOT_FOUND',
    userAction: 'List items with `farmslot roadmap list` and pass a full id or unique prefix.',
  });
}

export async function resolveRoadmapItem(ctx: CommandContext, ref: string): Promise<RoadmapItem> {
  return (await resolveRoadmapGetResult(ctx, ref)).item;
}

function renderItems(items: RoadmapItem[]): string {
  const table = new TableRenderer();
  table
    .addColumn('ID')
    .addColumn('STATUS')
    .addColumn('PROJECT', { shrinkable: true, minWidth: 8 })
    .addColumn('TITLE', { shrinkable: true, minWidth: 16 });
  for (const item of items) {
    // Protocol field is `stage`; operator-facing column is STATUS (ticket AC wording).
    const plain = [item.id, item.stage, item.project, item.title];
    table.addRow(plain, [
      cyan(plain[0]),
      item.stage === 'promoted' || item.stage === 'refined' ? green(plain[1]) : yellow(plain[1]),
      plain[2],
      plain[3],
    ]);
  }
  return table.render();
}

/**
 * Human rendering of the shared delivery projection. Planning stage and delivery
 * status are printed as separate axes on purpose — `promoted` never means shipped.
 */
export function renderDeliveryLineage(delivery: RoadmapDeliveryProjection | undefined): string {
  if (!delivery) return '';
  const lines = [
    '',
    bold('Delivery'),
    `  status: ${delivery.status}`,
    `  backlog: ${delivery.backlogItems.length} linked (${delivery.backlogItems.filter((entry) => entry.delivered).length} delivered)`,
  ];
  for (const entry of delivery.backlogItems) {
    const label = entry.ref ?? entry.backlogItemId;
    lines.push(
      `    - ${cyan(label)} ${entry.resolved ? (entry.status ?? 'unknown') : 'MISSING'} [${entry.linkSource}]${entry.specPath ? ` ${dim(entry.specPath)}` : ''}`,
    );
  }
  if (delivery.runFamilies.length) {
    lines.push(`  runs:`);
    for (const family of delivery.runFamilies) {
      lines.push(
        `    - ${cyan(family.latestRunId)} ${family.latestStatus} (family ${family.familyId}, ${family.runIds.length} run${family.runIds.length === 1 ? '' : 's'})`,
      );
    }
  }
  if (delivery.prs.length) {
    lines.push(`  prs:`);
    for (const pr of delivery.prs) {
      lines.push(
        `    - ${green(pr.ref)}${pr.url ? ` ${dim(pr.url)}` : ''} [${pr.sources.join(', ')}]`,
      );
    }
  }
  for (const finding of delivery.findings) {
    lines.push(`  ${yellow(`! ${finding.code}`)} ${finding.detail} ${finding.remediation}`);
  }
  return `${lines.join('\n')}\n`;
}

export function renderPlanningContext(context: PlanningContextProjection | undefined): string {
  if (!context?.relations.length) return '';
  const lines = ['', bold(`Related planning context`), `  snapshot: ${context.snapshotHash}`];
  for (const relation of context.relations) {
    const authority = relation.schedulerAuthority ? 'scheduler authority' : 'context only';
    lines.push(
      `    - ${cyan(relation.label)} ${relation.direction} ${relation.targetRef ?? relation.targetId}${relation.targetStatus ? ` (${relation.targetStatus})` : ''} [${authority}]${relation.specPath ? ` ${dim(relation.specPath)}` : ''}`,
    );
  }
  return `${lines.join('\n')}\n`;
}

function parseCsv(value: string | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  return value
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
}

function parseStage(value: string | undefined): RoadmapItemStage | undefined {
  if (!value) return undefined;
  if (!(ROADMAP_ITEM_STAGES as readonly string[]).includes(value)) {
    throw Object.assign(new Error(`Invalid stage '${value}'.`), {
      code: 'ROADMAP_STAGE_INVALID',
      userAction: `Use one of: ${ROADMAP_ITEM_STAGES.join(', ')}.`,
    });
  }
  return value as RoadmapItemStage;
}

/** CLI must not fake gateway promotion or silently demote promoted items. */
function assertStageTransition(
  existing: RoadmapItem | undefined,
  next: RoadmapItemStage | undefined,
): void {
  if (!next) return;
  if (next === 'promoted') {
    throw Object.assign(
      new Error('Cannot set stage to promoted via save/set-stage; use `farmslot roadmap promote`.'),
      {
        code: 'ROADMAP_STAGE_PROMOTE_REQUIRED',
        userAction:
          'Run `farmslot roadmap promote <id>` (defaults to promotion drafts) after the item is refined.',
      },
    );
  }
  // After the promoted-target guard above, any stage change on a promoted item is a demotion.
  if (existing?.stage === 'promoted') {
    throw Object.assign(
      new Error('Cannot demote a promoted roadmap item via CLI save/set-stage.'),
      {
        code: 'ROADMAP_STAGE_PROMOTED_LOCKED',
        userAction:
          'Promoted items keep their backlog linkage. Open Command Center if archive/park is required, or leave stage as promoted.',
      },
    );
  }
}

async function loadBody(opts: { body?: string; bodyFile?: string }): Promise<string | undefined> {
  if (opts.bodyFile) {
    return readFile(resolve(opts.bodyFile), 'utf8');
  }
  return opts.body;
}

function parseSpecsJson(raw: string): RoadmapPromoteSpecInput[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw Object.assign(new Error('Invalid --specs-json: not valid JSON.'), {
      code: 'ROADMAP_SPECS_JSON_INVALID',
      userAction:
        'Pass a JSON array of {title, body, project?} objects, or use --from-drafts to load promotion drafts.',
    });
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw Object.assign(new Error('--specs-json must be a non-empty JSON array.'), {
      code: 'ROADMAP_SPECS_JSON_INVALID',
      userAction: 'Provide at least one backlog spec object with title and body.',
    });
  }
  return parsed.map((entry, index) => {
    if (!entry || typeof entry !== 'object') {
      throw Object.assign(new Error(`--specs-json[${index}] must be an object.`), {
        code: 'ROADMAP_SPECS_JSON_INVALID',
        userAction: 'Each spec needs title and body strings.',
      });
    }
    const spec = entry as Record<string, unknown>;
    if (typeof spec.title !== 'string' || !spec.title.trim()) {
      throw Object.assign(new Error(`--specs-json[${index}].title is required.`), {
        code: 'ROADMAP_SPECS_JSON_INVALID',
        userAction: 'Each spec needs a non-empty title.',
      });
    }
    if (typeof spec.body !== 'string' || !spec.body.trim()) {
      throw Object.assign(new Error(`--specs-json[${index}].body is required.`), {
        code: 'ROADMAP_SPECS_JSON_INVALID',
        userAction: 'Each spec needs a non-empty body with ## Acceptance Criteria.',
      });
    }
    return {
      title: spec.title,
      body: spec.body,
      ...(typeof spec.project === 'string' ? { project: spec.project } : {}),
      ...(typeof spec.flowType === 'string'
        ? { flowType: spec.flowType as RoadmapPromoteSpecInput['flowType'] }
        : {}),
      ...(Array.isArray(spec.tags)
        ? { tags: spec.tags.filter((t): t is string => typeof t === 'string') }
        : {}),
      ...(typeof spec.priority === 'number' ? { priority: spec.priority } : {}),
      ...(typeof spec.autoDispatch === 'boolean' ? { autoDispatch: spec.autoDispatch } : {}),
    };
  });
}

async function loadSpecsFromDrafts(
  ctx: CommandContext,
  itemId: string,
): Promise<RoadmapPromoteSpecInput[]> {
  const listed = await ctx.client.call<RoadmapPromotionDraftListResult>(
    'roadmap.promotionDraft.list',
    {
      itemId,
    },
  );
  if (listed.drafts.length === 0) {
    throw Object.assign(new Error(`No promotion drafts found for ${itemId}.`), {
      code: 'ROADMAP_PROMOTION_DRAFTS_EMPTY',
      userAction:
        'Create drafts in Command Center or pass --specs-json with explicit backlog specs.',
    });
  }
  const specs: RoadmapPromoteSpecInput[] = [];
  for (const draft of listed.drafts) {
    const full = await ctx.client.call<RoadmapPromotionDraftGetResult>(
      'roadmap.promotionDraft.get',
      {
        path: draft.path,
      },
    );
    const parsed = parsePromotionDraftAttachment(full.path, full.content);
    specs.push({
      title: parsed.title || draft.filename,
      body: parsed.body,
      ...(parsed.project ? { project: parsed.project } : {}),
    });
  }
  return specs;
}

export function registerRoadmapCommand(program: Command): void {
  const roadmap = program.command('roadmap').description('Roadmap planning (gateway RPC)');

  roadmap
    .command('list')
    .description('List roadmap items (id, status/stage, title)')
    .option('--project <name>', 'Filter by project or target project')
    .option('--stage <stage>', `Filter by stage (${ROADMAP_ITEM_STAGES.join('|')})`)
    .option('--status <stage>', 'Alias for --stage (status ≡ stage)')
    .option(
      '--tag <tag>',
      'Require tag (repeatable)',
      (value: string, prev: string[]) => {
        prev.push(value);
        return prev;
      },
      [] as string[],
    )
    .option('--search <text>', 'Search title/body/tags')
    .option('--include-archived', 'Include archived items')
    .action(
      async (
        opts: {
          project?: string;
          stage?: string;
          status?: string;
          tag?: string[];
          search?: string;
          includeArchived?: boolean;
        },
        cmd: Command,
      ) => {
        const ctx = resolveContext(cmd);
        const emit = createEmitter(ctx.output, cmd);
        try {
          const stage = parseStage(opts.stage ?? opts.status);
          const result = await withProgress(
            'Loading roadmap',
            () =>
              ctx.client.call<RoadmapListResult>('roadmap.list', {
                ...(opts.project ? { project: opts.project } : {}),
                ...(stage ? { stage } : {}),
                ...(opts.tag && opts.tag.length > 0 ? { tags: opts.tag } : {}),
                ...(opts.search ? { search: opts.search } : {}),
                ...(opts.includeArchived ? { includeArchived: true } : {}),
              }),
            !emit.machine,
          );
          if (emit.machine) {
            // Surface status as stage for machine consumers matching AC wording.
            emit.ok({
              ...result,
              items: result.items.map((item) => ({ ...item, status: item.stage })),
            });
          } else {
            ctx.output.write(`${renderItems(result.items)}\n`);
          }
        } catch (err) {
          emit.fail(err);
        }
      },
    );

  roadmap
    .command('get <id>')
    .description('Show one roadmap item with its delivery lineage')
    .action(async (id: string, _opts: unknown, cmd: Command) => {
      const ctx = resolveContext(cmd);
      const emit = createEmitter(ctx.output, cmd);
      try {
        const result = await withProgress(
          `Loading ${id}`,
          () => resolveRoadmapGetResult(ctx, id),
          !emit.machine,
        );
        const item = result.item;
        if (emit.machine) {
          // The gateway projection is passed through unchanged: no client-side
          // re-derivation, so machine consumers and the UI read one shape.
          emit.ok({
            item: { ...item, status: item.stage },
            ...(result.delivery ? { delivery: result.delivery } : {}),
            ...(result.planningContext ? { planningContext: result.planningContext } : {}),
          });
        } else {
          ctx.output.write(`${bold(item.id)}  ${item.stage}\n`);
          ctx.output.write(`${item.title}\n`);
          ctx.output.write(`${dim(`project: ${item.project}`)}\n`);
          if (item.tags?.length) ctx.output.write(`${dim(`tags: ${item.tags.join(', ')}`)}\n`);
          ctx.output.write(`${dim(`file: ${item.filePath}`)}\n`);
          ctx.output.write(renderDeliveryLineage(result.delivery));
          ctx.output.write(renderPlanningContext(result.planningContext));
          if (item.body) ctx.output.write(`\n${item.body}\n`);
        }
      } catch (err) {
        emit.fail(err);
      }
    });

  roadmap
    .command('save')
    .description('Create or update a roadmap item (gateway roadmap.save)')
    .argument('[id]', 'Existing item id (optional; same as --id)')
    .option('--id <id>', 'Existing item id (required for updates; omit to create)')
    .option('--project <name>', 'Project (required on create)')
    .option('--title <title>', 'Title (required on create)')
    .option('--stage <stage>', `Stage (${ROADMAP_ITEM_STAGES.join('|')})`)
    .option('--status <stage>', 'Alias for --stage')
    .option('--tags <csv>', 'Comma-separated tags')
    .option('--target-projects <csv>', 'Comma-separated target projects')
    .option('--body <text>', 'Markdown body')
    .option('--body-file <path>', 'Read body from file')
    .option('--expected-hash <hash>', 'Optimistic concurrency hash (defaults to current fileHash)')
    .action(
      async (
        positionalId: string | undefined,
        opts: {
          id?: string;
          project?: string;
          title?: string;
          stage?: string;
          status?: string;
          tags?: string;
          targetProjects?: string;
          body?: string;
          bodyFile?: string;
          expectedHash?: string;
        },
        cmd: Command,
      ) => {
        const ctx = resolveContext(cmd);
        const emit = createEmitter(ctx.output, cmd);
        const itemRef = (opts.id ?? positionalId)?.trim() || undefined;
        try {
          const result = await withProgress(
            itemRef ? `Saving ${itemRef}` : 'Creating roadmap item',
            async () => {
              const stage = parseStage(opts.stage ?? opts.status);
              const body = await loadBody(opts);
              const tags = parseCsv(opts.tags);
              const targetProjects = parseCsv(opts.targetProjects);

              let existing: RoadmapItem | undefined;
              if (itemRef) {
                existing = await resolveRoadmapItem(ctx, itemRef);
              }
              assertStageTransition(existing, stage);

              const title = opts.title ?? existing?.title;
              if (!title?.trim()) {
                throw Object.assign(
                  new Error('roadmap save requires --title (or an existing --id).'),
                  {
                    code: 'ROADMAP_SAVE_TITLE_REQUIRED',
                    userAction: 'Pass --title, or --id of an existing item to update.',
                  },
                );
              }
              const project = opts.project ?? existing?.project;
              if (!existing && !project?.trim()) {
                throw Object.assign(new Error('roadmap save create requires --project.'), {
                  code: 'ROADMAP_SAVE_PROJECT_REQUIRED',
                  userAction: 'Pass --project when creating a new roadmap item.',
                });
              }

              const item: RoadmapItemSaveInput = {
                title,
                ...(existing ? { id: existing.id, fileHash: existing.fileHash } : {}),
                ...(project ? { project } : {}),
                ...(stage ? { stage } : existing ? { stage: existing.stage } : {}),
                ...(tags ? { tags } : existing?.tags ? { tags: existing.tags } : {}),
                ...(targetProjects
                  ? { targetProjects }
                  : existing?.targetProjects
                    ? { targetProjects: existing.targetProjects }
                    : {}),
                ...(body !== undefined
                  ? { body }
                  : existing
                    ? { body: existing.body }
                    : { body: '' }),
                ...(existing?.source
                  ? { source: existing.source }
                  : { source: { kind: 'manual' } }),
                ...(existing?.promotion ? { promotion: existing.promotion } : {}),
              };

              return ctx.client.call<RoadmapSaveResult>('roadmap.save', {
                item,
                ...(opts.expectedHash
                  ? { expectedHash: opts.expectedHash }
                  : existing
                    ? { expectedHash: existing.fileHash }
                    : {}),
              });
            },
            !emit.machine,
          );
          if (emit.machine) emit.ok({ item: { ...result.item, status: result.item.stage } });
          else
            ctx.output.write(
              `${green(itemRef ? 'Saved' : 'Created')} ${cyan(result.item.id)}  ${result.item.stage}  ${result.item.title}\n`,
            );
        } catch (err) {
          emit.fail(err);
        }
      },
    );

  roadmap
    .command('set-stage <id> <stage>')
    .description('Update only the stage/status of a roadmap item')
    .option('--expected-hash <hash>', 'Optimistic concurrency hash')
    .action(async (id: string, stageRaw: string, opts: { expectedHash?: string }, cmd: Command) => {
      const ctx = resolveContext(cmd);
      const emit = createEmitter(ctx.output, cmd);
      try {
        const result = await withProgress(
          `Setting stage for ${id}`,
          async () => {
            const existing = await resolveRoadmapItem(ctx, id);
            const stage = parseStage(stageRaw);
            if (!stage) {
              throw Object.assign(new Error('stage is required'), {
                code: 'ROADMAP_STAGE_INVALID',
                userAction: `Use one of: ${ROADMAP_ITEM_STAGES.join(', ')}.`,
              });
            }
            assertStageTransition(existing, stage);
            return ctx.client.call<RoadmapSaveResult>('roadmap.save', {
              item: {
                id: existing.id,
                title: existing.title,
                project: existing.project,
                stage,
                tags: existing.tags,
                targetProjects: existing.targetProjects,
                body: existing.body,
                source: existing.source,
                promotion: existing.promotion,
                fileHash: existing.fileHash,
              },
              expectedHash: opts.expectedHash ?? existing.fileHash,
            });
          },
          !emit.machine,
        );
        if (emit.machine) emit.ok({ item: { ...result.item, status: result.item.stage } });
        else ctx.output.write(`${green('Stage')} ${cyan(result.item.id)} → ${result.item.stage}\n`);
      } catch (err) {
        emit.fail(err);
      }
    });

  roadmap
    .command('delete <id>')
    .description('Delete an unpromoted roadmap item')
    .option('--expected-hash <hash>', 'Optimistic concurrency hash')
    .action(async (id: string, opts: { expectedHash?: string }, cmd: Command) => {
      const ctx = resolveContext(cmd);
      const emit = createEmitter(ctx.output, cmd);
      try {
        const result = await withProgress(
          `Deleting ${id}`,
          async () => {
            const item = await resolveRoadmapItem(ctx, id);
            return ctx.client.call<RoadmapDeleteResult>('roadmap.delete', {
              itemId: item.id,
              ...(opts.expectedHash
                ? { expectedHash: opts.expectedHash }
                : { expectedHash: item.fileHash }),
            });
          },
          !emit.machine,
        );
        if (emit.machine) emit.ok(result);
        else ctx.output.write(`${green('Deleted')} ${cyan(id)}\n`);
      } catch (err) {
        emit.fail(err);
      }
    });

  roadmap
    .command('refine <id>')
    .description('Prepare (and optionally launch) a refinement session')
    .option('--runner <name>', 'Runner override')
    .option('--model <name>', 'Model override')
    .option('--runner-command <template>', 'Shell command template for refinement')
    .option('--launch', 'Create or attach the tmux refinement session')
    .option('--no-mark-refining', 'Do not move the item into refining stage')
    .option('--expected-hash <hash>', 'Optimistic concurrency hash')
    .action(
      async (
        id: string,
        opts: {
          runner?: string;
          model?: string;
          runnerCommand?: string;
          launch?: boolean;
          markRefining?: boolean;
          expectedHash?: string;
        },
        cmd: Command,
      ) => {
        const ctx = resolveContext(cmd);
        const emit = createEmitter(ctx.output, cmd);
        try {
          const result = await withProgress(
            `Refining ${id}`,
            async () => {
              const item = await resolveRoadmapItem(ctx, id);
              return ctx.client.call<RoadmapRefineResult>('roadmap.refine', {
                itemId: item.id,
                ...(opts.expectedHash
                  ? { expectedHash: opts.expectedHash }
                  : { expectedHash: item.fileHash }),
                ...(opts.runner ? { runner: opts.runner } : {}),
                ...(opts.model ? { model: opts.model } : {}),
                ...(opts.runnerCommand ? { runnerCommand: opts.runnerCommand } : {}),
                ...(opts.launch ? { launch: true } : {}),
                ...(opts.markRefining === false ? { markRefining: false } : {}),
              });
            },
            !emit.machine,
          );
          if (emit.machine) emit.ok(result);
          else {
            ctx.output.write(
              `${green(result.launched ? 'Launched' : 'Prepared')} refinement for ${cyan(result.item.id)}\n`,
            );
            ctx.output.write(`${dim(`prompt: ${result.promptPath}`)}\n`);
            ctx.output.write(`${dim(`attach: ${result.attachCommand}`)}\n`);
          }
        } catch (err) {
          emit.fail(err);
        }
      },
    );

  roadmap
    .command('refinement-session <id>')
    .description('Show refinement tmux session status for an item')
    .action(async (id: string, _opts: unknown, cmd: Command) => {
      const ctx = resolveContext(cmd);
      const emit = createEmitter(ctx.output, cmd);
      try {
        const result = await withProgress(
          `Refinement session ${id}`,
          async () => {
            const item = await resolveRoadmapItem(ctx, id);
            return ctx.client.call<RoadmapRefinementSessionGetResult>(
              'roadmap.refinementSession.get',
              { itemId: item.id },
            );
          },
          !emit.machine,
        );
        if (emit.machine) emit.ok(result);
        else {
          ctx.output.write(
            `${result.exists ? green('running') : yellow('absent')}  ${result.tmuxSession}\n`,
          );
          ctx.output.write(`${dim(result.attachCommand)}\n`);
        }
      } catch (err) {
        emit.fail(err);
      }
    });

  roadmap
    .command('prompt-get <path>')
    .description('Read a refinement prompt file by repo-relative path')
    .action(async (promptPath: string, _opts: unknown, cmd: Command) => {
      const ctx = resolveContext(cmd);
      const emit = createEmitter(ctx.output, cmd);
      try {
        const result = await withProgress(
          'Loading prompt',
          () => ctx.client.call<RoadmapPromptGetResult>('roadmap.prompt.get', { path: promptPath }),
          !emit.machine,
        );
        if (emit.machine) emit.ok(result);
        else {
          ctx.output.write(`${dim(result.path)}\n\n`);
          ctx.output.write(`${result.content}\n`);
        }
      } catch (err) {
        emit.fail(err);
      }
    });

  const drafts = roadmap
    .command('promotion-draft')
    .description('Promotion draft attachments for a refined roadmap item');

  drafts
    .command('list <id>')
    .description('List promotion draft files for an item')
    .action(async (id: string, _opts: unknown, cmd: Command) => {
      const ctx = resolveContext(cmd);
      const emit = createEmitter(ctx.output, cmd);
      try {
        const result = await withProgress(
          `Drafts for ${id}`,
          async () => {
            const item = await resolveRoadmapItem(ctx, id);
            return ctx.client.call<RoadmapPromotionDraftListResult>('roadmap.promotionDraft.list', {
              itemId: item.id,
            });
          },
          !emit.machine,
        );
        if (emit.machine) emit.ok(result);
        else if (result.drafts.length === 0) ctx.output.write(`${dim('no drafts')}\n`);
        else {
          for (const draft of result.drafts) {
            ctx.output.write(`${cyan(draft.filename)}  ${dim(draft.path)}\n`);
          }
        }
      } catch (err) {
        emit.fail(err);
      }
    });

  drafts
    .command('get <path>')
    .description('Read one promotion draft by repo-relative path')
    .action(async (draftPath: string, _opts: unknown, cmd: Command) => {
      const ctx = resolveContext(cmd);
      const emit = createEmitter(ctx.output, cmd);
      try {
        const result = await withProgress(
          'Loading draft',
          () =>
            ctx.client.call<RoadmapPromotionDraftGetResult>('roadmap.promotionDraft.get', {
              path: draftPath,
            }),
          !emit.machine,
        );
        if (emit.machine) emit.ok(result);
        else {
          ctx.output.write(`${dim(result.path)}\n\n`);
          ctx.output.write(`${result.content}\n`);
        }
      } catch (err) {
        emit.fail(err);
      }
    });

  drafts
    .command('save <path>')
    .description('Write promotion draft content')
    .option('--content <text>', 'Draft markdown content')
    .option('--content-file <path>', 'Read content from file')
    .option('--expected-hash <hash>', 'Optimistic concurrency hash')
    .action(
      async (
        draftPath: string,
        opts: { content?: string; contentFile?: string; expectedHash?: string },
        cmd: Command,
      ) => {
        const ctx = resolveContext(cmd);
        const emit = createEmitter(ctx.output, cmd);
        try {
          const result = await withProgress(
            'Saving draft',
            async () => {
              let content = opts.content;
              if (opts.contentFile) content = await readFile(resolve(opts.contentFile), 'utf8');
              if (content === undefined) {
                throw Object.assign(
                  new Error('promotion-draft save requires --content or --content-file.'),
                  {
                    code: 'ROADMAP_DRAFT_CONTENT_REQUIRED',
                    userAction: 'Pass --content or --content-file with the draft markdown.',
                  },
                );
              }
              return ctx.client.call<RoadmapPromotionDraftSaveResult>(
                'roadmap.promotionDraft.save',
                {
                  path: draftPath,
                  content,
                  ...(opts.expectedHash ? { expectedHash: opts.expectedHash } : {}),
                },
              );
            },
            !emit.machine,
          );
          if (emit.machine) emit.ok(result);
          else ctx.output.write(`${green('Saved')} ${cyan(result.path)}\n`);
        } catch (err) {
          emit.fail(err);
        }
      },
    );

  roadmap
    .command('promote <id>')
    .description('Promote a refined roadmap item into backlog specs')
    .option('--specs-json <json>', 'JSON array of {title, body, project?} backlog specs')
    .option('--from-drafts', 'Load specs from promotion drafts (default when --specs-json omitted)')
    .option('--expected-hash <hash>', 'Optimistic concurrency hash')
    .action(
      async (
        id: string,
        opts: { specsJson?: string; fromDrafts?: boolean; expectedHash?: string },
        cmd: Command,
      ) => {
        const ctx = resolveContext(cmd);
        const emit = createEmitter(ctx.output, cmd);
        try {
          const result = await withProgress(
            `Promoting ${id}`,
            async () => {
              const item = await resolveRoadmapItem(ctx, id);
              let specs: RoadmapPromoteSpecInput[];
              if (opts.specsJson) {
                specs = parseSpecsJson(opts.specsJson);
              } else {
                // Default: load promotion drafts (same operator path as Command Center).
                specs = await loadSpecsFromDrafts(ctx, item.id);
              }
              return ctx.client.call<RoadmapPromoteResult>('roadmap.promote', {
                itemId: item.id,
                specs,
                ...(opts.expectedHash
                  ? { expectedHash: opts.expectedHash }
                  : { expectedHash: item.fileHash }),
              });
            },
            !emit.machine,
          );
          if (emit.machine) emit.ok(result);
          else {
            ctx.output.write(
              `${green('Promoted')} ${cyan(result.roadmapItem.id)} → ${result.backlogItems.length} backlog item(s)\n`,
            );
            for (const path of result.specPaths) ctx.output.write(`  ${dim(path)}\n`);
          }
        } catch (err) {
          emit.fail(err);
        }
      },
    );

  // File-backed human decision helper (local, not a gateway method).
  roadmap
    .command('request-promotion')
    .description('Create a human decision to promote a refined roadmap item into backlog specs')
    .requiredOption('--item-id <id>', 'Roadmap item id')
    .option('--item-file <path>', 'Roadmap item markdown path')
    .option('--title <title>', 'Roadmap item title')
    .option('--target-projects <projects>', 'Comma-separated target projects')
    .option('--roadmap-route <hash>', 'Command Center roadmap hash route')
    .action(async (opts: RequestPromotionOptions, cmd: Command) => {
      const ctx = resolveContext(cmd);
      const emit = createEmitter(ctx.output, cmd);
      try {
        const result = await withProgress(
          'Creating promotion request',
          () =>
            createRoadmapPromotionRequest(resolve(process.env.FARMSLOT_ROOT || repoRoot), {
              itemId: opts.itemId ?? '',
              itemFile: opts.itemFile,
              title: opts.title,
              targetProjects: opts.targetProjects,
              roadmapRoute: opts.roadmapRoute,
            }),
          !emit.machine,
        );
        if (emit.machine) emit.ok(result);
        else ctx.output.write(`Created roadmap promotion request: ${result.decisionPath}\n`);
      } catch (err) {
        emit.fail(err);
      }
    });
}
