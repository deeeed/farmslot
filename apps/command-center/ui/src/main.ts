// Initialize the desktop connection before importing any gateway consumers.
import { browserSharedViewReceipt } from './utils/shared-view-link.js';
import { initializeDesktopConnection, isDesktopClient } from './desktop-connection.js';

async function start(): Promise<void> {
  await initializeDesktopConnection();
  if (!isDesktopClient()) {
    const receipt = browserSharedViewReceipt();
    if (receipt.status === 'refused') throw new Error(receipt.message);
    if (receipt.status === 'accepted') history.replaceState(null, '', receipt.route);
    // A marked link opened into an existing SPA gets the same pre-import gate
    // as a new window, before any mounted consumer can follow its new identity.
    window.addEventListener(
      'hashchange',
      (event) => {
        if (browserSharedViewReceipt().status === 'ordinary') return;
        event.stopImmediatePropagation();
        location.reload();
      },
      { capture: true },
    );
  }
  await import('./start.js');
}

void start().catch((error: unknown) => {
  const message = document.createElement('p');
  message.textContent = `Unable to open Command Center: ${error instanceof Error ? error.message : String(error)}`;
  document.body.replaceChildren(message);
  if (!isDesktopClient()) {
    const retry = document.createElement('button');
    retry.textContent = 'Try again';
    retry.addEventListener('click', () => location.reload());
    document.body.append(retry);
    const connection = document.createElement('a');
    connection.href = `${location.pathname}#doctor`;
    connection.target = '_blank';
    connection.rel = 'noopener';
    connection.textContent = 'Open Command Center connection';
    document.body.append(connection);
  }
  if (!isDesktopClient()) return;
  const settings = document.createElement('a');
  settings.href = '/settings';
  settings.textContent = 'Open connection settings';
  document.body.append(settings);
});
