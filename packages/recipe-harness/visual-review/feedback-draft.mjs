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
  const surfaceIds = new Set(source.surfaces.map((surface) => surface.id));
  const captureKeys = new Set(
    source.surfaces.flatMap((surface) =>
      surface.captures.map((capture) => surface.id + ':' + capture.id),
    ),
  );
  const isUnit = (value) => typeof value === 'number' && value >= 0 && value <= 1;
  const surfaceNotes = {};
  for (const note of document.surfaceNotes) {
    if (surfaceIds.has(note?.surfaceId) && typeof note.body === 'string') {
      surfaceNotes[note.surfaceId] = note.body;
    }
  }
  return {
    surfaceNotes,
    annotations: document.annotations
      .filter(
        (annotation) =>
          captureKeys.has(annotation?.surfaceId + ':' + annotation?.captureId) &&
          typeof annotation.id === 'string' &&
          typeof annotation.body === 'string' &&
          isUnit(annotation.x) &&
          isUnit(annotation.y) &&
          (annotation.shape === 'point' ||
            (annotation.shape === 'area' && isUnit(annotation.width) && isUnit(annotation.height))),
      )
      .map((annotation) => ({ ...annotation })),
  };
}
