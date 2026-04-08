// ─── Lambda Response ──────────────────────────────────────────────────────────

/**
 * Optional response modifiers returned alongside the handler body.
 * Headers are merged into the final API Gateway response headers.
 */
export interface LambdaResponseOptions {
  /** Additional HTTP response headers to merge into the API Gateway response. */
  headers?: Record<string, string>;
  /** Controls whether the response body is included in the handler log output. */
  logger?: LambdaResponseLogger;
}

/** Shape of the serialised response passed back to the API Gateway runtime. */
export interface LambdaResponse {
  body: string | null;
  statusCode: number;
  options?: LambdaResponseOptions;
}

/** Controls how the response body is surfaced in Lambda logs. */
export enum LambdaResponseLogger {
  /** Omit the response body from log output (e.g. for large or sensitive payloads). */
  Hide = 'hide',
}

// ─── Resources ───────────────────────────────────────────────────────────────

/**
 * Named resources that can be injected into a handler function via
 * `resourcesToLoad`.  Extend this enum as new shared dependencies are added.
 */
export enum Resources {
  DYNAMODB = 'dynamodb',
  LOGGER = 'logger',
  STATUS_CODES = 'statusCodes',
  UUIDV4 = 'uuidv4',
}

/**
 * Typed resource map injected as the last argument to every handler function.
 * Keys are `Resources` enum values; values are the concrete instances.
 */
export type ResourceMap = Partial<Record<Resources, unknown>>;

/**
 * Options accepted by `APIHandler`, `EventSQSHandler`, and `APIAsyncHandler`
 * constructors.
 */
export interface HandlerOptions {
  /** JSON Schema object compiled by AJV to validate the incoming request. */
  schemaValidator?: object;
  /** List of shared resources to instantiate and inject into the handler. */
  resourcesToLoad?: Resources[];
}

// ─── Errors ───────────────────────────────────────────────────────────────────

/**
 * Structured error message used when the error carries both a machine-readable
 * key and a human-readable description.
 */
export interface ErrorMessage {
  errorKey: string | number;
  errorMessage: string;
}

/**
 * Payload published to the SNS error-alert topic when an unhandled
 * `HandlerError` is caught during Lambda execution.
 */
export interface SnsErrorPayload {
  /** Stack trace string, present only when `captureStackTraceFlag` is `true`. */
  stack?: string;
  message: string;
  name: string;
  statusCode: number;
  /** Value of the `SERVICE_NAME` environment variable, used for triage routing. */
  projectName: string;
  /** JSON-serialised, sanitised copy of the triggering Lambda event. */
  event: string;
}
