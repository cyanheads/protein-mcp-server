/**
 * @fileoverview Tests for parseJson — the HTML-error-page / empty-body guard that
 * keeps an HTML rate-limit page or a blank response from reaching JSON.parse.
 * Asserts the transient-vs-permanent error classification each branch produces.
 * @module tests/services/shared/http.test
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { describe, expect, it } from 'vitest';
import { parseJson } from '@/services/shared/http.js';

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

  it.each([
    '',
    '   ',
    '\n\t  \n',
  ])('rejects an empty/whitespace body as ServiceUnavailable: %j', (body) => {
    expect(() => parseJson(body, 'AlphaFold DB')).toThrow(McpError);
    expect(() => parseJson(body, 'AlphaFold DB')).toThrowError(/empty response/i);
  });

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
