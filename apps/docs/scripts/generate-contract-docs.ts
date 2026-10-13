import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { format, resolveConfig } from 'prettier';
import ts from 'typescript';

import {
  ACTIVE_RUN_STATUSES,
  FLOW_STEPS,
  PipelineSteps,
  TERMINAL_RUN_STATUSES,
} from '../../../packages/protocol/src/contracts/runs.js';

async function main(): Promise<void> {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
  const repository = 'https://github.com/deeeed/farmslot/blob/main/';
  const formatting = await resolveConfig(path.join(root, '.prettierrc'));
  const references = [
    'agent-runtime',
    'recipe-composition-quality',
    'recipe-concepts',
    'recipe-protocol-v1',
    'recipe-runner-protocol',
    'review-modes-warm-cold',
    'task-directory-contract',
  ];

  async function output(relative: string, content: string): Promise<void> {
    const file = path.join(root, relative);
    const formatted = await format(content, { ...formatting, filepath: file });
    if (process.argv.includes('--check')) {
      if (readFileSync(file, 'utf8') !== formatted)
        throw new Error(`Stale generated page: ${relative}`);
    } else writeFileSync(file, formatted);
  }

  for (const name of references) {
    const source = `docs/reference/${name}.md`;
    const text = readFileSync(path.join(root, source), 'utf8');
    const heading = /^# (.+)\n/.exec(text);
    if (!heading) throw new Error(`Missing title: ${source}`);
    const body = text
      .slice(heading[0].length)
      .replace(/\]\(([^\s)]+)\)/g, (link, target: string) => {
        if (/^(?:[a-z]+:|#|\/)/i.test(target)) return link;
        const [file, anchor] = target.split('#');
        const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(source), file));
        if (resolved.startsWith('../')) throw new Error(`Link leaves repository: ${target}`);
        const suffix = anchor ? `#${anchor}` : '';
        if (
          resolved.startsWith('docs/reference/') &&
          references.includes(path.basename(file, '.md'))
        ) {
          return `](${path.basename(file)}${suffix})`;
        }
        return `](${repository}${resolved}${suffix})`;
      });
    await output(
      `apps/docs/docs/reference/${name}.md`,
      `---\n# GENERATED from ${source}; edit that source, then run generate:contracts.\ntitle: ${JSON.stringify(heading[1])}\n---\n${body}`,
    );
  }

  // RunStatus is a type-only export. Read its literal union from the owning source
  // rather than creating a second runtime vocabulary just for documentation.
  const runSource = 'packages/protocol/src/contracts/runs.ts';
  const source = ts.createSourceFile(
    runSource,
    readFileSync(path.join(root, runSource), 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
  const declaration = source.statements.find(
    (node): node is ts.TypeAliasDeclaration =>
      ts.isTypeAliasDeclaration(node) && node.name.text === 'RunStatus',
  );
  if (!declaration || !ts.isUnionTypeNode(declaration.type))
    throw new Error('Missing RunStatus union');
  const statuses = declaration.type.types.map((node) => {
    if (!ts.isLiteralTypeNode(node) || !ts.isStringLiteral(node.literal)) {
      throw new Error('RunStatus must contain string literals');
    }
    return node.literal.text;
  });
  const statusRows = statuses.map((status) => {
    const category = TERMINAL_RUN_STATUSES.some((value) => value === status)
      ? 'Terminal'
      : ACTIVE_RUN_STATUSES.some((value) => value === status)
        ? 'Active'
        : 'Waiting or requires action';
    return `| \`${status}\` | ${category} |`;
  });
  const flowRows = Object.entries(FLOW_STEPS).map(([flow, steps]) => {
    const publication = steps.includes(PipelineSteps.FINALIZE)
      ? 'Gateway finalize: publish or update PR'
      : 'Report or posted review; no new PR';
    return `| \`${flow}\` | ${steps.map((step) => `\`${step}\``).join(' → ')} | ${steps.includes(PipelineSteps.HUMAN_GATE) ? 'Yes' : 'No separate human-gate step'} | ${publication} |`;
  });
  await output(
    'apps/docs/docs/reference/run-states-and-gate.generated.md',
    `---
# GENERATED from ${runSource}; run generate:contracts, do not edit.
title: Run states and the gate
---

# Run states and the gate

The protocol owns the vocabulary and per-flow steps below. The gateway owns
transitions and prerequisite checks; clients display its state and reasons.
These tables list configured steps, not every possible transition or replay.
See [How Farmslot works](../concepts/operating-loop.md) for the operating loop.

## Run states

| State | Protocol category |
| --- | --- |
${statusRows.join('\n')}

An active category does not prove that a process is progressing. Uncertain
delivery requires reconciliation. A terminal state closes execution; \`done\`
does not guarantee successful validation. Read the retained outcome and evidence.
\`blocked\` is not terminal in this protocol: recovery may resume it. Gate,
pause and reviewer-failure states require their recorded reason and next action.

## Flows and publication

| Flow | Canonical steps, in order | Human gate in pipeline | Publication path |
| --- | --- | --- | --- |
${flowRows.join('\n')}

\`dev\` and \`fix-bug\` may create a PR. \`pr-complete\` and \`update-branch\`
operate on an existing PR. QA acknowledges a report, and review can post or
dismiss its retained review. Neither creates a new PR. Interactive development
can open its own draft PR; its operator-driven completion is an exception to the
autonomous flow table. Policy can add decisions inside steps, so absence of a
\`human-gate\` step is not permission to bypass approval or prerequisites.

## The approval boundary

Readiness checks compose the owning deterministic, review and evidence contracts.
Missing, failed, stale or invalid prerequisites prevent normal advancement.
Authorized evidence attestation can waive only the scoped claim-policy/binding
findings permitted by ADR-062; integrity failures and unrelated prerequisites
remain enforced. The gateway
rechecks at decision resolution and publication. Inspection and authorized
recovery remain separate actions while readiness is incomplete.

Approval binds the selected inventory and validation identity. It does not turn
report prose, a video file or a checked box into claim proof. Publication must
refuse changed approved bytes or selection. See the
[fail-closed lifecycle specification](${repository}docs/reference/fail-closed-run-lifecycle.md)
and [evidence specification](${repository}docs/reference/recorded-run-evidence.md).
`,
  );
}

void main();
