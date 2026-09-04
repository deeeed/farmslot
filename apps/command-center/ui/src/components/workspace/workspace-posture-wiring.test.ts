import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

/**
 * Regression guards for the publication gates (ADR-054 deliverable 7).
 *
 * The ready and review workspaces resolve their own decisions, so the operator's
 * posture choice reaches the Gateway only if each of them forwards it. These are
 * source-level guards, not proof: proving the ready gate end to end needs a run
 * that actually reaches a publication gate, which the scripted runner cannot
 * produce. They exist so the wiring cannot be silently dropped.
 */
function source(file: string): string {
  return readFileSync(path.resolve(import.meta.dirname, file), 'utf8');
}

test('the ready workspace forwards the operator posture choice on every resolution', () => {
  const presenter = source('ready-workspace-action-presenter.ts');

  // One `_resolve` funnels every ready-gate action, so the choice rides along
  // with all of them.
  assert.match(presenter, /resourcePosture: this\.resourcePosture/);
  assert.match(presenter, /buildRunResolveDecisionParams\(/);
});

test('the review workspace forwards the choice on both post and dismiss', () => {
  const review = source('review-workspace.ts');
  const occurrences = review.match(/resourcePosture: this\.resourcePosture/g) ?? [];

  // Post and dismiss are separate resolution sites; missing either one would
  // drop the choice for that action.
  assert.equal(occurrences.length, 2);
});

test('both workspaces refuse to resolve while the Gateway rejected the choice', () => {
  // Without this, a refused posture would be sent anyway: the decision is
  // consumed and the refusal simply repeats with nothing left to retry.
  assert.match(source('ready-workspace-action-presenter.ts'), /if \(this\.postureBlockedReason\)/);
  const review = source('review-workspace.ts');
  assert.equal((review.match(/if \(this\.postureBlockedReason\) return;/g) ?? []).length, 2);
});

test('the gate section mounts the posture selector above both workspaces', () => {
  const gate = source('../runs/run-detail-decision-renderers.ts');
  const workspaceBranch = gate.slice(gate.indexOf('<div class="gate-workspace">'));

  // The selector has to render before the workspace, and each workspace has to
  // receive the choice and the blocked reason as properties.
  assert.match(workspaceBranch, /renderRunPostureGateChoices\(/);
  assert.equal(
    (workspaceBranch.match(/\.resourcePosture=\$\{context\.posture\.choice\}/g) ?? []).length,
    2,
  );
  assert.equal(
    (workspaceBranch.match(/\.postureBlockedReason=\$\{context\.postureBlockedReason\}/g) ?? [])
      .length,
    2,
  );
});
