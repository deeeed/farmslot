// Client-only static preview: textless errors and pending-request announcement.
const end = Date.now() + 10000;
let v;
while (Date.now() < end) {
  v = document
    .querySelector('native-session-dev')
    ?.shadowRoot?.querySelector('native-session-view')?.shadowRoot;
  if (v?.querySelectorAll('article').length >= 4) break;
  await new Promise((r) => setTimeout(r, 100));
}
if (!Array.from(v.querySelectorAll('article')).some((e) => e.textContent.includes('Runner error')))
  throw new Error('Textless error rendered as completion');
const announcement = v.querySelector('.requests [aria-live=polite]')?.textContent.trim();
if (!announcement?.includes('1 runner request'))
  throw new Error('Pending request announcement missing');
return { pass: true, fixture: true, errorFallback: true, announcement };
