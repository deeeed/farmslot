import * as Clipboard from 'expo-clipboard';
import { useState } from 'react';

interface CopyResult {
  text: string;
  copied: boolean;
}

/**
 * Copies `text` to the clipboard. `copied` reports the last copy of this same text, so a
 * recycled list cell or a streamed message that changed its text starts over.
 */
export function useCopyText(text: string) {
  const [result, setResult] = useState<CopyResult>();
  const copy = () =>
    Clipboard.setStringAsync(text).then(
      (copied) => setResult({ text, copied }),
      () => setResult({ text, copied: false }),
    );
  return { copied: result?.text === text ? result.copied : undefined, copy };
}
