import { writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { Run } from '@farmslot/protocol';

export const QA_INPUT = 'inputs/qa.json';

/** The skill consumes the admitted profile and inputs, never the current farm defaults. */
export async function writeQaInput(taskDir: string, run: Run): Promise<void> {
  if (run.flowType !== 'qa') return;
  if (!run.qa || !run.executionTemplate) {
    throw new Error('QA task requires an admitted profile and execution-template snapshot');
  }
  await writeFile(
    path.join(taskDir, QA_INPUT),
    JSON.stringify(
      {
        version: 1,
        runId: run.id,
        project: run.project,
        sourceRef: run.ticketOrPr,
        ...(run.qaSource ? { source: run.qaSource } : {}),
        parentRunId: run.parentRunId,
        profile: run.qa.profile,
        inputs: run.qa.inputs,
        executionTemplate: run.executionTemplate,
      },
      null,
      2,
    ) + '\n',
    { flag: 'wx' },
  );
}

export function buildQaTaskSection(taskDir: string, run: Run): string {
  if (run.flowType !== 'qa') return '';
  return `
## QA inputs

Read \`${taskDir}/${QA_INPUT}\` for the admitted farm profile, inputs and source reference.
Use the selected skill to resolve the change scope into immutable revisions and a recipe plan.
Retain the resolved scope, recipe digests, coverage and gaps with the execution evidence.
Execute the skill's runtime smoke and validation recipes. Launch or health checks alone do not
prove QA. Missing runtime, failed smoke or uncovered changes cannot produce passing QA.

Write \`artifacts/qa-result.json\` with \`version: 1\`, this \`runId\`,
\`qa: { profile, inputs }\` copied from the input, resolved \`source: { baseSha, headSha }\`,
\`suitePath\` relative to artifacts, \`packages\` mapping case IDs to complete package directories
relative to artifacts, and \`smoke: { caseId, proofTarget }\` naming the executed smoke.
Also retain the skill-resolved change scope as an artifact with its \`baseSha\` and \`headSha\`.
Include \`scope: { path, digest, suiteDigest }\`: the scope artifact path relative to artifacts,
its canonical JSON digest and the canonical JSON digest of the declared suite-scope document.
Use the installed protocol's \`digestRecipeDocument\` helper for both \`sha256:...\` values.
The suite uses standard \`suite-scope.json\` and \`suite-result.json\` files and complete Recipe v1
artifact packages. Every declared case must pass with executed behavioral assertions.
Bind each root proof target to a portable \`assert_output\`, \`assert_json\`, or interactive
\`ui.wait_for\` node. For structured domain results, use \`assert_output\` with \`source\` and
\`assert.path\`/\`operator\`/\`value\`; \`contains\` and \`match\` inspect stdout/stderr strings.
`;
}
