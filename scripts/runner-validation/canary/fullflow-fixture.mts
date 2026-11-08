// Derive from the checkout under test on every run; never freeze worker templates here.
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import type { ProjectPack } from '../lib/remote-node-stack.mjs';
import { REVIEWER } from './fixtures.mjs';

export const FULLFLOW_PROJECT = 'farmslot-farm';
export const FULLFLOW_MODEL = { runner: 'pi', model: 'litellm/deepseek-v4p1-flash' } as const;

export const FULLFLOW_SEED: Record<string, string> = {
  'package.json': JSON.stringify({
    name: 'fullflow-sum', version: '1.0.0', private: true, type: 'module',
    scripts: { test: 'node --test sum.test.mjs' },
  }),
  '.gitignore': '.sandbox/\n.task/\n.agent/\nnode_modules/\n',
  'AGENTS.md': '# Canary boundaries\n\nWork only in this tiny repository and its generated task directory. The task-pinned toolchain and the named fullflow-canary checkout are read-only support. Never inspect other worktrees, live services, persistent Farmslot homes, foreign tmux servers, credentials, keys or logins. Never build or repair support tooling. If a prerequisite is missing, retain the exact error and mark blocked. Never push, publish or post.\n',
  'src/sum.mjs': 'export const sum = (a, b) => a - b;\n',
  'sum.test.mjs': "import assert from 'node:assert/strict';\nimport { test } from 'node:test';\nimport { sum } from './src/sum.mjs';\ntest('sum adds', () => assert.equal(sum(2, 3), 5));\n",
  'cli.mjs': "import { sum } from './src/sum.mjs';\nconsole.log(process.argv[2] === '--version' ? '1.0.0' : sum(Number(process.argv[2]), Number(process.argv[3])));\n",
  'CLAUDE.md': '# Fullflow sum fixture\n\nTiny Node package. The public CLI is `node cli.mjs 2 3`; expected output is 5. `node cli.mjs --version` prints 1.0.0. CI is `npm test`. No install, browser, server or device is needed. Use command/assert_output recipe actions. Follow the generated task and the real project quality contracts. All source commits stay local. Never push, publish, post or contact GitHub. Stop on engine refusals and retain their exact messages; do not change task tooling or baseline history.\n',
  // The real fix-bug template reads this path; this fixture has no Command Center app.
  'apps/command-center/CLAUDE.md': '# CLI fixture\n\nSee root CLAUDE.md. No UI or app runtime exists here.\n',
};

export async function fullflowPack(root: string, worker: { runner: string; model: string } = FULLFLOW_MODEL): Promise<ProjectPack> {
  const relative = 'projects/farmslot-farm';
  const files: Record<string, string> = {};
  // git ls-files includes tracked files hidden by the project's ignore rules, such as qa.md.
  for (const file of execFileSync('git', ['ls-files', '-z', relative], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean))
    files[path.relative(relative, file)] = await readFile(path.join(root, file), 'utf8');
  const project = JSON.parse(files['project.json']!);
  delete files['project.json'];
  // Same pack identity keeps its fixture destinations, node-support paths and flow wiring intact.
  // Only app-specific setup/health becomes CLI setup/health. Core prepare still runs git/fixtures/deps.
  project.prepare.default = 'fullflow';
  project.prepare.profiles.fullflow = project.prepare.core;
  project.hooks.post_merge_install = 'node --version';
  project.hooks.preflight = 'node --check src/sum.mjs';
  project.hooks.health_check = 'node cli.mjs --version';
  project.hooks.dev_server_check = 'node cli.mjs --version';
  project.hooks.setup = 'node --version';
  project.hooks.teardown = 'true';
  // CLI proof uses the real wrapper/runner/manifest from this checkout, with the tiny repo as cwd.
  const wrapper = '{{repo}}/.fullflow/validate-recipe.sh';
  const manifest = '{{repo}}/.fullflow/action-manifest.json';
  project.hooks.recipe_action_manifest = `cat '${manifest}'`;
  project.hooks.recipe_doctor = 'node cli.mjs --version';
  project.hooks.recipe_run = `FARMSLOT_SLOT_REPO={{repo}} bash '${wrapper}' --recipe {{recipe_path}} --artifacts-dir {{artifacts_dir}} --runtime-dir {{runtime_dir}} --platform cli --slot-id {{slot_id}} --run-id={{run_id}} --recipe-run-id={{recipe_run_id}}`;
  project.vars.recipe_runner_resolve_cmd = '{{repo}}/.fullflow/run-recipe.mjs';
  project.vars.recipe_manifest_path = manifest;
  project.vars.recipe_validate_wrapper = wrapper;
  // No app runtime exists in this fixture. Do not expose browser/device boot actions to it.
  delete project.resources;
  delete project.runtime_capabilities;
  delete project.slot_actions;
  delete project.artifacts_repo;
  project.apps = [];
  // CI still runs at the template's deterministic mark; only its command differs.
  project.ci = { enabled: true, local_check: 'npm test' };
  // All selectable worker/review defaults are cheap, allowlisted real models.
  for (const role of Object.keys(project.defaults)) project.defaults[role] = worker;
  delete project.workflow_defaults;
  project.review = { ...project.review, ...REVIEWER, enabled: true, mode: 'cold', max_retries: 1, review_timeout_min: 5 };
  project.monitoring = { poll_interval_min: 0.02, total_timeout_min: 25 };
  return { name: FULLFLOW_PROJECT, projectJson: project, files };
}
