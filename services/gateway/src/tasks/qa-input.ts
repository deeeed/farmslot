import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { Run } from '@farmslot/protocol';

export const QA_INPUT = 'inputs/qa.json';

/** The skill consumes the admitted profile and inputs, never the current farm defaults. */
export async function writeQaInput(taskDir: string, run: Run): Promise<void> {
  if (run.flowType !== 'qa') return;
  if (!run.qa || !run.executionTemplate) {
    throw new Error('QA task requires an admitted profile and execution-template snapshot');
  }
  const file = path.join(taskDir, QA_INPUT);
  const text =
    JSON.stringify(
      {
        version: 1,
        ...(run.engineState?.evalExperiment?.blind?.proof
          ? { proof: run.engineState.evalExperiment.blind.proof }
          : {}),
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
    ) + '\n';
  try {
    await writeFile(file, text, { flag: 'wx' });
  } catch (error) {
    // A retried initialization writes the same admitted input again.
    if (
      (error as NodeJS.ErrnoException).code !== 'EEXIST' ||
      (await readFile(file, 'utf8')) !== text
    )
      throw error;
  }
}

export function buildQaTaskSection(taskDir: string, run: Run): string {
  if (run.flowType !== 'qa') return '';
  if (!run.qa) throw new Error('QA task requires an admitted profile');
  if (run.engineState?.evalExperiment?.blind?.proof)
    return `
## Proof-only eval

Read \`${taskDir}/${QA_INPUT}\` for the frozen QA profile, implementation base/head and exact ordered ACs.
The implementation is supplied and read-only, including Git. Write recipes, their run packages and your report only in this task's artifacts. Use prepared interfaces and the selected QA skill; do not fetch source or other tasks, edit product code, commit, push or publish.
Read the supplied base..head diff from the admitted source pair. Never seek a golden recipe or previous proof.
Run the task recipes against the unchanged implementation. Record actual failed, interrupted or unexecuted cases with their reasons in the standard suite documents. No retries are required to finish this measurement.
Retain the same qa-result.json scope, source, suite and package bindings described below. Missing output is measured as missing. Never claim unexecuted coverage or invent evidence.
After your first completed output, signal complete and stop. The engine freezes and judges it once; no worker repair follows.
${ordinaryQaTaskSection(taskDir, run)}`;
  return ordinaryQaTaskSection(taskDir, run);
}

function ordinaryQaTaskSection(taskDir: string, run: Run): string {
  if (!run.qa) throw new Error('QA task requires an admitted profile');
  const proof = Boolean(run.engineState?.evalExperiment?.blind?.proof);
  return `
## QA inputs

**QA profile:** ${run.qa.profile.title} (\`${run.qa.profile.id}\`)

Read \`${taskDir}/${QA_INPUT}\` for the admitted farm profile, inputs and source reference.
Use the selected skill to resolve the change scope into immutable revisions and a recipe plan.
Retain the resolved scope, recipe digests, coverage and gaps with the execution evidence.
${proof ? 'Execute the selected runtime smoke and validation recipes as a first-output measurement. Retain real failure and missing-case reasons; no all-pass or rerun requirement applies.' : "Execute the skill's runtime smoke and validation recipes. Launch or health checks alone do not prove QA. Missing runtime, failed smoke or uncovered changes cannot produce passing QA."}

Write \`artifacts/qa-result.json\` with \`version: 1\`, this \`runId\`,
\`qa: { profile, inputs }\` copied from the input, resolved \`source: { baseSha, headSha }\`,
\`suitePath\` relative to artifacts, \`packages\` mapping case IDs to complete package directories
relative to artifacts, and \`smoke: { caseId, proofTarget }\` naming the executed smoke.
Also retain the skill-resolved change scope as an artifact with its \`baseSha\` and \`headSha\`.
Include \`scope: { path, digest, suiteDigest }\`: the scope artifact path relative to artifacts,
its canonical JSON digest and the canonical JSON digest of the declared suite-scope document.
Use the installed protocol's \`digestRecipeDocument\` helper for both \`sha256:...\` values.
The suite uses standard \`suite-scope.json\` and \`suite-result.json\` files and complete Recipe v1
artifact packages. ${proof ? 'Every declared case retains its actual resolution, including failures or not_executed reasons.' : 'Every declared case must pass with executed behavioral assertions.'}
Bind each root proof target to a portable \`assert_output\`, \`assert_json\`, or interactive
\`ui.wait_for\` node. For structured domain results, use \`assert_output\` with \`source\` and
\`assert.path\`/\`operator\`/\`value\`; \`contains\` and \`match\` inspect stdout/stderr strings.
`;
}
