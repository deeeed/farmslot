#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const docsRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(docsRoot, '../..');
const outDir = path.join(docsRoot, 'static/img/demos');

const copies = [
  {
    source:
      'docs/examples/recipes/farmslot/artifacts/command-center-ui/screenshots/command-center-recipe-workspace.svg',
    target: 'command-center-recipe-workspace.svg',
  },
  {
    source:
      'docs/examples/recipes/farmslot/artifacts/recipe-player-e2e/screenshots/live-replay-result.svg',
    target: 'recipe-evidence-run.svg',
  },
  {
    source:
      'docs/examples/recipes/farmslot/artifacts/mobile-companion/screenshots/mobile-companion-artifacts.svg',
    target: 'mobile-companion-artifacts.svg',
  },
];

function copyFixture({ source, target }) {
  const from = path.join(repoRoot, source);
  const to = path.join(outDir, target);
  if (!fs.existsSync(from)) throw new Error(`Missing demo source: ${source}`);
  fs.copyFileSync(from, to);
  return { source, target: `apps/docs/static/img/demos/${target}` };
}

function generateProjectTypePoster() {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720" viewBox="0 0 1280 720">
  <rect width="1280" height="720" fill="#080b12"/>
  <rect x="32" y="32" width="1216" height="656" rx="24" fill="#111827" stroke="#10b981" stroke-width="3"/>
  <text x="72" y="92" fill="#f8fafc" font-family="SFMono-Regular, Menlo, monospace" font-size="30" font-weight="700">Recipe-backed project integrations</text>
  <text x="72" y="132" fill="#94a3b8" font-family="SFMono-Regular, Menlo, monospace" font-size="16">Same Farmslot loop, different public demo targets. Private work projects stay out of launch media.</text>

  <rect x="72" y="178" width="520" height="368" rx="20" fill="#0f172a" stroke="#38bdf8"/>
  <text x="110" y="232" fill="#bae6fd" font-family="SFMono-Regular, Menlo, monospace" font-size="24" font-weight="700">Audiolab</text>
  <text x="110" y="274" fill="#e5e7eb" font-family="SFMono-Regular, Menlo, monospace" font-size="16">apps/playground · Expo recipe runner</text>
  <rect x="110" y="320" width="404" height="52" rx="12" fill="#082f49" stroke="#0ea5e9"/>
  <text x="136" y="354" fill="#e0f2fe" font-family="SFMono-Regular, Menlo, monospace" font-size="15">recipe_action_manifest · pass</text>
  <rect x="110" y="392" width="404" height="52" rx="12" fill="#082f49" stroke="#0ea5e9"/>
  <text x="136" y="426" fill="#e0f2fe" font-family="SFMono-Regular, Menlo, monospace" font-size="15">smoke.navigation · screenshot proof</text>

  <rect x="688" y="178" width="520" height="368" rx="20" fill="#0f172a" stroke="#a78bfa"/>
  <text x="726" y="232" fill="#ede9fe" font-family="SFMono-Regular, Menlo, monospace" font-size="24" font-weight="700">EchoBridge</text>
  <text x="726" y="274" fill="#e5e7eb" font-family="SFMono-Regular, Menlo, monospace" font-size="16">apps/echobridge · Recipe v1 bridge</text>
  <rect x="726" y="320" width="404" height="52" rx="12" fill="#312e81" stroke="#8b5cf6"/>
  <text x="752" y="354" fill="#ede9fe" font-family="SFMono-Regular, Menlo, monospace" font-size="15">recording.sync.lifecycle · validated</text>
  <rect x="726" y="392" width="404" height="52" rx="12" fill="#312e81" stroke="#8b5cf6"/>
  <text x="752" y="426" fill="#ede9fe" font-family="SFMono-Regular, Menlo, monospace" font-size="15">artifact-manifest.json · typed evidence</text>

  <rect x="260" y="590" width="760" height="54" rx="27" fill="#052e16" stroke="#22c55e"/>
  <text x="324" y="624" fill="#bbf7d0" font-family="SFMono-Regular, Menlo, monospace" font-size="18">Dispatch → watch → validate → review with project-owned adapters</text>
</svg>
`;
  const target = path.join(outDir, 'project-type-framework.svg');
  fs.writeFileSync(target, svg);
  return {
    source: 'apps/docs/scripts/generate-demo-media.mjs',
    target: 'apps/docs/static/img/demos/project-type-framework.svg',
  };
}

fs.mkdirSync(outDir, { recursive: true });
const generated = [...copies.map(copyFixture), generateProjectTypePoster()];
console.log(JSON.stringify({ generated }, null, 2));
