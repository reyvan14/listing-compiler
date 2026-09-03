// Incremental SSE parser for `fetch`-based streaming over POST.
//
// EventSource cannot POST, and this request carries the conversation plus the
// canvas snapshot, so the body is read by hand. Network chunks fall wherever
// TCP puts them: a chunk may hold half a frame, three frames, or a frame split
// mid-field. The parser below only ever consumes text up to a blank line, so
// none of that is visible to callers.

export type SseEvent = { event: string; data: string };

/** Frames end at a blank line; providers and proxies differ on line endings. */
const TERMINATORS = ['\r\n\r\n', '\n\n'] as const;

export class SseParser {
  private buffer = '';

  /** Complete events contained in `chunk` plus anything buffered before it. */
  push(chunk: string): SseEvent[] {
    this.buffer += chunk;
    const events: SseEvent[] = [];
    for (;;) {
      let cut = -1;
      let width = 0;
      for (const terminator of TERMINATORS) {
        const at = this.buffer.indexOf(terminator);
        if (at !== -1 && (cut === -1 || at < cut)) {
          cut = at;
          width = terminator.length;
        }
      }
      if (cut === -1) return events;
      const frame = this.buffer.slice(0, cut);
      this.buffer = this.buffer.slice(cut + width);
      const parsed = parseFrame(frame);
      if (parsed) events.push(parsed);
    }
  }

  /** Any trailing frame the server left unterminated. */
  flush(): SseEvent[] {
    const rest = this.buffer;
    this.buffer = '';
    const parsed = rest.trim() ? parseFrame(rest) : null;
    return parsed ? [parsed] : [];
  }
}

/**
 * One frame into an event.
 *
 * Comment lines (`:` heartbeats) and unknown fields are ignored — that is what
 * the SSE spec requires, and it is what keeps a proxy's keep-alive comments
 * from being mistaken for data.
 */
function parseFrame(frame: string): SseEvent | null {
  let event = '';
  const data: string[] = [];
  for (const rawLine of frame.split('\n')) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (!line || line.startsWith(':')) continue;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') event = value;
    else if (field === 'data') data.push(value);
  }
  if (!event && data.length === 0) return null;
  return { event: event || 'message', data: data.join('\n') };
}

/** Parse an event's JSON payload, or null if it is not usable. */
export function eventPayload(event: SseEvent): Record<string, unknown> | null {
  if (!event.data) return null;
  try {
    const parsed = JSON.parse(event.data);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    // A malformed frame is skipped, never fatal: the rest of the stream is
    // usually fine and the user already has real text on screen.
    return null;
  }
}
