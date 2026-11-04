/**
 * @fileoverview Shared HTTP layer for the protein data providers. Wraps the
 * framework's `fetchWithTimeout` + `withRetry` (retry covers the full fetch +
 * parse pipeline) and centralizes HTML-error-page / empty-body detection so each
 * service stays thin. Bounded text reads stream a body and cancel it once the
 * caller holds what it needs, for files too large to download whole.
 * @module services/shared/http
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import { serializationError, serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
import { fetchWithTimeout, withRetry } from '@cyanheads/mcp-ts-core/utils';

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Identify this client to upstream providers. Node's global `fetch` sends no
 * User-Agent by default, which some providers' edge WAFs reject outright — the
 * AlphaFold DB API returns 403 Forbidden on an absent UA. A stable project UA
 * also lets providers correlate or contact us about heavy traffic.
 */
const USER_AGENT = 'protein-mcp-server (+https://github.com/cyanheads/protein-mcp-server)';

/** Merge the default `User-Agent` under any caller-supplied headers. */
function withDefaultHeaders(headers?: Record<string, string>): Record<string, string> {
  return { 'User-Agent': USER_AGENT, ...headers };
}

/** Options shared by the JSON/text fetch helpers. */
export interface FetchOptions {
  /** Base retry backoff. Default 400ms. */
  baseDelayMs?: number;
  /** Request body (pre-serialized JSON string, FormData, etc.). */
  body?: RequestInit['body'];
  /**
   * Non-2xx statuses this caller treats as an outcome rather than a failure
   * (e.g. 404 → "no such record"). They still throw a status-mapped `McpError`
   * for the caller to branch on, but log at `debug` instead of `error`.
   */
  expectedStatuses?: number[];
  /** Request headers. */
  headers?: Record<string, string>;
  /** Human-readable provider label used in error messages. */
  label: string;
  /** Retry attempts after the initial call. Default 3. */
  maxRetries?: number;
  /** HTTP method. Default `GET`. */
  method?: string;
  /** Operation label for correlated retry logging. */
  operation: string;
  /** Per-attempt timeout. Default 30s. */
  timeoutMs?: number;
}

/**
 * Parse a JSON body, first rejecting HTML error pages and empty responses as
 * transient `ServiceUnavailable` (so `withRetry` retries them rather than feeding
 * an HTML page into `JSON.parse`).
 */
export function parseJson<T>(text: string, label: string): T {
  if (/^\s*<(!DOCTYPE\s+html|html[\s>])/i.test(text)) {
    throw serviceUnavailable(
      `${label} returned HTML instead of JSON — likely unavailable or rate-limited.`,
    );
  }
  if (text.trim().length === 0) {
    throw serviceUnavailable(
      `${label} returned an empty response — endpoint may be temporarily unavailable.`,
    );
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw serializationError(`${label} returned unparseable JSON: ${text.slice(0, 200)}`);
  }
}

/**
 * GET/POST JSON with retry over the full fetch + parse pipeline. Throws a
 * status-mapped `McpError` on non-2xx. Pass `onEmptyBody` to resolve a 204 / empty
 * body to a value instead of the default transient-failure throw — used by the
 * RCSB search layer, where the API answers a zero-result query with `204 No
 * Content` rather than an empty hit list.
 */
export function fetchJson<T>(
  url: string,
  ctx: Context,
  opts: FetchOptions & { onEmptyBody?: () => T },
): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return withRetry(
    async () => {
      const res = await fetchWithTimeout(url, timeoutMs, ctx, {
        method: opts.method ?? 'GET',
        ...(opts.body !== undefined && { body: opts.body }),
        ...(opts.expectedStatuses && { expectedStatuses: opts.expectedStatuses }),
        headers: withDefaultHeaders(opts.headers),
        signal: ctx.signal,
      });
      const text = await res.text();
      if (opts.onEmptyBody && (res.status === 204 || text.trim().length === 0)) {
        return opts.onEmptyBody();
      }
      return parseJson<T>(text, opts.label);
    },
    {
      operation: opts.operation,
      context: ctx,
      baseDelayMs: opts.baseDelayMs ?? 400,
      ...(opts.maxRetries !== undefined && { maxRetries: opts.maxRetries }),
      signal: ctx.signal,
    },
  );
}

/** Fetch raw text (coordinate files, etc.) with retry. Throws a status-mapped `McpError` on non-2xx. */
export function fetchText(url: string, ctx: Context, opts: FetchOptions): Promise<string> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return withRetry(
    async () => {
      const res = await fetchWithTimeout(url, timeoutMs, ctx, {
        method: opts.method ?? 'GET',
        ...(opts.body !== undefined && { body: opts.body }),
        ...(opts.expectedStatuses && { expectedStatuses: opts.expectedStatuses }),
        headers: withDefaultHeaders(opts.headers),
        signal: ctx.signal,
      });
      return res.text();
    },
    {
      operation: opts.operation,
      context: ctx,
      baseDelayMs: opts.baseDelayMs ?? 400,
      ...(opts.maxRetries !== undefined && { maxRetries: opts.maxRetries }),
      signal: ctx.signal,
    },
  );
}

/**
 * Stream a text body to `onChunk`, decoded as UTF-8, until the body ends or
 * `onChunk` returns `false`; the rest of the body is then cancelled, never
 * downloaded. Upstreams that ignore `Range` and send no `Content-Length` can
 * only be bounded this way. Retries cover reaching a 2xx response: chunks
 * already handed to `onChunk` cannot be taken back, so a body that fails
 * mid-read rejects. Throws a status-mapped `McpError` on non-2xx.
 */
export async function streamText(
  url: string,
  ctx: Context,
  opts: FetchOptions,
  onChunk: (chunk: string) => boolean,
): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const res = await withRetry(
    () =>
      fetchWithTimeout(url, timeoutMs, ctx, {
        method: opts.method ?? 'GET',
        ...(opts.body !== undefined && { body: opts.body }),
        ...(opts.expectedStatuses && { expectedStatuses: opts.expectedStatuses }),
        headers: withDefaultHeaders(opts.headers),
        signal: ctx.signal,
      }),
    {
      operation: opts.operation,
      context: ctx,
      baseDelayMs: opts.baseDelayMs ?? 400,
      ...(opts.maxRetries !== undefined && { maxRetries: opts.maxRetries }),
      signal: ctx.signal,
    },
  );
  if (!res.body) return;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      const tail = decoder.decode();
      if (tail) onChunk(tail);
      return;
    }
    const chunk = decoder.decode(value, { stream: true });
    if (chunk && !onChunk(chunk)) {
      await reader.cancel();
      return;
    }
  }
}

/**
 * One window of a text body: characters `[offset, offset + length)`, shorter or
 * empty where the body ends first. A window the body ends within (`more: false`)
 * was read to the end, so it also knows the body's length in characters.
 */
export type TextWindow =
  | { more: true; text: string }
  | { more: false; text: string; totalLength: number };

/**
 * Read characters `[offset, offset + length)` of a text body. The read stops
 * once it has seen one character past the window — enough to say whether the
 * body continues — and keeps only the window's characters, so the download ends
 * near `offset + length + 1` characters and memory stays at the window,
 * whatever the size of the file. Retry semantics follow {@link streamText}.
 */
export async function fetchTextWindow(
  url: string,
  ctx: Context,
  opts: FetchOptions & { length: number; offset: number },
): Promise<TextWindow> {
  const stopAt = opts.offset + opts.length + 1;
  let seen = 0;
  let held = '';
  await streamText(url, ctx, opts, (chunk) => {
    const start = seen;
    seen += chunk.length;
    if (seen > opts.offset) held += chunk.slice(Math.max(0, opts.offset - start), stopAt - start);
    return seen < stopAt;
  });
  // Holding the character past the window means the body reached it; otherwise
  // the body ended first and `seen` is its whole length.
  return held.length > opts.length
    ? { more: true, text: held.slice(0, opts.length) }
    : { more: false, text: held, totalLength: seen };
}

/**
 * Fetch returning the raw `Response` without throwing on non-2xx status, so the
 * caller can branch on the code (e.g. 3D-Beacons 404 → "no models", an async poll
 * 404 → "not ready yet"). Retries only network-level failures; HTTP statuses pass
 * through. Combines `ctx.signal` with a per-attempt timeout.
 */
export function fetchResponse(
  url: string,
  ctx: Context,
  opts: {
    method?: string;
    body?: RequestInit['body'];
    headers?: Record<string, string>;
    operation: string;
    timeoutMs?: number;
    baseDelayMs?: number;
    maxRetries?: number;
  },
): Promise<Response> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return withRetry(
    () => {
      const signal = AbortSignal.any([ctx.signal, AbortSignal.timeout(timeoutMs)]);
      return fetch(url, {
        method: opts.method ?? 'GET',
        ...(opts.body !== undefined && { body: opts.body }),
        headers: withDefaultHeaders(opts.headers),
        signal,
      });
    },
    {
      operation: opts.operation,
      context: ctx,
      baseDelayMs: opts.baseDelayMs ?? 400,
      maxRetries: opts.maxRetries ?? 2,
      signal: ctx.signal,
    },
  );
}
