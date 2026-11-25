// A provider can refuse a request that carries more images than it accepts: Sparks vLLM takes at
// most --vision-max-images (50). Pi records such caps in the model catalog (inputLimits.images)
// but does not trim history against them, so the oldest images give way to a short note.

/** Stands in for an image dropped from the request. */
export const IMAGE_OMITTED = "[image omitted: an older image over this model's image limit]";

/**
 * Messages with their oldest image blocks replaced by a note, so each provider message holds at
 * most `perMessage` images and the request at most `perRequest`. Pi sends consecutive tool
 * results as one provider message, so they share one per-message count. Over the request cap,
 * images go in batches of a fifth of the cap: the trimmed prefix, and the provider's prompt
 * cache, then stay the same until that many more images arrive. Undefined when nothing is over.
 */
export function capContextImages(messages, { perRequest, perMessage }) {
  if (perRequest === undefined && perMessage === undefined) return undefined;
  const groups = [];
  let open;
  let previousRole;
  messages.forEach((message, m) => {
    const role = message?.role;
    // Pi sends a system message that lands among tool results after them, and leaves out an
    // excluded bash execution: neither splits the provider message the results merge into.
    const aside = role === 'system' || (role === 'bashExecution' && message.excludeFromContext);
    let group;
    if (aside) groups.push((group = []));
    else {
      if (role !== 'toolResult' || previousRole !== 'toolResult') groups.push((open = []));
      group = open;
      previousRole = role;
    }
    if (!Array.isArray(message?.content)) return;
    message.content.forEach((block, b) => {
      if (block?.type === 'image') group.push(`${m}:${b}`);
    });
  });
  const drop = new Set();
  const kept = [];
  for (const group of groups) {
    const over = perMessage === undefined ? 0 : Math.max(0, group.length - perMessage);
    group.slice(0, over).forEach((key) => drop.add(key));
    kept.push(...group.slice(over));
  }
  if (perRequest !== undefined && kept.length > perRequest) {
    const batch = Math.max(1, Math.floor(perRequest / 5));
    const count = Math.ceil((kept.length - perRequest) / batch) * batch;
    kept.slice(0, count).forEach((key) => drop.add(key));
  }
  if (drop.size === 0) return undefined;
  const note = { type: 'text', text: IMAGE_OMITTED };
  return {
    dropped: drop.size,
    images: groups.flat().length,
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
