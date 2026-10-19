// A small parser of Server-Sent Events (the `text/event-stream` format of the WHATWG HTML standard).
// Pure: no I/O, so `node --test` checks it.

/**
 * @typedef {{ event: string, data: string, id?: string }} SseMessage
 */

/**
 * Makes a parser that takes text chunks and returns the complete messages of each chunk.
 * A comment line (`: heartbeat`) gives no message. A message without `event:` has the type `message`.
 * @returns {(chunk: string) => SseMessage[]}
 */
export function createSseParser() {
  let buffer = '';
  return (chunk) => {
    buffer += chunk.replace(/\r\n?/g, '\n');
    const messages = [];
    let end = buffer.indexOf('\n\n');
    while (end !== -1) {
      const block = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      const message = parseBlock(block);
      if (message) messages.push(message);
      end = buffer.indexOf('\n\n');
    }
    return messages;
  };
}

/**
 * @param {string} block
 * @returns {SseMessage | null}
 */
function parseBlock(block) {
  let event = 'message';
  let id;
  const data = [];
  for (const line of block.split('\n')) {
    if (line === '' || line.startsWith(':')) continue;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    const value = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '');
    if (field === 'event') event = value;
    else if (field === 'data') data.push(value);
    else if (field === 'id') id = value;
  }
  if (data.length === 0) return null;
  return id === undefined ? { event, data: data.join('\n') } : { event, data: data.join('\n'), id };
}
