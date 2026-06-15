/**
 * @fileoverview Shared HTTP layer for the protein data providers. Wraps the
 * framework's `fetchWithTimeout` + `withRetry` (retry covers the full fetch +
 * parse pipeline) and centralizes HTML-error-page / empty-body detection so each
 * service stays thin. The single `Context → RequestContext` cast the framework
 * utilities expect is isolated here.
 * @module services/shared/http
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import { serializationError, serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
import { fetchWithTimeout, type RequestContext, withRetry } from '@cyanheads/mcp-ts-core/utils';

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

/**
 * The framework HTTP utilities type their context parameter as `RequestContext`;
 * the handler `Context` is runtime-compatible (the logger strips non-serializable
 * fields). Cast once here so callers pass `ctx` unchanged.
 */
function asRequestContext(ctx: Context): RequestContext {
  return ctx as unknown as RequestContext;
}

/** Options shared by the JSON/text fetch helpers. */
export interface FetchOptions {
  /** Base retry backoff. Default 400ms. */
  baseDelayMs?: number;
  /** Request body (pre-serialized JSON string, FormData, etc.). */
  body?: RequestInit['body'];
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

/** GET/POST JSON with retry over the full fetch + parse pipeline. Throws a status-mapped `McpError` on non-2xx. */
export function fetchJson<T>(url: string, ctx: Context, opts: FetchOptions): Promise<T> {
  const rctx = asRequestContext(ctx);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return withRetry(
    async () => {
      const res = await fetchWithTimeout(url, timeoutMs, rctx, {
        method: opts.method ?? 'GET',
        ...(opts.body !== undefined && { body: opts.body }),
        headers: withDefaultHeaders(opts.headers),
        signal: ctx.signal,
      });
      return parseJson<T>(await res.text(), opts.label);
    },
    {
      operation: opts.operation,
      context: rctx,
      baseDelayMs: opts.baseDelayMs ?? 400,
      ...(opts.maxRetries !== undefined && { maxRetries: opts.maxRetries }),
      signal: ctx.signal,
    },
  );
}

/** Fetch raw text (coordinate files, etc.) with retry. Throws a status-mapped `McpError` on non-2xx. */
export function fetchText(url: string, ctx: Context, opts: FetchOptions): Promise<string> {
  const rctx = asRequestContext(ctx);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return withRetry(
    async () => {
      const res = await fetchWithTimeout(url, timeoutMs, rctx, {
        method: opts.method ?? 'GET',
        ...(opts.body !== undefined && { body: opts.body }),
        headers: withDefaultHeaders(opts.headers),
        signal: ctx.signal,
      });
      return res.text();
    },
    {
      operation: opts.operation,
      context: rctx,
      baseDelayMs: opts.baseDelayMs ?? 400,
      ...(opts.maxRetries !== undefined && { maxRetries: opts.maxRetries }),
      signal: ctx.signal,
    },
  );
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
  const rctx = asRequestContext(ctx);
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
      context: rctx,
      baseDelayMs: opts.baseDelayMs ?? 400,
      maxRetries: opts.maxRetries ?? 2,
      signal: ctx.signal,
    },
  );
}
