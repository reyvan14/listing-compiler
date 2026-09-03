import { describe, expect, it } from 'vitest';
import { SseParser, eventPayload } from './sse';

// Chunk boundaries are a network artefact. None of them may be visible to a
// caller, so every test here feeds the same bytes at different split points
// and demands the same events out.

function frame(event: string, data: unknown, eol = '\n') {
  return `event: ${event}${eol}data: ${JSON.stringify(data)}${eol}${eol}`;
}

function feedInPieces(body: string, size: number) {
  const parser = new SseParser();
  const events = [];
  for (let i = 0; i < body.length; i += size) {
    events.push(...parser.push(body.slice(i, i + size)));
  }
  events.push(...parser.flush());
  return events;
}

describe('SseParser', () => {
  const body =
    frame('meta', { requestId: 'r1' }) +
    frame('status', { stage: 'planning', sequence: 1 }) +
    frame('delta', { text: '你好' }) +
    frame('done', { requestId: 'r1' });

  it('yields the same events regardless of where chunks are split', () => {
    const whole = feedInPieces(body, body.length);
    expect(whole.map(e => e.event)).toEqual(['meta', 'status', 'delta', 'done']);

    for (const size of [1, 2, 3, 7, 17, 64]) {
      expect(feedInPieces(body, size), `size ${size}`).toEqual(whole);
    }
  });

  it('handles several events arriving in one chunk', () => {
    const parser = new SseParser();
    const events = parser.push(body);
    expect(events).toHaveLength(4);
    expect(eventPayload(events[2])).toEqual({ text: '你好' });
  });

  it('handles CRLF frames and mixed line endings', () => {
    const crlf = frame('delta', { text: 'a' }, '\r\n') + frame('delta', { text: 'b' });
    const parser = new SseParser();
    const events = parser.push(crlf);
    expect(events.map(e => eventPayload(e)?.text)).toEqual(['a', 'b']);
  });

  it('ignores comment heartbeats without emitting an event', () => {
    const parser = new SseParser();
    expect(parser.push(': keep-alive\n\n')).toEqual([]);
    expect(parser.push(frame('delta', { text: 'x' }))).toHaveLength(1);
  });

  it('skips a malformed payload instead of throwing', () => {
    const parser = new SseParser();
    const events = parser.push('event: delta\ndata: {not json\n\n' + frame('delta', { text: 'ok' }));
    expect(events).toHaveLength(2);
    expect(eventPayload(events[0])).toBeNull();
    expect(eventPayload(events[1])).toEqual({ text: 'ok' });
  });

  it('joins multi-line data fields', () => {
    const parser = new SseParser();
    const [event] = parser.push('event: delta\ndata: {"text":\ndata: "多行"}\n\n');
    expect(eventPayload(event)).toEqual({ text: '多行' });
  });

  it('does not emit an incomplete trailing frame until flushed', () => {
    const parser = new SseParser();
    expect(parser.push('event: delta\ndata: {"text":"部分"}')).toEqual([]);
    expect(parser.flush().map(e => eventPayload(e)?.text)).toEqual(['部分']);
  });
});
