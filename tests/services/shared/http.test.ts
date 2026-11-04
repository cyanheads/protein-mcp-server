/**
 * @fileoverview Tests for the shared HTTP layer: parseJson — the
 * HTML-error-page / empty-body guard that keeps an HTML rate-limit page or a
 * blank response from reaching JSON.parse, with the transient-vs-permanent
 * error classification each branch produces — fetchJson's empty-body handling,
 * and the bounded text reads (streamText, fetchTextWindow) that stop a download
 * once the caller holds what it needs.
 * @module tests/services/shared/http.test
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchJson, fetchTextWindow, parseJson, streamText } from '@/services/shared/http.js';

describe('parseJson', () => {
  it('parses a well-formed JSON object', () => {
    expect(parseJson<{ a: number }>('{"a":1}', 'Test API')).toEqual({ a: 1 });
  });

  it('parses a JSON array', () => {
    expect(parseJson<number[]>('[1,2,3]', 'Test API')).toEqual([1, 2, 3]);
  });

  it.each([
    ['<!DOCTYPE html><html><body>503</body></html>'],
    ['<html><head><title>429</title></head></html>'],
    ['  \n  <HTML>rate limited</HTML>'],
  ])('rejects an HTML error page as ServiceUnavailable: %s', (html) => {
    try {
      parseJson(html, 'RCSB Search API');
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(McpError);
      expect((err as McpError).code).toBe(JsonRpcErrorCode.ServiceUnavailable);
      expect((err as McpError).message).toContain('RCSB Search API');
    }
  });

  it.each(['', '   ', '\n\t  \n'])(
    'rejects an empty/whitespace body as ServiceUnavailable: %j',
    (body) => {
      expect(() => parseJson(body, 'AlphaFold DB')).toThrow(McpError);
      expect(() => parseJson(body, 'AlphaFold DB')).toThrowError(/empty response/i);
    },
  );

  it('rejects unparseable JSON as SerializationError, truncating the snippet', () => {
    const garbage = `not json ${'x'.repeat(500)}`;
    try {
      parseJson(garbage, 'UniProt');
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(McpError);
      expect((err as McpError).code).toBe(JsonRpcErrorCode.SerializationError);
      // The error embeds only the first 200 chars of the offending body.
      expect((err as McpError).message.length).toBeLessThan(300);
    }
  });

  it('does not misclassify JSON whose string values contain HTML', () => {
    const payload = JSON.stringify({ note: '<html> inside a value is fine' });
    expect(parseJson<{ note: string }>(payload, 'Test API')).toEqual({
      note: '<html> inside a value is fine',
    });
  });
});

describe('fetchJson — onEmptyBody (204 / empty search response)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('resolves a 204 to the onEmptyBody value without retrying', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(null, { status: 204 }));
    const out = await fetchJson<{ empty: boolean }>('https://search.test', createMockContext(), {
      operation: 'test',
      label: 'RCSB Search API',
      onEmptyBody: () => ({ empty: true }),
    });
    expect(out).toEqual({ empty: true });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('resolves an empty 200 body to the onEmptyBody value', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('   ', { status: 200 }));
    const out = await fetchJson<string>('https://search.test', createMockContext(), {
      operation: 'test',
      label: 'RCSB Search API',
      onEmptyBody: () => 'empty',
    });
    expect(out).toBe('empty');
  });

  it('still throws ServiceUnavailable on an empty body when onEmptyBody is absent', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 204 }));
    await expect(
      fetchJson('https://x.test', createMockContext(), {
        operation: 'test',
        label: 'AlphaFold DB',
        maxRetries: 0,
      }),
    ).rejects.toMatchObject({ code: JsonRpcErrorCode.ServiceUnavailable });
  });
});

describe('bounded text reads', () => {
  afterEach(() => vi.restoreAllMocks());

  const FILE_URL = 'https://files.test/download/1ABC.cif';
  const READ = { operation: 'test', label: 'Coordinate file', maxRetries: 0 };

  /**
   * A body of `bytes` served in `chunkSize` pieces with no read-ahead, recording
   * how many bytes the reader pulled and whether it cancelled the rest.
   */
  function trackedBody(bytes: Uint8Array, chunkSize: number) {
    const state = { pulled: 0, cancelled: false };
    const stream = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          if (state.pulled >= bytes.length) {
            controller.close();
            return;
          }
          const chunk = bytes.slice(state.pulled, state.pulled + chunkSize);
          state.pulled += chunk.length;
          controller.enqueue(chunk);
        },
        cancel() {
          state.cancelled = true;
        },
      },
      { highWaterMark: 0 },
    );
    return { stream, state };
  }

  /** Serve `body` for the file host only; any other host is an unrouted request. */
  function serve(body: ReadableStream<Uint8Array> | string, status = 200) {
    return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.hostname !== 'files.test') throw new Error(`Unrouted request: ${url.href}`);
      return new Response(body, { status });
    });
  }

  const encode = (text: string) => new TextEncoder().encode(text);
  /** Distinct characters at every position, so a misplaced slice cannot pass. */
  const sample = (length: number) =>
    Array.from({ length }, (_, i) => String.fromCharCode(33 + (i % 90))).join('');

  it('returns the window and stops reading one character past it', async () => {
    const text = sample(1_000_000);
    const body = trackedBody(encode(text), 1_000);
    serve(body.stream);
    const window = await fetchTextWindow(FILE_URL, createMockContext(), {
      ...READ,
      offset: 48_000,
      length: 24_000,
    });

    expect(window).toEqual({ more: true, text: text.slice(48_000, 72_000) });
    expect(body.state.cancelled).toBe(true);
    // Downloaded through the chunk holding character 72,001, plus at most one
    // chunk the fetch layer's pass-through pulls ahead.
    expect(body.state.pulled).toBeGreaterThanOrEqual(72_001);
    expect(body.state.pulled).toBeLessThanOrEqual(72_001 + 2 * 1_000);
  });

  it('returns a final short window with the body length, reading to the end', async () => {
    const text = sample(69_506);
    const body = trackedBody(encode(text), 4_096);
    serve(body.stream);
    const window = await fetchTextWindow(FILE_URL, createMockContext(), {
      ...READ,
      offset: 48_000,
      length: 24_000,
    });

    expect(window).toEqual({ more: false, text: text.slice(48_000), totalLength: 69_506 });
    expect(body.state.pulled).toBe(69_506);
  });

  it('reports a body exactly the window long as complete, not continuing', async () => {
    const text = sample(24_000);
    serve(text);
    const window = await fetchTextWindow(FILE_URL, createMockContext(), {
      ...READ,
      offset: 0,
      length: 24_000,
    });
    expect(window).toEqual({ more: false, text, totalLength: 24_000 });
  });

  it.each([69_506, 90_000])(
    'returns no text and the body length at offset %i, at or past the end',
    async (offset) => {
      serve(sample(69_506));
      const window = await fetchTextWindow(FILE_URL, createMockContext(), {
        ...READ,
        offset,
        length: 24_000,
      });
      expect(window).toEqual({ more: false, text: '', totalLength: 69_506 });
    },
  );

  it('decodes a multi-byte character split across chunks intact', async () => {
    // "Å" is two bytes in UTF-8; a 3-byte chunk size splits it.
    const text = 'Resolution 1.5 Å\nÅÅÅ end';
    serve(trackedBody(encode(text), 3).stream);
    const window = await fetchTextWindow(FILE_URL, createMockContext(), {
      ...READ,
      offset: 0,
      length: 1_000,
    });
    expect(window).toEqual({ more: false, text, totalLength: text.length });
  });

  it('throws the status-mapped error for a non-2xx file without reading a body', async () => {
    const fetchSpy = serve('missing', 404);
    await expect(
      fetchTextWindow(FILE_URL, createMockContext(), { ...READ, offset: 0, length: 10 }),
    ).rejects.toMatchObject({ code: JsonRpcErrorCode.NotFound });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('streamText cancels the body as soon as the consumer stops, and reads to the end otherwise', async () => {
    const text = sample(50_000);
    const stopped = trackedBody(encode(text), 1_000);
    serve(stopped.stream);
    let seen = 0;
    await streamText(FILE_URL, createMockContext(), READ, (chunk) => {
      seen += chunk.length;
      return seen < 5_000;
    });
    expect(stopped.state.cancelled).toBe(true);
    expect(stopped.state.pulled).toBeLessThanOrEqual(5_000 + 2 * 1_000);

    vi.restoreAllMocks();
    const whole = trackedBody(encode(text), 1_000);
    serve(whole.stream);
    const parts: string[] = [];
    await streamText(FILE_URL, createMockContext(), READ, (chunk) => {
      parts.push(chunk);
      return true;
    });
    expect(parts.join('')).toBe(text);
    expect(whole.state.cancelled).toBe(false);
  });
});
