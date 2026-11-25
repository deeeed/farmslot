// A provider can refuse a request that carries more images than it accepts: Sparks vLLM takes at
// most --vision-max-images (50). Pi records such caps in the model catalog (inputLimits.images)
// but does not trim history against them, so the oldest images give way to a short note.

/** Stands in for an image dropped from the request. */
export const IMAGE_OMITTED = "[image omitted: an older image over this model's image limit]";

const cap = (value) => (Number.isInteger(value) && value > 0 ? value : undefined);

/** The image caps a Pi model declares in inputLimits.images. */
export function modelImageCaps(model) {
  const images = model?.inputLimits?.images;
  return { perRequest: cap(images?.maxPerRequest), perMessage: cap(images?.maxPerMessage) };
}

/**
 * Messages with their oldest image blocks replaced by a note, so each message holds at most
 * `perMessage` images and the request at most `perRequest`. Undefined when nothing is over a cap.
 */
export function capContextImages(messages, { perRequest, perMessage }) {
  if (perRequest === undefined && perMessage === undefined) return undefined;
  const drop = new Set();
  const kept = [];
  messages.forEach((message, m) => {
    if (!Array.isArray(message?.content)) return;
    const own = [];
    message.content.forEach((block, b) => {
      if (block?.type === 'image') own.push(`${m}:${b}`);
    });
    const over = perMessage === undefined ? 0 : Math.max(0, own.length - perMessage);
    own.slice(0, over).forEach((key) => drop.add(key));
    kept.push(...own.slice(over));
  });
  if (perRequest !== undefined)
    kept.slice(0, Math.max(0, kept.length - perRequest)).forEach((key) => drop.add(key));
  if (drop.size === 0) return undefined;
  const note = { type: 'text', text: IMAGE_OMITTED };
  return {
    dropped: drop.size,
    messages: messages.map((message, m) =>
      Array.isArray(message?.content) && message.content.some((_, b) => drop.has(`${m}:${b}`))
        ? {
            ...message,
            content: message.content.map((block, b) => (drop.has(`${m}:${b}`) ? note : block)),
          }
        : message,
    ),
  };
}
