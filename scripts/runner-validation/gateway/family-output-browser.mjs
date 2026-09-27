import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

const route = process.env.FARMSLOT_OUTPUT_FAMILY_ROUTE;
const reportText = process.env.FARMSLOT_OUTPUT_REPORT_TEXT;
const nestedPath = process.env.FARMSLOT_OUTPUT_LINKED_PATH;
assert.ok(
  route && reportText && nestedPath,
  'Set FARMSLOT_OUTPUT_FAMILY_ROUTE, FARMSLOT_OUTPUT_REPORT_TEXT and FARMSLOT_OUTPUT_LINKED_PATH',
);
const cdp = (...args) =>
  JSON.parse(
    execFileSync(process.execPath, ['apps/command-center/scripts/cdp.mjs', ...args], {
      encoding: 'utf8',
    }),
  );
const root = 'document.querySelector("family-observability").shadowRoot';
const lightbox = `${root}.querySelector("media-lightbox")`;
async function waitFor(expression) {
  for (let attempt = 0; attempt < 20; attempt++) {
    if (cdp('eval', route, `return Boolean(${expression})`)) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  assert.fail(`Browser assertion failed: ${expression}`);
}
cdp(
  'eval',
  route,
  `${root}.querySelector('[data-testid="family-run-files"]').scrollIntoView(); return true;`,
);
cdp('click', route, 'family-observability >>> [data-testid="family-read-report"]');
await waitFor(
  `${lightbox}.open && ${lightbox}.shadowRoot.textContent.includes(${JSON.stringify(reportText)})`,
);
const { selector } = cdp(
  'eval',
  route,
  `
  const link = [...${lightbox}.shadowRoot.querySelectorAll('a')].find(a =>
    new URL(a.href).searchParams.get('path') === ${JSON.stringify(nestedPath)});
  if (!link) throw new Error('Report evidence link missing');
  link.scrollIntoView();
  return { selector: 'family-observability >>> media-lightbox >>> a[href="' + CSS.escape(link.getAttribute('href')) + '"]' };
`,
);
cdp('click', route, selector);
await waitFor(
  `${lightbox}.items[${lightbox}.selectedIndex]?.path === ${JSON.stringify(nestedPath)}`,
);
console.log(JSON.stringify({ pass: true, reportRendered: true, nestedFileOpened: nestedPath }));
