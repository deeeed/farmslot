// graph.ts — typed CLI for work-graph orchestration (gateway workGraph.*).
// Mirrors the gateway surface without raw `farmslot rpc` JSON for operator verbs.

import type { Command } from 'commander';

import type {
  EdgeCondition,
  NodeFailurePolicy,
  UnlockAction,
  WorkEdgeBlocks,
  WorkGraphCreateResult,
  WorkGraphGetResult,
  WorkGraphListResult,
  WorkGraphProjection,
  WorkGraphSource,
  WorkNodeKind,
  WorkReferenceKind,
  WorkReferenceStatus,
} from '@farmslot/protocol';

import { bold, cyan, dim, green, yellow } from '../colors.js';
import { resolveContext } from '../context.js';
import { createEmitter } from '../envelope.js';
import { withProgress } from '../progress.js';
import { TableRenderer } from '../table.js';

/** Verbs that must register as commander handlers (conformance gate). */
export const GRAPH_VERBS = [
  'list',
  'show',
  'create',
  'add-node',
  'add-edge',
  'remove-node',
  'remove-edge',
  'activate',
  'pause',
  'tick',
  'gate-resolve',
] as const;

export type GraphVerb = (typeof GRAPH_VERBS)[number];

/** Maps each CLI verb to the gateway RPC method it must call. */
export const GRAPH_VERB_METHODS: Record<GraphVerb, string> = {
  list: 'workGraph.list',
  show: 'workGraph.get',
  create: 'workGraph.create',
  'add-node': 'workGraph.addNode',
  'add-edge': 'workGraph.addEdge',
  'remove-node': 'workGraph.removeNode',
  'remove-edge': 'workGraph.removeEdge',
  activate: 'workGraph.activate',
  pause: 'workGraph.pause',
  tick: 'workGraph.schedulerTick',
  'gate-resolve': 'workGraph.gateResolve',
};

const FAILURE_POLICIES = ['halt', 'skip-dependents', 'isolate'] as const;
const EDGE_CONDITIONS = ['family-done', 'merged', 'manual', 'reference-status'] as const;
const UNLOCK_KINDS = ['enqueue', 'mark-ready', 'rebase-onto'] as const;
const REFERENCE_KINDS = [
  'jira',
  'github-pr',
  'github-issue',
  'package-release',
  'artifact',
  'manual',
  'url',
  'other',
] as const;
const REFERENCE_STATUSES = [
  'unknown',
  'pending',
  'blocked',
  'satisfied',
  'failed',
  'waived',
] as const;
const GATE_DECISIONS = ['approved', 'rejected', 'waived'] as const;

function parseCsv(value: string | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  return value
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
}

function teachPlanningError(err: unknown, graphId: string): never {
  const message = err instanceof Error ? err.message : String(err);
  if (/requires planning status/i.test(message)) {
    throw Object.assign(new Error(message), {
      code: 'WORK_GRAPH_NOT_PLANNING',
      userAction:
        `Node/edge structure can only change while the graph is planning. Finish the structure with \`farmslot graph add-node/add-edge\` before \`farmslot graph activate ${graphId}\`. ` +
        `\`farmslot graph pause ${graphId}\` stops scheduling but does not re-open planning edits — create a new graph if structure must change.`,
    });
  }
  throw err;
}

function renderGraphList(graphs: WorkGraphProjection[]): string {
  if (graphs.length === 0) return dim('no work graphs') + '\n';
  const table = new TableRenderer();
  table
    .addColumn('ID')
    .addColumn('STATUS')
    .addColumn('PROJECT', { shrinkable: true, minWidth: 8 })
    .addColumn('NODES')
    .addColumn('EDGES')
    .addColumn('TITLE', { shrinkable: true, minWidth: 16 });
  for (const projection of graphs) {
    const { graph, nodes, edges } = projection;
    const plain = [
      graph.id,
      graph.status,
      graph.project,
      String(nodes.length),
      String(edges.length),
      graph.title,
    ];
    const statusColor =
      graph.status === 'active' || graph.status === 'done'
        ? green(plain[1])
        : graph.status === 'planning'
          ? yellow(plain[1])
          : plain[1];
    table.addRow(plain, [cyan(plain[0]), statusColor, plain[2], plain[3], plain[4], plain[5]]);
  }
  return table.render();
}

function renderGraphDetail(projection: WorkGraphProjection): string {
  const { graph, nodes, edges, gates } = projection;
  const lines: string[] = [];
  lines.push(`${bold(graph.id)}  ${graph.status}`);
  lines.push(graph.title);
  lines.push(dim(`project: ${graph.project}`));
  if (graph.tags?.length) lines.push(dim(`tags: ${graph.tags.join(', ')}`));
  lines.push(dim(`nodes: ${nodes.length}  edges: ${edges.length}  gates: ${gates.length}`));
  if (nodes.length) {
    lines.push('');
    lines.push(bold('Nodes'));
    for (const node of nodes) {
      const label =
        node.kind === 'reference'
          ? `${node.reference?.kind ?? 'ref'}:${node.reference?.ref ?? ''}`
          : (node.backlogItemId ?? node.id);
      lines.push(`  ${cyan(node.id)}  ${yellow(node.status)}  ${node.kind}  ${label}`);
    }
  }
  if (edges.length) {
    lines.push('');
    lines.push(bold('Edges'));
    for (const edge of edges) {
      const cond =
        edge.condition.kind === 'manual'
          ? `manual:${edge.condition.gateId}`
          : edge.condition.kind === 'family-done' && edge.condition.outcome
            ? `family-done:${edge.condition.outcome}`
            : edge.condition.kind;
      lines.push(
        `  ${cyan(edge.id)}  ${edge.fromNodeId} → ${edge.toNodeId}  ${cond}  unlock=${edge.unlock.kind}  ${edge.status}`,
      );
    }
  }
  return `${lines.join('\n')}\n`;
}

function parseFailurePolicy(value: string | undefined): NodeFailurePolicy | undefined {
  if (!value) return undefined;
  if (!(FAILURE_POLICIES as readonly string[]).includes(value)) {
    throw Object.assign(new Error(`Invalid --default-failure-policy '${value}'.`), {
      code: 'WORK_GRAPH_FAILURE_POLICY_INVALID',
      userAction: `Use one of: ${FAILURE_POLICIES.join(', ')}.`,
    });
  }
  return value as NodeFailurePolicy;
}

function parseCondition(
  kind: string,
  opts: {
    conditionOutcome?: string;
    gateId?: string;
    targetRef?: string;
    referenceStatus?: string;
  },
): EdgeCondition {
  if (!(EDGE_CONDITIONS as readonly string[]).includes(kind)) {
    throw Object.assign(new Error(`Invalid --condition '${kind}'.`), {
      code: 'WORK_GRAPH_CONDITION_INVALID',
      userAction: `Use one of: ${EDGE_CONDITIONS.join(', ')}.`,
    });
  }
  if (kind === 'family-done') {
    const outcome = opts.conditionOutcome;
    if (outcome && outcome !== 'success' && outcome !== 'terminal') {
      throw Object.assign(new Error(`Invalid --condition-outcome '${outcome}'.`), {
        code: 'WORK_GRAPH_CONDITION_OUTCOME_INVALID',
        userAction: 'Use success or terminal with --condition family-done.',
      });
    }
    return outcome
      ? { kind: 'family-done', outcome: outcome as 'success' | 'terminal' }
      : { kind: 'family-done' };
  }
  if (kind === 'merged') {
    return opts.targetRef ? { kind: 'merged', targetRef: opts.targetRef } : { kind: 'merged' };
  }
  if (kind === 'manual') {
    const gateId = opts.gateId?.trim();
    if (!gateId) {
      throw Object.assign(new Error('--gate-id is required with --condition manual.'), {
        code: 'WORK_GRAPH_GATE_ID_REQUIRED',
        userAction: 'Pass --gate-id <id> (e.g. night-chain-go) for a manual edge condition.',
      });
    }
    return { kind: 'manual', gateId };
  }
  // reference-status
  const status = opts.referenceStatus as WorkReferenceStatus | undefined;
  if (status && !(REFERENCE_STATUSES as readonly string[]).includes(status)) {
    throw Object.assign(new Error(`Invalid --reference-status '${status}'.`), {
      code: 'WORK_GRAPH_REFERENCE_STATUS_INVALID',
      userAction: `Use one of: ${REFERENCE_STATUSES.join(', ')}.`,
    });
  }
  return status ? { kind: 'reference-status', status } : { kind: 'reference-status' };
}

function parseUnlock(kind: string | undefined, rebaseFlow?: string): UnlockAction | undefined {
  if (!kind) return undefined;
  if (!(UNLOCK_KINDS as readonly string[]).includes(kind)) {
    throw Object.assign(new Error(`Invalid --unlock '${kind}'.`), {
      code: 'WORK_GRAPH_UNLOCK_INVALID',
      userAction: `Use one of: ${UNLOCK_KINDS.join(', ')}.`,
    });
  }
  if (kind === 'rebase-onto') {
    const flow = rebaseFlow === 'pr-complete' ? 'pr-complete' : 'update-branch';
    if (rebaseFlow && rebaseFlow !== 'update-branch' && rebaseFlow !== 'pr-complete') {
      throw Object.assign(new Error(`Invalid --rebase-flow '${rebaseFlow}'.`), {
        code: 'WORK_GRAPH_REBASE_FLOW_INVALID',
        userAction: 'Use update-branch or pr-complete with --unlock rebase-onto.',
      });
    }
    return { kind: 'rebase-onto', flow };
  }
  return { kind: kind as 'enqueue' | 'mark-ready' };
}

export function registerGraphCommand(program: Command): void {
  const graph = program.command('graph').description('Work-graph orchestration (gateway RPC)');

  graph
    .command('list')
    .description('List work graphs (id, status, project, node/edge counts, title)')
    .option('--project <name>', 'Filter by project')
    .option('--status <status>', 'Filter by graph status')
    .option(
      '--tag <tag>',
      'Require tag (repeatable)',
      (value: string, prev: string[]) => {
        prev.push(value);
        return prev;
      },
      [] as string[],
    )
    .option('--include-archived', 'Include archived graphs')
    .action(
      async (
        opts: {
          project?: string;
          status?: string;
          tag?: string[];
          includeArchived?: boolean;
        },
        cmd: Command,
      ) => {
        const ctx = resolveContext(cmd);
        const emit = createEmitter(ctx.output, cmd);
        try {
          const result = await withProgress(
            'Loading work graphs',
            () =>
              ctx.client.call<WorkGraphListResult>('workGraph.list', {
                ...(opts.project ? { project: opts.project } : {}),
                ...(opts.status ? { status: opts.status } : {}),
                ...(opts.tag && opts.tag.length > 0 ? { tags: opts.tag } : {}),
                ...(opts.includeArchived ? { includeArchived: true } : {}),
              }),
            !emit.machine,
          );
          if (emit.machine) emit.ok(result);
          else ctx.output.write(`${renderGraphList(result.graphs)}\n`);
        } catch (err) {
          emit.fail(err);
        }
      },
    );

  graph
    .command('show <graphId>')
    .description('Show one work graph with nodes and edges')
    .action(async (graphId: string, _opts: unknown, cmd: Command) => {
      const ctx = resolveContext(cmd);
      const emit = createEmitter(ctx.output, cmd);
      try {
        const result = await withProgress(
          `Loading ${graphId}`,
          () => ctx.client.call<WorkGraphGetResult>('workGraph.get', { graphId }),
          !emit.machine,
        );
        if (emit.machine) emit.ok(result);
        else ctx.output.write(renderGraphDetail(result.graph));
      } catch (err) {
        emit.fail(err);
      }
    });

  graph
    .command('create')
    .description('Create a work graph in planning status')
    .requiredOption('--project <name>', 'Project owning the graph')
    .requiredOption('--title <title>', 'Graph title')
    .option('--id <id>', 'Explicit graph id (defaults to a generated wg_… id)')
    .option('--tags <csv>', 'Comma-separated tags')
    .option('--source-kind <kind>', 'Source kind (manual|external-import)', 'manual')
    .option('--source-ref <ref>', 'Optional source reference')
    .option('--source-url <url>', 'Optional source URL')
    .option(
      '--default-failure-policy <policy>',
      `Default node failure policy (${FAILURE_POLICIES.join('|')})`,
    )
    .action(
      async (
        opts: {
          project: string;
          title: string;
          id?: string;
          tags?: string;
          sourceKind?: string;
          sourceRef?: string;
          sourceUrl?: string;
          defaultFailurePolicy?: string;
        },
        cmd: Command,
      ) => {
        const ctx = resolveContext(cmd);
        const emit = createEmitter(ctx.output, cmd);
        try {
          const result = await withProgress(
            `Creating graph ${opts.title}`,
            async () => {
              const sourceKind =
                opts.sourceKind === 'external-import' ? 'external-import' : 'manual';
              if (
                opts.sourceKind &&
                opts.sourceKind !== 'manual' &&
                opts.sourceKind !== 'external-import'
              ) {
                throw Object.assign(new Error(`Invalid --source-kind '${opts.sourceKind}'.`), {
                  code: 'WORK_GRAPH_SOURCE_KIND_INVALID',
                  userAction: 'Use manual or external-import.',
                });
              }
              const source: WorkGraphSource = {
                kind: sourceKind,
                ...(opts.sourceRef ? { ref: opts.sourceRef } : {}),
                ...(opts.sourceUrl ? { url: opts.sourceUrl } : {}),
              };
              return ctx.client.call<WorkGraphCreateResult>('workGraph.create', {
                project: opts.project,
                title: opts.title,
                source,
                ...(opts.id ? { id: opts.id } : {}),
                ...(parseCsv(opts.tags) ? { tags: parseCsv(opts.tags) } : {}),
                ...(parseFailurePolicy(opts.defaultFailurePolicy)
                  ? { defaultFailurePolicy: parseFailurePolicy(opts.defaultFailurePolicy) }
                  : {}),
              });
            },
            !emit.machine,
          );
          if (emit.machine) emit.ok(result);
          else
            ctx.output.write(
              `${green('Created')} ${cyan(result.graph.graph.id)}  ${result.graph.graph.status}  ${result.graph.graph.title}\n`,
            );
        } catch (err) {
          emit.fail(err);
        }
      },
    );

  graph
    .command('add-node <graphId>')
    .description('Add a backlog or reference node (planning status only)')
    .option('--id <id>', 'Explicit node id (defaults to a generated wn_… id)')
    .option('--backlog-item <id>', 'Backlog item id (backlog node)')
    .option('--kind <kind>', 'Node kind (backlog|reference); inferred from flags when omitted')
    .option('--reference-kind <kind>', `Reference kind (${REFERENCE_KINDS.join('|')})`)
    .option('--reference-title <title>', 'Reference title')
    .option('--reference-ref <ref>', 'Reference external id/url/ref')
    .option(
      '--reference-status <status>',
      `Reference status (${REFERENCE_STATUSES.join('|')})`,
      'pending',
    )
    .option('--reference-url <url>', 'Optional reference URL')
    .option('--tags <csv>', 'Comma-separated tags')
    .option('--on-failure <policy>', `Node failure policy (${FAILURE_POLICIES.join('|')})`)
    .action(
      async (
        graphId: string,
        opts: {
          id?: string;
          backlogItem?: string;
          kind?: string;
          referenceKind?: string;
          referenceTitle?: string;
          referenceRef?: string;
          referenceStatus?: string;
          referenceUrl?: string;
          tags?: string;
          onFailure?: string;
        },
        cmd: Command,
      ) => {
        const ctx = resolveContext(cmd);
        const emit = createEmitter(ctx.output, cmd);
        try {
          const result = await withProgress(
            `Adding node on ${graphId}`,
            async () => {
              const hasReference =
                Boolean(opts.referenceKind) ||
                Boolean(opts.referenceTitle) ||
                Boolean(opts.referenceRef);
              let kind: WorkNodeKind | undefined =
                opts.kind === 'reference' || opts.kind === 'backlog' ? opts.kind : undefined;
              if (!kind) kind = hasReference ? 'reference' : 'backlog';

              if (kind === 'backlog') {
                if (!opts.backlogItem?.trim()) {
                  throw Object.assign(new Error('add-node backlog requires --backlog-item <id>.'), {
                    code: 'WORK_GRAPH_BACKLOG_ITEM_REQUIRED',
                    userAction:
                      'Pass --backlog-item <id> (from `farmslot backlog list`), or use reference flags for a non-backlog node.',
                  });
                }
                return ctx.client.call('workGraph.addNode', {
                  graphId,
                  kind: 'backlog',
                  backlogItemId: opts.backlogItem.trim(),
                  ...(opts.id ? { id: opts.id } : {}),
                  ...(parseCsv(opts.tags) ? { tags: parseCsv(opts.tags) } : {}),
                  ...(parseFailurePolicy(opts.onFailure)
                    ? { onFailure: parseFailurePolicy(opts.onFailure) }
                    : {}),
                });
              }

              const refKind = opts.referenceKind as WorkReferenceKind | undefined;
              if (!refKind || !(REFERENCE_KINDS as readonly string[]).includes(refKind)) {
                throw Object.assign(new Error('add-node reference requires --reference-kind.'), {
                  code: 'WORK_GRAPH_REFERENCE_KIND_REQUIRED',
                  userAction: `Pass --reference-kind (${REFERENCE_KINDS.join('|')}) with --reference-title and --reference-ref.`,
                });
              }
              if (!opts.referenceTitle?.trim() || !opts.referenceRef?.trim()) {
                throw Object.assign(
                  new Error('add-node reference requires --reference-title and --reference-ref.'),
                  {
                    code: 'WORK_GRAPH_REFERENCE_FIELDS_REQUIRED',
                    userAction:
                      'Pass --reference-title and --reference-ref (and optional --reference-status/--reference-url).',
                  },
                );
              }
              const refStatus = (opts.referenceStatus ?? 'pending') as WorkReferenceStatus;
              if (!(REFERENCE_STATUSES as readonly string[]).includes(refStatus)) {
                throw Object.assign(
                  new Error(`Invalid --reference-status '${opts.referenceStatus}'.`),
                  {
                    code: 'WORK_GRAPH_REFERENCE_STATUS_INVALID',
                    userAction: `Use one of: ${REFERENCE_STATUSES.join(', ')}.`,
                  },
                );
              }
              return ctx.client.call('workGraph.addNode', {
                graphId,
                kind: 'reference',
                reference: {
                  kind: refKind,
                  title: opts.referenceTitle.trim(),
                  ref: opts.referenceRef.trim(),
                  status: refStatus,
                  ...(opts.referenceUrl ? { url: opts.referenceUrl } : {}),
                },
                ...(opts.id ? { id: opts.id } : {}),
                ...(parseCsv(opts.tags) ? { tags: parseCsv(opts.tags) } : {}),
                ...(parseFailurePolicy(opts.onFailure)
                  ? { onFailure: parseFailurePolicy(opts.onFailure) }
                  : {}),
              });
            },
            !emit.machine,
          );
          if (emit.machine) emit.ok(result);
          else {
            const projection = (result as { graph: WorkGraphProjection }).graph;
            const node = projection.nodes[projection.nodes.length - 1];
            ctx.output.write(
              `${green('Added node')} ${cyan(node?.id ?? '?')} on ${projection.graph.id} (${projection.nodes.length} nodes)\n`,
            );
          }
        } catch (err) {
          try {
            teachPlanningError(err, graphId);
          } catch (enriched) {
            emit.fail(enriched);
          }
        }
      },
    );

  graph
    .command('add-edge <graphId>')
    .description('Add a directed edge with condition/unlock (planning status only)')
    .requiredOption('--from <nodeId>', 'From node id')
    .requiredOption('--to <nodeId>', 'To node id')
    .requiredOption('--condition <kind>', `Edge condition (${EDGE_CONDITIONS.join('|')})`)
    .option('--condition-outcome <outcome>', 'family-done outcome (success|terminal)')
    .option('--gate-id <id>', 'Manual gate id (required for --condition manual)')
    .option('--target-ref <ref>', 'merged condition target ref (e.g. main)')
    .option(
      '--reference-status <status>',
      `reference-status condition status (${REFERENCE_STATUSES.join('|')})`,
    )
    .option('--unlock <kind>', `Unlock action (${UNLOCK_KINDS.join('|')}); default enqueue`)
    .option('--rebase-flow <flow>', 'rebase-onto flow (update-branch|pr-complete)', 'update-branch')
    .option('--blocks <mode>', 'Edge blocks mode (start|completion)', 'start')
    .option('--required', 'Mark edge required (default)')
    .option('--optional', 'Mark edge not required')
    .option('--id <id>', 'Explicit edge id')
    .action(
      async (
        graphId: string,
        opts: {
          from: string;
          to: string;
          condition: string;
          conditionOutcome?: string;
          gateId?: string;
          targetRef?: string;
          referenceStatus?: string;
          unlock?: string;
          rebaseFlow?: string;
          blocks?: string;
          required?: boolean;
          optional?: boolean;
          id?: string;
        },
        cmd: Command,
      ) => {
        const ctx = resolveContext(cmd);
        const emit = createEmitter(ctx.output, cmd);
        try {
          const result = await withProgress(
            `Adding edge on ${graphId}`,
            async () => {
              const condition = parseCondition(opts.condition, opts);
              const unlock = parseUnlock(opts.unlock, opts.rebaseFlow);
              const blocks = (opts.blocks ?? 'start') as WorkEdgeBlocks;
              if (blocks !== 'start' && blocks !== 'completion') {
                throw Object.assign(new Error(`Invalid --blocks '${opts.blocks}'.`), {
                  code: 'WORK_GRAPH_BLOCKS_INVALID',
                  userAction: 'Use start or completion.',
                });
              }
              const required = opts.optional ? false : true;
              return ctx.client.call('workGraph.addEdge', {
                graphId,
                fromNodeId: opts.from,
                toNodeId: opts.to,
                condition,
                blocks,
                required,
                ...(unlock ? { unlock } : {}),
                ...(opts.id ? { id: opts.id } : {}),
              });
            },
            !emit.machine,
          );
          if (emit.machine) emit.ok(result);
          else {
            const projection = (result as { graph: WorkGraphProjection }).graph;
            const edge = projection.edges[projection.edges.length - 1];
            ctx.output.write(
              `${green('Added edge')} ${cyan(edge?.id ?? '?')}  ${opts.from} → ${opts.to} on ${projection.graph.id}\n`,
            );
          }
        } catch (err) {
          try {
            teachPlanningError(err, graphId);
          } catch (enriched) {
            emit.fail(enriched);
          }
        }
      },
    );

  graph
    .command('remove-node <graphId> <nodeId>')
    .description('Remove a node and its incident edges (planning status only)')
    .action(async (graphId: string, nodeId: string, _opts: unknown, cmd: Command) => {
      const ctx = resolveContext(cmd);
      const emit = createEmitter(ctx.output, cmd);
      try {
        const result = await withProgress(
          `Removing node ${nodeId}`,
          async () => {
            try {
              return await ctx.client.call('workGraph.removeNode', { graphId, nodeId });
            } catch (err) {
              teachPlanningError(err, graphId);
            }
          },
          !emit.machine,
        );
        if (emit.machine) emit.ok(result);
        else ctx.output.write(`${green('Removed node')} ${cyan(nodeId)} from ${graphId}\n`);
      } catch (err) {
        emit.fail(err);
      }
    });

  graph
    .command('remove-edge <graphId> <edgeId>')
    .description('Remove an edge (planning status only)')
    .action(async (graphId: string, edgeId: string, _opts: unknown, cmd: Command) => {
      const ctx = resolveContext(cmd);
      const emit = createEmitter(ctx.output, cmd);
      try {
        const result = await withProgress(
          `Removing edge ${edgeId}`,
          async () => {
            try {
              return await ctx.client.call('workGraph.removeEdge', { graphId, edgeId });
            } catch (err) {
              teachPlanningError(err, graphId);
            }
          },
          !emit.machine,
        );
        if (emit.machine) emit.ok(result);
        else ctx.output.write(`${green('Removed edge')} ${cyan(edgeId)} from ${graphId}\n`);
      } catch (err) {
        emit.fail(err);
      }
    });

  graph
    .command('activate <graphId>')
    .description('Activate a planning graph (cycle-checked; scheduler takes over)')
    .action(async (graphId: string, _opts: unknown, cmd: Command) => {
      const ctx = resolveContext(cmd);
      const emit = createEmitter(ctx.output, cmd);
      try {
        const result = await withProgress(
          `Activating ${graphId}`,
          () => ctx.client.call('workGraph.activate', { graphId }),
          !emit.machine,
        );
        if (emit.machine) emit.ok(result);
        else {
          const status = (result as { graph: WorkGraphProjection }).graph.graph.status;
          ctx.output.write(`${green('Activated')} ${cyan(graphId)}  status=${status}\n`);
        }
      } catch (err) {
        emit.fail(err);
      }
    });

  graph
    .command('pause <graphId>')
    .description('Pause an active graph (stops scheduling; does not re-open planning edits)')
    .action(async (graphId: string, _opts: unknown, cmd: Command) => {
      const ctx = resolveContext(cmd);
      const emit = createEmitter(ctx.output, cmd);
      try {
        const result = await withProgress(
          `Pausing ${graphId}`,
          () => ctx.client.call('workGraph.pause', { graphId }),
          !emit.machine,
        );
        if (emit.machine) emit.ok(result);
        else ctx.output.write(`${yellow('Paused')} ${cyan(graphId)}\n`);
      } catch (err) {
        emit.fail(err);
      }
    });

  graph
    .command('tick')
    .description(
      'Run workGraph.schedulerTick (optional graph id; force-enqueue for operator dispatch)',
    )
    .argument('[graphId]', 'Optional graph id (omit to tick all active/waiting graphs)')
    .option(
      '--force-enqueue',
      'Enqueue ready nodes even when linked backlog items have autoDispatch disabled',
    )
    .action(async (graphId: string | undefined, opts: { forceEnqueue?: boolean }, cmd: Command) => {
      const ctx = resolveContext(cmd);
      const emit = createEmitter(ctx.output, cmd);
      try {
        const result = await withProgress(
          graphId ? `Ticking ${graphId}` : 'Ticking work graphs',
          () =>
            ctx.client.call('workGraph.schedulerTick', {
              ...(graphId ? { graphId } : {}),
              ...(opts.forceEnqueue ? { forceEnqueue: true } : {}),
            }),
          !emit.machine,
        );
        if (emit.machine) emit.ok(result);
        else {
          const graphs = (result as { graphs?: WorkGraphProjection[] }).graphs ?? [];
          ctx.output.write(
            `${green('Tick')} ok  graphs=${graphs.length}${graphId ? `  target=${graphId}` : ''}\n`,
          );
        }
      } catch (err) {
        emit.fail(err);
      }
    });

  graph
    .command('gate-resolve')
    .description('Resolve a manual work-graph gate')
    .requiredOption('--gate-id <id>', 'Manual gate id')
    .requiredOption('--decision <decision>', `Decision (${GATE_DECISIONS.join('|')})`)
    .requiredOption('--reason <text>', 'Human reason for the resolution')
    .option('--graph-id <id>', 'Disambiguate when the gate id appears on multiple graphs')
    .option('--edge-id <id>', 'Disambiguate by edge id')
    .option('--node-id <id>', 'Disambiguate by destination node id')
    .action(
      async (
        opts: {
          gateId: string;
          decision: string;
          reason: string;
          graphId?: string;
          edgeId?: string;
          nodeId?: string;
        },
        cmd: Command,
      ) => {
        const ctx = resolveContext(cmd);
        const emit = createEmitter(ctx.output, cmd);
        try {
          if (!(GATE_DECISIONS as readonly string[]).includes(opts.decision)) {
            throw Object.assign(new Error(`Invalid --decision '${opts.decision}'.`), {
              code: 'WORK_GRAPH_GATE_DECISION_INVALID',
              userAction: `Use one of: ${GATE_DECISIONS.join(', ')}.`,
            });
          }
          const result = await withProgress(
            `Resolving gate ${opts.gateId}`,
            () =>
              ctx.client.call('workGraph.gateResolve', {
                gateId: opts.gateId,
                decision: opts.decision as 'approved' | 'rejected' | 'waived',
                reason: opts.reason,
                ...(opts.graphId ? { graphId: opts.graphId } : {}),
                ...(opts.edgeId ? { edgeId: opts.edgeId } : {}),
                ...(opts.nodeId ? { nodeId: opts.nodeId } : {}),
              }),
            !emit.machine,
          );
          if (emit.machine) emit.ok(result);
          else
            ctx.output.write(
              `${green('Gate')} ${cyan(opts.gateId)}  ${opts.decision}  ${opts.reason}\n`,
            );
        } catch (err) {
          emit.fail(err);
        }
      },
    );
}
