// Live selection proof on a real slot: does a profile requiring
// `required_skills_present` fall back when a required skill file is missing?
//
// Read-only. It evaluates selection against the slot's real pool and project
// config and prints the result; it prepares nothing and writes nothing. The
// operator removes and restores the skill around the two runs.
//
//   node --import tsx scripts/runner-validation/gateway/required-skills-present-selection.mts <slot-id>
import { loadProjectVars, loadSlotVars } from '../../../services/gateway/src/core/config.js';
import {
  checkPrepareRequirement,
  selectPrepareProfile,
} from '../../../services/gateway/src/methods/slot/prepare-profile.js';

const slotId = process.argv[2];
if (!slotId) throw new Error('usage: required-skills-present-selection.mts <slot-id>');
const vars = await loadSlotVars(slotId);
const projectVars = await loadProjectVars(vars.projectName);
const projectJson = { ...projectVars.projectJson } as Record<string, unknown>;
// The deployed Terminal pack has no owned_paths_present requirement yet, so the
// proof declares it on attach exactly as the pack would after this lands.
const prepare = JSON.parse(JSON.stringify(projectJson.prepare)) as {
  profiles: Record<string, { requires?: string[]; fallback?: string }>;
};
// Isolate the new check: health_ok fails on an idle slot for unrelated reasons
// (no dev server), so this variant requires only the skills check.
prepare.profiles.attach.requires = ['required_skills_present'];
projectJson.prepare = prepare;
const ctx = {
  vars,
  projectJson: projectJson as never,
  projectVars,
  runtimeDir: 'temp/farmslot',
  flow: process.argv[3] ?? 'fix-bug',
  domain: (projectJson as { default_domain?: string }).default_domain,
};
const owned = await checkPrepareRequirement('required_skills_present', ctx);
console.log(`required_skills_present ok=${owned.ok} detail=${owned.detail.slice(0, 220)}`);
const selection = await selectPrepareProfile(ctx, 'attach', (profile, result) =>
  console.log(`  check ${profile}/${result.requirement} ok=${result.ok}`),
);
console.log(
  `selected=${selection.profile.name} fallbacks=${selection.fallbacks.map((f) => `${f.from}->${f.to}`).join(',') || 'none'}`,
);
