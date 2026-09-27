/**
 * Restores a portable feedback document into the board's editable draft. The function is
 * serialized into the static board script, so it must stay self-contained.
 */
export function feedbackDraftFromDocument(source, document) {
  if (
    !document ||
    document.kind !== 'visual-review-feedback' ||
    document.version !== 1 ||
    !Array.isArray(document.surfaceNotes) ||
    !Array.isArray(document.annotations)
  ) {
    throw new Error('Not a visual-review-feedback v1 document.');
  }
  if (document.source?.id !== source.id) {
    throw new Error(
      'Feedback belongs to source ' + document.source?.id + ', not ' + source.id + '.',
    );
  }
  if (document.source.capturedAt !== source.capturedAt) {
    throw new Error(
      'Feedback was written for the capture of ' +
        document.source.capturedAt +
        '; this board shows the capture of ' +
        source.capturedAt +
        '.',
    );
  }
  const surfaceIds = new Set(source.surfaces.map((surface) => surface.id));
  const captureKeys = new Set(
    source.surfaces.flatMap((surface) =>
      surface.captures.map((capture) => surface.id + ':' + capture.id),
    ),
  );
  const isUnit = (value) => typeof value === 'number' && value >= 0 && value <= 1;
  const isExtent = (start, size) =>
    isUnit(start) && typeof size === 'number' && size > 0 && start + size <= 1;
  const ids = new Set();
  const invalid = [];
  const surfaceNotes = {};
  document.surfaceNotes.forEach((note, index) => {
    const valid =
      surfaceIds.has(note?.surfaceId) &&
      !(note.surfaceId in surfaceNotes) &&
      typeof note.body === 'string' &&
      note.body.trim() !== '';
    if (valid) {
      surfaceNotes[note.surfaceId] = note.body;
    } else {
      invalid.push('surfaceNotes[' + index + ']');
    }
  });
  document.annotations.forEach((annotation, index) => {
    const valid =
      captureKeys.has(annotation?.surfaceId + ':' + annotation?.captureId) &&
      typeof annotation.id === 'string' &&
      !ids.has(annotation.id) &&
      typeof annotation.body === 'string' &&
      annotation.body.trim() !== '' &&
      (annotation.shape === 'point'
        ? isUnit(annotation.x) && isUnit(annotation.y)
        : annotation.shape === 'area' &&
          isExtent(annotation.x, annotation.width) &&
          isExtent(annotation.y, annotation.height));
    if (valid) ids.add(annotation.id);
    else invalid.push('annotations[' + index + ']');
  });
  // Exports never contain these (blank entries are dropped on export), so any invalid entry
  // means the wrong or an edited file.
  if (invalid.length) {
    throw new Error(
      'Feedback has invalid entries: ' + invalid.join(', ') + '. Nothing was opened.',
    );
  }
  return {
    surfaceNotes,
    annotations: document.annotations.map((annotation) => ({ ...annotation })),
  };
}
