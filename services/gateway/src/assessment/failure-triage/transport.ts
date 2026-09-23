/** The evaluation has three closed-choice answers, so a 64 KiB body is ample. */
export function boundedAssessmentFetch(fetchImpl: typeof fetch = fetch): typeof fetch {
  return async (input, init) => {
    const response = await fetchImpl(input, { ...init, redirect: 'error' });
    const reader = response.body?.getReader();
    if (!reader) return response;
    let size = 0;
    // Do not await the body before returning headers. The provider records a receipt
    // before its SDK consumes the stream, even if reading later fails.
    const body = new ReadableStream<Uint8Array>(
      {
        async pull(controller) {
          try {
            const next = await reader.read();
            if (next.done) {
              controller.close();
              return;
            }
            size += next.value.byteLength;
            if (size > 64 * 1024) {
              await reader.cancel();
              controller.error(new Error('Assessment response exceeds byte limit'));
              return;
            }
            controller.enqueue(next.value);
          } catch (error) {
            controller.error(error);
          }
        },
        cancel(reason) {
          return reader.cancel(reason);
        },
      },
      { highWaterMark: 0 },
    );
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
}
