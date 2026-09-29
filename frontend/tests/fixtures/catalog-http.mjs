/** Give legacy JSON-response test doubles a real, lazy byte stream. */
export async function catalogHttpResponse(value) {
  const response = await value;
  if (response.body || response instanceof Response) return response;
  return {
    ...response,
    headers: response.headers ?? new Headers(),
    body: new ReadableStream({
      async start(controller) {
        try {
          const value = await response.json();
          controller.enqueue(new TextEncoder().encode(JSON.stringify(value)));
          controller.close();
        } catch (error) {
          controller.error(error);
        }
      },
    }),
  };
}
