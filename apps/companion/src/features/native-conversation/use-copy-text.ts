import * as Clipboard from 'expo-clipboard';
import { useState } from 'react';

interface CopyResult {
  id: string;
  text: string;
  copied: boolean;
}

/**
 * Copies `text` to the clipboard. `copied` reports the last copy of this message (`id`) with this
 * same text, so a recycled list cell showing another message, even one with the same text, or a
 * streamed message whose text changed, starts over.
 */
export function useCopyText(id: string, text: string) {
  const [result, setResult] = useState<CopyResult>();
  const copy = () =>
    Clipboard.setStringAsync(text).then(
      (copied) => setResult({ id, text, copied }),
      () => setResult({ id, text, copied: false }),
    );
  return {
    copied: result?.id === id && result.text === text ? result.copied : undefined,
    copy,
  };
}
