// Open #dev/native-session?replay=matching|foreign-command|foreign-generation,
// fill the Message control with cdp.mjs, then run this probe. Client-only proof.
const variant = new URLSearchParams(location.hash.split('?')[1]).get('replay');
if (!['matching', 'foreign-command', 'foreign-generation'].includes(variant))
  throw new Error('Open an explicit replay fixture');
const deadline = Date.now() + 10000;
let view;
while (Date.now() < deadline) {
  view = document
    .querySelector('native-session-dev')
    ?.shadowRoot?.querySelector('native-session-view')?.shadowRoot;
  if (
    view
      ?.querySelector('article.user')
      ?.textContent.includes('Earlier command awaiting its receipt')
  )
    break;
  await new Promise((resolve) => setTimeout(resolve, 100));
}
if (!view?.querySelector('article.user')) throw new Error('Seeded command was not replayed');
const input = view.querySelector('[data-testid="native-message"]');
const send = view.querySelector('[data-testid="native-send"]');
if (!input?.value || !send) throw new Error('Type a prospective next command through CDP first');
const expectedEnabled = variant === 'matching';
if (send.disabled === expectedEnabled)
  throw new Error(
    `Replay lock mismatch for ${variant}: expected Send ${expectedEnabled ? 'enabled' : 'disabled'}`,
  );
return {
  pass: true,
  fixture: true,
  variant,
  sendEnabled: !send.disabled,
  promptCount: view.querySelectorAll('article.user').length,
};
