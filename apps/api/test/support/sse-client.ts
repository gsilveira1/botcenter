/** One Server-Sent Event: the `event:` field and the parsed JSON of the `data:` field. */
export interface SseEvent {
  event: string;
  // The test reads any field of the event.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data: any;
}

export interface SseClient {
  status: number;
  headers: Headers;
  /** The events that arrived, in order. */
  events: SseEvent[];
  /** The comment lines (heartbeats) that arrived. */
  comments: string[];
  /** Resolves with the next event (of `type`, when given) that arrives after the earlier calls. */
  next(type?: string, timeoutMs?: number): Promise<SseEvent>;
  /** Resolves when the server ends the stream. */
  closed: Promise<void>;
  /** Closes the stream from the client side. */
  close(): void;
}

/**
 * A minimal SSE client for the integration tests (the `fetch` of Node, like a browser `EventSource`).
 * A non-200 answer resolves too: read `status`.
 */
export async function openSse(
  url: string,
  headers: Record<string, string> = {},
): Promise<SseClient> {
  const controller = new AbortController();
  const response = await fetch(url, {
    headers: { accept: 'text/event-stream', ...headers },
    signal: controller.signal,
  });
  const events: SseEvent[] = [];
  const comments: string[] = [];
  const waiters: (() => void)[] = [];
  let cursor = 0;

  const notify = () => {
    for (const waiter of waiters.splice(0)) {
      waiter();
    }
  };

  const parseFrame = (frame: string) => {
    let event = 'message';
    const data: string[] = [];
    for (const line of frame.split('\n')) {
      if (line.startsWith(':')) {
        comments.push(line);
      } else if (line.startsWith('event: ')) {
        event = line.slice(7);
      } else if (line.startsWith('data: ')) {
        data.push(line.slice(6));
      }
    }
    if (data.length > 0) {
      events.push({ event, data: JSON.parse(data.join('\n')) });
    }
  };

  const closed = (async () => {
    if (!response.body || response.status !== 200) {
      await response.text().catch(() => undefined);
      return;
    }
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      for await (const chunk of response.body) {
        buffer += decoder.decode(chunk as Uint8Array, { stream: true });
        let index = buffer.indexOf('\n\n');
        while (index >= 0) {
          parseFrame(buffer.slice(0, index));
          buffer = buffer.slice(index + 2);
          index = buffer.indexOf('\n\n');
        }
        notify();
      }
    } catch (error) {
      if (!(error instanceof Error && error.name === 'AbortError')) {
        throw error;
      }
    } finally {
      notify();
    }
  })();
  let ended = false;
  void closed.then(() => {
    ended = true;
    notify();
  });

  const next = async (type?: string, timeoutMs = 10_000): Promise<SseEvent> => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      while (cursor < events.length) {
        const candidate = events[cursor]!;
        cursor += 1;
        if (!type || candidate.event === type) {
          return candidate;
        }
      }
      if (ended) {
        throw new Error(`the stream ended before the event ${type ?? '(any)'}`);
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new Error(`no event ${type ?? '(any)'} in ${timeoutMs} ms`);
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, remaining);
        waiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  };

  return {
    status: response.status,
    headers: response.headers,
    events,
    comments,
    next,
    closed,
    close: () => controller.abort(),
  };
}
