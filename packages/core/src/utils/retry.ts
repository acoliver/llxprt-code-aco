/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 * @plan PLAN-20250909-TOKTRACK.P08
 */

import { DebugLogger } from '../debug/index.js';

export interface HttpError extends Error {
  status?: number;
}

export interface RetryOptions {
  maxAttempts: number;
  initialDelayMs: number;
  maxDelayMs: number;
  shouldRetry: (error: Error) => boolean;
  trackThrottleWaitTime?: (waitTimeMs: number) => void;
}

const DEFAULT_RETRY_OPTIONS: RetryOptions = {
  maxAttempts: 5,
  initialDelayMs: 5000,
  maxDelayMs: 30000, // 30 seconds
  shouldRetry: defaultShouldRetry,
};

export const STREAM_INTERRUPTED_ERROR_CODE = 'LLXPRT_STREAM_INTERRUPTED';

const TRANSIENT_ERROR_PHRASES = [
  'connection error',
  'connection terminated',
  'connection reset',
  'socket hang up',
  'socket hung up',
  'socket closed',
  'socket timeout',
  'network timeout',
  'network error',
  'fetch failed',
  'request aborted',
  'request timeout',
  'stream closed',
  'stream prematurely closed',
  'read econnreset',
  'write econnreset',
];

const TRANSIENT_ERROR_REGEXES = [
  /econn(reset|refused|aborted)/i,
  /etimedout/i,
  /und_err_(socket|connect|headers_timeout|body_timeout)/i,
  /tcp connection.*(reset|closed)/i,
];

const TRANSIENT_ERROR_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ECONNABORTED',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'ETIMEDOUT',
  'EPIPE',
  'EAI_AGAIN',
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  STREAM_INTERRUPTED_ERROR_CODE,
]);

function collectErrorDetails(error: unknown): {
  messages: string[];
  codes: string[];
} {
  const messages: string[] = [];
  const codes: string[] = [];
  const stack: unknown[] = [error];
  const visited = new Set<unknown>();

  while (stack.length > 0) {
    const current = stack.pop();
    if (current === null || current === undefined) {
      continue;
    }

    if (typeof current === 'string') {
      messages.push(current);
      continue;
    }

    if (typeof current !== 'object') {
      continue;
    }

    if (visited.has(current)) {
      continue;
    }
    visited.add(current);

    const errorObject = current as {
      message?: unknown;
      code?: unknown;
      cause?: unknown;
      originalError?: unknown;
      error?: unknown;
    };

    if ('message' in errorObject && typeof errorObject.message === 'string') {
      messages.push(errorObject.message);
    }
    if ('code' in errorObject && typeof errorObject.code === 'string') {
      codes.push(errorObject.code);
    }

    const possibleNestedErrors = [
      errorObject.cause,
      errorObject.originalError,
      errorObject.error,
    ];
    for (const nested of possibleNestedErrors) {
      if (nested && nested !== current) {
        stack.push(nested);
      }
    }
  }

  return { messages, codes };
}

export function createStreamInterruptionError(
  message: string,
  details?: Record<string, unknown>,
  cause?: unknown,
): Error {
  const error = new Error(message);
  error.name = 'StreamInterruptionError';
  (error as { code?: string }).code = STREAM_INTERRUPTED_ERROR_CODE;
  if (details) {
    (error as { details?: Record<string, unknown> }).details = details;
  }
  if (cause && !(error as { cause?: unknown }).cause) {
    (error as { cause?: unknown }).cause = cause;
  }
  return error;
}

export function getErrorCode(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null) {
    if (
      'code' in error &&
      typeof (error as { code?: unknown }).code === 'string'
    ) {
      return (error as { code: string }).code;
    }

    if (
      'error' in error &&
      typeof (error as { error?: unknown }).error === 'object' &&
      (error as { error?: unknown }).error !== null &&
      'code' in (error as { error?: { code?: unknown } }).error! &&
      typeof (
        (error as { error?: { code?: unknown } }).error as {
          code?: unknown;
        }
      ).code === 'string'
    ) {
      return (
        (error as { error?: { code?: unknown } }).error as {
          code?: string;
        }
      ).code;
    }
  }

  return undefined;
}

export function isNetworkTransientError(error: unknown): boolean {
  const { messages, codes } = collectErrorDetails(error);

  const lowerMessages = messages.map((msg) => msg.toLowerCase());
  if (
    lowerMessages.some((msg) =>
      TRANSIENT_ERROR_PHRASES.some((phrase) => msg.includes(phrase)),
    )
  ) {
    return true;
  }

  if (
    messages.some((msg) =>
      TRANSIENT_ERROR_REGEXES.some((regex) => regex.test(msg)),
    )
  ) {
    return true;
  }

  if (
    codes
      .map((code) => code.toUpperCase())
      .some((code) => TRANSIENT_ERROR_CODES.has(code))
  ) {
    return true;
  }

  return false;
}

/**
 * Default predicate function to determine if a retry should be attempted.
 * Retries on 429 (Too Many Requests) and 5xx server errors.
 * @param error The error object.
 * @returns True if the error is a transient error, false otherwise.
 */
function defaultShouldRetry(error: Error | unknown): boolean {
  // Check for common transient error status codes either in message or a status property
  if (error && typeof (error as { status?: number }).status === 'number') {
    const status = (error as { status: number }).status;
    if (status === 429 || (status >= 500 && status < 600)) {
      return true;
    }
  }
  if (error instanceof Error && error.message) {
    if (error.message.includes('429')) return true;
    if (error.message.match(/5\d{2}/)) return true;
  }

  if (isNetworkTransientError(error)) {
    return true;
  }

  return false;
}

/**
 * Delays execution for a specified number of milliseconds.
 * @param ms The number of milliseconds to delay.
 * @returns A promise that resolves after the delay.
 */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Retries a function with exponential backoff and jitter.
 * @param fn The asynchronous function to retry.
 * @param options Optional retry configuration.
 * @returns A promise that resolves with the result of the function if successful.
 * @throws The last error encountered if all attempts fail.
 */
export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  options?: Partial<RetryOptions>,
): Promise<T> {
  const { maxAttempts, initialDelayMs, maxDelayMs, shouldRetry } = {
    ...DEFAULT_RETRY_OPTIONS,
    ...options,
  };

  const logger = new DebugLogger('llxprt:retry');
  let attempt = 0;
  let currentDelay = initialDelayMs;

  while (attempt < maxAttempts) {
    attempt++;
    try {
      return await fn();
    } catch (error) {
      const errorStatus = getErrorStatus(error);

      // Check if we've exhausted retries or shouldn't retry
      if (attempt >= maxAttempts || !shouldRetry(error as Error)) {
        throw error;
      }

      const { delayDurationMs, errorStatus: delayErrorStatus } =
        getDelayDurationAndStatus(error);

      if (delayDurationMs > 0) {
        // Respect Retry-After header if present and parsed
        logger.debug(
          () =>
            `Attempt ${attempt} failed with status ${delayErrorStatus ?? 'unknown'}. Retrying after explicit delay of ${delayDurationMs}ms... Error: ${error}`,
        );
        await delay(delayDurationMs);
        // Track throttling wait time when explicitly delaying
        if (options?.trackThrottleWaitTime) {
          logger.debug(
            () =>
              `Tracking throttle wait time from Retry-After header: ${delayDurationMs}ms`,
          );
          options.trackThrottleWaitTime(delayDurationMs);
        }
        // Reset currentDelay for next potential non-429 error, or if Retry-After is not present next time
        currentDelay = initialDelayMs;
      } else {
        // Fall back to exponential backoff with jitter
        logRetryAttempt(attempt, error, errorStatus);
        // Add jitter: +/- 30% of currentDelay
        const jitter = currentDelay * 0.3 * (Math.random() * 2 - 1);
        const delayWithJitter = Math.max(0, currentDelay + jitter);
        await delay(delayWithJitter);
        // Track throttling wait time for exponential backoff
        if (options?.trackThrottleWaitTime) {
          logger.debug(
            () =>
              `Tracking throttle wait time from exponential backoff: ${delayWithJitter}ms`,
          );
          options.trackThrottleWaitTime(delayWithJitter);
        }
        currentDelay = Math.min(maxDelayMs, currentDelay * 2);
      }
    }
  }
  // This line should theoretically be unreachable due to the throw in the catch block.
  // Added for type safety and to satisfy the compiler that a promise is always returned.
  throw new Error('Retry attempts exhausted');
}

/**
 * Extracts the HTTP status code from an error object.
 * @param error The error object.
 * @returns The HTTP status code, or undefined if not found.
 */
export function getErrorStatus(error: unknown): number | undefined {
  if (typeof error === 'object' && error !== null) {
    if ('status' in error && typeof error.status === 'number') {
      return error.status;
    }
    // Check for error.response.status (common in axios errors)
    if (
      'response' in error &&
      typeof (error as { response?: unknown }).response === 'object' &&
      (error as { response?: unknown }).response !== null
    ) {
      const response = (
        error as { response: { status?: unknown; headers?: unknown } }
      ).response;
      if ('status' in response && typeof response.status === 'number') {
        return response.status;
      }
    }
  }
  return undefined;
}

/**
 * Extracts the Retry-After delay from an error object's headers.
 * @param error The error object.
 * @returns The delay in milliseconds, or 0 if not found or invalid.
 */
function getRetryAfterDelayMs(error: unknown): number {
  if (typeof error === 'object' && error !== null) {
    // Check for error.response.headers (common in axios errors)
    if (
      'response' in error &&
      typeof (error as { response?: unknown }).response === 'object' &&
      (error as { response?: unknown }).response !== null
    ) {
      const response = (error as { response: { headers?: unknown } }).response;
      if (
        'headers' in response &&
        typeof response.headers === 'object' &&
        response.headers !== null
      ) {
        const headers = response.headers as { 'retry-after'?: unknown };
        const retryAfterHeader = headers['retry-after'];
        if (typeof retryAfterHeader === 'string') {
          const retryAfterSeconds = parseInt(retryAfterHeader, 10);
          if (!isNaN(retryAfterSeconds)) {
            return retryAfterSeconds * 1000;
          }
          // It might be an HTTP date
          const retryAfterDate = new Date(retryAfterHeader);
          if (!isNaN(retryAfterDate.getTime())) {
            return Math.max(0, retryAfterDate.getTime() - Date.now());
          }
        }
      }
    }
  }
  return 0;
}

/**
 * Determines the delay duration based on the error, prioritizing Retry-After header.
 * @param error The error object.
 * @returns An object containing the delay duration in milliseconds and the error status.
 */
function getDelayDurationAndStatus(error: unknown): {
  delayDurationMs: number;
  errorStatus: number | undefined;
} {
  const errorStatus = getErrorStatus(error);
  let delayDurationMs = 0;

  if (errorStatus === 429) {
    delayDurationMs = getRetryAfterDelayMs(error);
  }
  return { delayDurationMs, errorStatus };
}

/**
 * Logs a message for a retry attempt when using exponential backoff.
 * @param attempt The current attempt number.
 * @param error The error that caused the retry.
 * @param errorStatus The HTTP status code of the error, if available.
 */
function logRetryAttempt(
  attempt: number,
  error: unknown,
  errorStatus?: number,
): void {
  const logger = new DebugLogger('llxprt:retry');
  let message = `Attempt ${attempt} failed. Retrying with backoff...`;
  if (errorStatus) {
    message = `Attempt ${attempt} failed with status ${errorStatus}. Retrying with backoff...`;
  }

  if (errorStatus === 429) {
    logger.debug(() => `${message} Error: ${error}`);
  } else if (errorStatus && errorStatus >= 500 && errorStatus < 600) {
    logger.error(() => `${message} Error: ${error}`);
  } else if (error instanceof Error) {
    // Fallback for errors that might not have a status but have a message
    if (error.message.includes('429')) {
      logger.debug(
        () =>
          `Attempt ${attempt} failed with 429 error (no Retry-After header). Retrying with backoff... Error: ${error}`,
      );
    } else if (error.message.match(/5\d{2}/)) {
      logger.error(
        () =>
          `Attempt ${attempt} failed with 5xx error. Retrying with backoff... Error: ${error}`,
      );
    } else {
      logger.debug(() => `${message} Error: ${error}`); // Default to debug for other errors
    }
  } else {
    logger.debug(() => `${message} Error: ${error}`); // Default to debug if error type is unknown
  }
}

// @plan marker: PLAN-20250909-TOKTRACK.P05
