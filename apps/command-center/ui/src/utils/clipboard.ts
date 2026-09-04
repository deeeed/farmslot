/**
 * Copy text to the clipboard, falling back to a hidden textarea.
 *
 * `navigator.clipboard.writeText` rejects with "Document is not focused"
 * whenever the page is not the focused window — which is exactly the case for
 * an automated CDP click and for an operator who triggered the action from a
 * background tab. The legacy `execCommand('copy')` path has no focus
 * requirement, so it is the fallback rather than a silent failure.
 *
 * Throws when neither path copies, so callers surface a real error instead of
 * telling the operator the command is on their clipboard when it is not.
 */
export async function copyTextToClipboard(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch (err) {
      if (!copyViaTextarea(text)) {
        throw new Error(`Clipboard copy failed: ${(err as Error).message}`);
      }
      return;
    }
  }
  if (!copyViaTextarea(text)) {
    throw new Error('Clipboard copy failed: no clipboard API available');
  }
}

function copyViaTextarea(text: string): boolean {
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.select();
  try {
    return document.execCommand('copy');
  } finally {
    document.body.removeChild(textarea);
  }
}
