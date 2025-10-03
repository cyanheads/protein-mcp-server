/**
 * @fileoverview Provides a utility function to make fetch requests with a specified timeout.
 * @module src/utils/network/fetchWithTimeout
 */
import { JsonRpcErrorCode, McpError } from '@/types-global/errors.js';
import { logger } from '@/utils/internal/logger.js';
import type { RequestContext } from '@/utils/internal/requestContext.js';

/**
 * Options for the fetchWithTimeout utility.
 * Extends standard RequestInit and includes timeout.
 */
export interface FetchWithTimeoutOptions extends Omit<RequestInit, 'signal'> {
  timeout?: number;
}

/**
 * Fetches a resource with a specified timeout.
 * Supports two calling patterns:
 * 1. fetchWithTimeout(url, timeoutMs, context, options) - explicit timeout
 * 2. fetchWithTimeout(url, options) - timeout in options.timeout
 *
 * @param url - The URL to fetch.
 * @param timeoutMsOrOptions - The timeout duration in milliseconds OR options object with timeout.
 * @param context - The request context for logging (optional if options includes timeout).
 * @param options - Optional fetch options (RequestInit), excluding 'signal'.
 * @returns A promise that resolves to the Response object.
 * @throws {McpError} If the request times out or another fetch-related error occurs.
 */
export async function fetchWithTimeout(
  url: string | URL,
  timeoutMsOrOptions: number | FetchWithTimeoutOptions,
  context?: RequestContext,
  options?: Omit<FetchWithTimeoutOptions, 'timeout'>,
): Promise<Response> {
  // Handle both calling patterns
  let timeoutMs: number;
  let fetchOptions: Omit<FetchWithTimeoutOptions, 'timeout'>;
  let requestContext: RequestContext | undefined;

  if (typeof timeoutMsOrOptions === 'number') {
    // Pattern 1: fetchWithTimeout(url, timeoutMs, context, options)
    timeoutMs = timeoutMsOrOptions;
    requestContext = context;
    fetchOptions = options ?? {};
  } else {
    // Pattern 2: fetchWithTimeout(url, { ...options, timeout })
    const { timeout, ...restOptions } = timeoutMsOrOptions;
    timeoutMs = timeout ?? 30000; // Default 30s
    fetchOptions = restOptions;
    requestContext = context;
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  const urlString = url.toString();
  const operationDescription = `fetch ${fetchOptions?.method ?? 'GET'} ${urlString}`;

  if (requestContext) {
    logger.debug(
      `Attempting ${operationDescription} with ${timeoutMs}ms timeout.`,
      requestContext,
    );
  }

  try {
    const response = await fetch(url, {
      ...fetchOptions,
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    if (requestContext) {
      logger.debug(
        `Successfully fetched ${urlString}. Status: ${response.status}`,
        requestContext,
      );
    }

    // Check if the response is not ok (status outside 200-299)
    if (!response.ok) {
      if (requestContext) {
        logger.error(
          `Fetch failed for ${urlString} with status ${response.status}.`,
          {
            ...requestContext,
            errorSource: 'FetchHttpError',
            statusCode: response.status,
            statusText: response.statusText,
          },
        );
      }
      throw new McpError(
        JsonRpcErrorCode.ServiceUnavailable,
        `HTTP error! Status: ${response.status} ${response.statusText}`,
        requestContext
          ? {
              ...requestContext,
              errorSource: 'FetchHttpError',
              statusCode: response.status,
              statusText: response.statusText,
            }
          : {
              errorSource: 'FetchHttpError',
              statusCode: response.status,
              statusText: response.statusText,
            },
      );
    }

    return response;
  } catch (error) {
    clearTimeout(timeoutId);
    if (error instanceof Error && error.name === 'AbortError') {
      if (requestContext) {
        logger.error(
          `${operationDescription} timed out after ${timeoutMs}ms.`,
          {
            ...requestContext,
            errorSource: 'FetchTimeout',
          },
        );
      }
      throw new McpError(
        JsonRpcErrorCode.Timeout,
        `${operationDescription} timed out.`,
        requestContext
          ? { ...requestContext, errorSource: 'FetchTimeout' }
          : { errorSource: 'FetchTimeout' },
      );
    }

    // Log and re-throw other errors as McpError
    const errorMessage = error instanceof Error ? error.message : String(error);
    if (requestContext) {
      logger.error(
        `Network error during ${operationDescription}: ${errorMessage}`,
        {
          ...requestContext,
          originalErrorName:
            error instanceof Error ? error.name : 'UnknownError',
          errorSource: 'FetchNetworkError',
        },
      );
    }

    if (error instanceof McpError) {
      // If it's already an McpError, re-throw it
      throw error;
    }

    throw new McpError(
      JsonRpcErrorCode.ServiceUnavailable,
      `Network error during ${operationDescription}: ${errorMessage}`,
      requestContext
        ? {
            ...requestContext,
            originalErrorName:
              error instanceof Error ? error.name : 'UnknownError',
            errorSource: 'FetchNetworkErrorWrapper',
          }
        : {
            originalErrorName:
              error instanceof Error ? error.name : 'UnknownError',
            errorSource: 'FetchNetworkErrorWrapper',
          },
    );
  }
}
