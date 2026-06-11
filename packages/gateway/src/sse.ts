/**
 * Minimal streaming-body parsers shared by the provider adapters.
 * Works on any AsyncIterable<Uint8Array> (fetch Response.body is one in Node >= 18).
 */

export interface SseEvent {
  /** Value of the `event:` field, if present. */
  event?: string;
  /** Joined `data:` lines for one SSE event. */
  data: string;
}

/** Parse a Server-Sent Events byte stream into { event, data } records. */
export async function* sseEvents(body: AsyncIterable<Uint8Array>): AsyncGenerator<SseEvent, void, void> {
  const decoder = new TextDecoder();
  let buffer = '';
  let eventName: string | undefined;
  let dataLines: string[] = [];

  const flush = (): SseEvent | undefined => {
    if (dataLines.length === 0) {
      eventName = undefined;
      return undefined;
    }
    const ev: SseEvent = { data: dataLines.join('\n') };
    if (eventName !== undefined) ev.event = eventName;
    eventName = undefined;
    dataLines = [];
    return ev;
  };

  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf('\n')) !== -1) {
      let line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      if (line === '') {
        const ev = flush();
        if (ev) yield ev;
      } else if (line.startsWith('event:')) {
        eventName = line.slice('event:'.length).trim();
      } else if (line.startsWith('data:')) {
        dataLines.push(line.slice('data:'.length).replace(/^ /, ''));
      }
      // comments (lines starting with ':') and unknown fields are ignored
    }
  }
  const ev = flush();
  if (ev) yield ev;
}

/** Parse a newline-delimited JSON byte stream, yielding one parsed value per line. */
export async function* ndjsonLines(body: AsyncIterable<Uint8Array>): AsyncGenerator<unknown, void, void> {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (line.length > 0) yield JSON.parse(line) as unknown;
    }
  }
  const rest = buffer.trim();
  if (rest.length > 0) yield JSON.parse(rest) as unknown;
}
