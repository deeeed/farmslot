/**
 * A text file previewed in the media viewer is read through one HTTP byte
 * range from its start, so a large log never downloads in full. The gateway's
 * artifact routes answer a range with 206 and the file's total size.
 */
export const TEXT_PREVIEW_MAX_BYTES = 200_000;

export const TEXT_PREVIEW_RANGE = `bytes=0-${TEXT_PREVIEW_MAX_BYTES - 1}`;

/** The previewed file's total size, read from the answer to `TEXT_PREVIEW_RANGE`. */
export function textPreviewTotalBytes(status: number, contentRange: string | null): number {
  // A range starting at byte 0 is unsatisfiable only for an empty file.
  if (status === 416 && contentRange === 'bytes */0') return 0;
  if (status === 200) throw new Error('The gateway ignored the byte range');
  if (status !== 206) throw new Error(`HTTP ${status}`);
  const match = contentRange?.match(/^bytes 0-\d+\/(\d+)$/);
  if (!match) throw new Error(`Unexpected Content-Range: ${contentRange ?? 'none'}`);
  return Number(match[1]);
}
