#!/usr/bin/env node
// Generate the Farmslot farm's review rule pack (ADR-0073 Amendment 1) from its canonical
// FSR rules. Edit fixtures/runtime/review-quality.md, then run this; never hand-edit the
// pack. `--check` fails when the committed pack is stale.
//
// Each `### FSR-NN. Title` rule is one family, anchored by `<a id="fsr-nn"></a>` and caused
// by its `- Failure:` line. Areas cover the whole checkout until selection needs narrower ones.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const runtime = fileURLToPath(new URL('../fixtures/runtime/', import.meta.url));
const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  return index === -1 ? fallback : path.resolve(args[index + 1]);
};
const source = option('--source', path.join(runtime, 'review-quality.md'));
const out = option('--out', path.join(runtime, 'review-pack.json'));

function fail(message) {
  console.error(message);
  process.exit(1);
}

const text = fs.readFileSync(source, 'utf8');
const headings = [...text.matchAll(/^### (FSR-\d+)\. (.+)$/gm)];
if (!headings.length) fail(`${source} has no FSR rules`);
const families = headings.map((heading, index) => {
  const [, ruleId, title] = heading;
  const id = ruleId.toLowerCase();
  const before = text.slice(0, heading.index).trimEnd();
  if (!before.endsWith(`<a id="${id}"></a>`)) fail(`${ruleId} has no <a id="${id}"></a> anchor`);
  const body = text.slice(heading.index, headings[index + 1]?.index ?? text.length);
  const why = body.match(/^- Failure: (.+)$/m)?.[1].trim();
  if (!why) fail(`${ruleId} has no "- Failure:" line`);
  return {
    id,
    title: title.trim(),
    file: 'review-quality.md',
    areas: { paths: { farmslot: ['**'] } },
    status: 'active',
    class: 'blocking',
    rules: [{ label: title.trim(), why }],
  };
});

const pack = {
  schemaVersion: 1,
  id: 'farmslot',
  source: {
    repository: 'deeeed/farmslot',
    revision: `sha256:${createHash('sha256').update(text).digest('hex')}`,
  },
  families,
};
const content = `${JSON.stringify(pack, null, 2)}\n`;
if (args.includes('--check')) {
  if (!fs.existsSync(out) || fs.readFileSync(out, 'utf8') !== content)
    fail(`${out} is stale: run node projects/farmslot-farm/scripts/review-pack.mjs`);
} else fs.writeFileSync(out, content);
