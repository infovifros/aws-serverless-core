// ─── Tracing / correlation headers ───────────────────────────────────────────

/**
 * Standardised set of tracing and application-identity headers that every
 * inbound API Gateway request must carry after normalisation.
 *
 * Unknown headers pass through under the index signature and are not stripped.
 */
export interface NormalizedRequestHeaders {
  /** Correlates a single business transaction across multiple service calls. */
  'x-transaction-request-id': string;
  /** Unique identifier generated per Lambda invocation for internal tracing. */
  'x-tracer-api-request-id': string;
  /** Name of the upstream application that originated the request. */
  'x-remote-application-name': string;
  /** Client application name as reported by the caller. */
  'x-app-name': string;
  /** Client application version as reported by the caller. */
  'x-app-version': string;
  /** Opaque caller identity token forwarded from the client. */
  'x-user-token': string;
  /** Catch-all for any additional HTTP headers forwarded by API Gateway. */
  [additionalHeaderKey: string]: string | undefined;
}

// ─── Normalised API request ───────────────────────────────────────────────────

/**
 * Flattened, type-safe request object produced by `APIHandler.localFn()`.
 *
 * Path parameters, query-string parameters, and body fields are merged into
 * the top-level object.  The `headers` key always carries the full set of
 * normalised tracing headers.
 */
export interface NormalizedApiRequest {
  headers: NormalizedRequestHeaders;
  [additionalFieldKey: string]: unknown;
}

// ─── Legacy ───────────────────────────────────────────────────────────────────

/**
 * @deprecated Use `NormalizedApiRequest` instead.
 * Kept for backward compatibility with existing consumers.
 */
export interface Request {
  headers: {
    'x-transaction-request-id'?: string;
    'x-remote-application-name'?: string;
  };
}
