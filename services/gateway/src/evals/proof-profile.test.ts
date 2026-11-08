import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  type EvalExperimentCreateParams,
  type EvalProofInput,
  isEvalProofInput,
} from '@farmslot/protocol';

import type { ResolvedEvalSource } from '../methods/eval/source-resolution.js';

import { sha256Text, unavailableDiff } from './package-store.js';
import {
  type ProofInputDependencies,
  proofSourceAnchors,
  resolveProofInput,
} from './proof-profile.js';

const baseSha = 'a'.repeat(40),
  headSha = 'b'.repeat(40),
  treeSha = 'c'.repeat(40);
const patch =
  'diff --git a/src/value.ts b/src/value.ts\nindex 1111111..2222222 100644\n--- a/src/value.ts\n+++ b/src/value.ts\n@@ -1 +1 @@\n-old\n+fixed\n';
const params: EvalExperimentCreateParams = {
  project: 'fixture',
  taskProfile: 'proof',
  source: { kind: 'merged-pr', ref: 'owner/repo#1' },
  objective: 'Observe supplied behavior',
  acceptanceCriteria: ['Behavior is observed', 'The source is unchanged'],
  qaProfileId: 'pr',
};
const source: ResolvedEvalSource = {
  source: { kind: 'merged-pr', repo: 'owner/repo', prNumber: 1, mergeCommitSha: headSha },
  referenceLabel: 'fixture',
  diff: unavailableDiff('fixture'),
  contextArtifacts: [],
  packageArtifacts: [],
  diffText: patch,
};
const qa: Pick<EvalProofInput, 'qa' | 'executionTemplate'> = {
  qa: { profile: { id: 'pr', title: 'PR QA', template_id: 'qa/default' }, inputs: { scope: 'pr' } },
  executionTemplate: {
    id: 'qa/default',
    sourceId: 'project:fixture',
    flow: 'qa',
    platforms: ['cli'],
    labels: [],
    relativePath: 'qa.md',
    sha256: 'd'.repeat(64),
  },
};
function dependencies(diff = patch): ProofInputDependencies {
  return {
    request: async (args) => {
      if (args[1].includes('/git/commits/'))
        return {
          stdout: JSON.stringify({
            sha: headSha,
            tree: { sha: treeSha },
            parents: [{ sha: baseSha }],
          }),
        };
      if (args.includes('Accept: application/vnd.github.diff')) return { stdout: diff };
      return { stdout: JSON.stringify({ merge_base_commit: { sha: baseSha } }) };
    },
    admitQa: async () => qa,
  };
}

test('proof admission freezes the actual QA range, exact AC set and admitted template', async () => {
  const result = await resolveProofInput(params, source, undefined, dependencies());
  assert.equal(result.proof.source.baseSha, baseSha);
  assert.equal(result.proof.source.headSha, headSha);
  assert.equal(result.proof.source.treeSha, treeSha);
  assert.equal(result.diffText, patch);
  assert.deepEqual(result.proof.acceptanceCriteria, params.acceptanceCriteria);
  assert.deepEqual(result.proof.qa, qa.qa);
  assert.equal(isEvalProofInput(result.proof), true);
  assert.equal(isEvalProofInput({ ...result.proof, acceptanceCriteria: [] }), false);
  assert.equal(
    isEvalProofInput({
      ...result.proof,
      executionTemplate: { ...qa.executionTemplate, id: 'other' },
    }),
    false,
  );
});

test('a partial rebase merge cannot be offered as the complete supplied change', async () => {
  await assert.rejects(
    resolveProofInput(params, source, undefined, dependencies(patch.replace('+fixed', '+partial'))),
    /complete recorded\/PR change/,
  );
});

test('retained sources without committed anchors refuse before any external lookup', () => {
  assert.throws(
    () =>
      proofSourceAnchors({
        ...source,
        source: { kind: 'package', packageId: 'fixture' },
        diff: unavailableDiff('not-committed'),
      }),
    /committed implementation/,
  );
});

test('proof admission refuses missing criteria instead of inserting a placeholder', async () => {
  await assert.rejects(
    resolveProofInput({ ...params, acceptanceCriteria: [] }, source, undefined, dependencies()),
    /ordered acceptanceCriteria/,
  );
});

test('proof admission rejects known golden bytes present in the implementation tree', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'proof-overlap-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'recipe.json');
  const text = '{"golden":"proof"}';
  await writeFile(file, text);
  const crypto = await import('node:crypto');
  const sha = crypto
    .createHash('sha1')
    .update(`blob ${Buffer.byteLength(text)}\0`)
    .update(text)
    .digest('hex');
  const deps = dependencies();
  const request = deps.request;
  deps.request = async (args) =>
    args[1].includes('/git/trees/')
      ? {
          stdout: JSON.stringify({
            truncated: false,
            tree: [{ type: 'blob', path: 'hidden-answer.json', sha }],
          }),
        }
      : request(args);
  await assert.rejects(
    resolveProofInput(
      params,
      {
        ...source,
        packageArtifacts: [
          {
            runId: 'missing-reference',
            familyId: 'reference',
            path: file,
            purpose: 'recipe',
            source: 'task-artifact',
            sha256: sha256Text(text),
          },
        ],
      },
      undefined,
      deps,
    ),
    /known reference proof/,
  );
});
