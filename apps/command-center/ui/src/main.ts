// Initialize the desktop connection before importing any gateway consumers.
import { initializeDesktopConnection, isDesktopClient } from './desktop-connection.js';

async function start(): Promise<void> {
  await initializeDesktopConnection();
  await import('./start.js');
}

void start().catch((error: unknown) => {
  const message = document.createElement('p');
  message.textContent = `Unable to open Command Center: ${error instanceof Error ? error.message : String(error)}`;
  document.body.replaceChildren(message);
  if (!isDesktopClient()) return;
  const settings = document.createElement('a');
  settings.href = '/settings';
  settings.textContent = 'Open connection settings';
  document.body.append(settings);
});
