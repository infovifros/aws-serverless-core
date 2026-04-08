import {StatusCodes} from 'http-status-codes';
import Ajv, {ValidateFunction} from 'ajv';
import addFormats from 'ajv-formats';
import {v4 as uuidv4} from 'uuid';
import {PublishCommand, SNSClient} from '@aws-sdk/client-sns';
import {APIGatewayProxyEvent, Context, SQSEvent} from 'aws-lambda';

import {
  ErrorMessage,
  HandlerOptions,
  LambdaResponse,
  LambdaResponseLogger,
  ResourceMap,
  Resources,
  SnsErrorPayload,
} from '../interfaces/handler.interface';
import {NormalizedApiRequest, NormalizedRequestHeaders} from '../interfaces/request.interface';
import {Logger} from './logger.class';
import {compressAndEncodeGzip} from './compress';

// ─── Module-level shared logger ───────────────────────────────────────────────

const logger = new Logger();

// ─── Internal types ───────────────────────────────────────────────────────────

/**
 * Signature every Lambda handler function must satisfy.
 * Positional arguments are supplied by `localFn()`; the last argument is
 * always the `ResourceMap` injected by `addResourcesFn()`.
 */
type HandlerFunction = (...args: unknown[]) => Promise<HandlerResponse>;

// ─── Internal constants ───────────────────────────────────────────────────────

/**
 * Value expected in the `X-KEEP-LAMBDA-WARN` / `x-keep-lambda-warn` header to
 * trigger a keep-warm early-return without executing any business logic.
 */
const KEEP_LAMBDA_WARM_HEADER_VALUE = 'BBBBBBBBBBBPPPP000' as const;

/**
 * Headers extracted from the raw API Gateway event and replaced with
 * normalised / generated values before being passed to the handler function.
 * The originals are deleted from the forwarded headers object so the handler
 * always reads from a single, canonical source.
 */
const TRACEABLE_HEADER_KEYS = [
  'x-transaction-request-id',
  'x-remote-application-name',
  'x-app-name',
  'x-app-version',
  'x-user-token',
] as const;

// ─── HandlerResponse ─────────────────────────────────────────────────────────

/**
 * Represents a successful response from a Lambda handler function.
 *
 * Every handler function **must** return an instance of this class.
 * `BaseHandler.lambdaHandler()` will throw a `HandlerError` if it receives
 * any other value.
 *
 * @example
 * return new HandlerResponse({ id: '123', name: 'foo' }, StatusCodes.CREATED);
 */
export class HandlerResponse {
  public readonly body: object | string | null;
  public readonly statusCode: number;
  public readonly options: HandlerOptions | undefined;

  constructor(
    body: object | string | null,
    statusCode: number = StatusCodes.OK,
    options?: HandlerOptions,
  ) {
    this.body = body;
    this.statusCode = statusCode;
    this.options = options;
  }
}

// ─── HandlerError ─────────────────────────────────────────────────────────────

/**
 * Structured error thrown within Lambda handler functions to signal an
 * expected failure condition.
 *
 * - `statusCode` maps directly to the HTTP response status returned to the caller.
 * - `alertFlag`  controls whether an SNS alert is published for this error.
 * - `captureStackTraceFlag` controls whether `Error.captureStackTrace` is called;
 *   set to `false` for validation errors where the stack adds no diagnostic value.
 *
 * @example
 * throw new HandlerError('Resource not found', StatusCodes.NOT_FOUND, false, false);
 */
export class HandlerError extends Error {
  public readonly statusCode: number;
  /**
   * `true`  → `Error.captureStackTrace` was called; `error.stack` is populated.
   * `false` → stack trace was intentionally suppressed (e.g. input-validation errors).
   */
  public readonly captureStackTraceFlag: boolean;
  /**
   * `true`  → an SNS alert will be published when this error is caught by `lambdaHandler`.
   * `false` → the error is handled silently (returned to the caller with no alert).
   */
  public readonly alertFlag: boolean;

  constructor(
    message: string | ErrorMessage,
    statusCode: number = StatusCodes.INTERNAL_SERVER_ERROR,
    captureStackTrace: boolean = true,
    alert: boolean = true,
  ) {
    const normalisedMessage =
      typeof message === 'object' ? JSON.stringify(message) : message;

    super(normalisedMessage);
    this.message = normalisedMessage;
    this.statusCode = statusCode;
    this.captureStackTraceFlag = captureStackTrace;
    this.alertFlag = alert;
    this.name = 'HandlerError';

    if (captureStackTrace) {
      Error.captureStackTrace(this, HandlerError);
    }
  }
}

// ─── BaseHandler ─────────────────────────────────────────────────────────────

/**
 * Abstract base class for all AWS Lambda event handlers.
 *
 * Provides the core execution pipeline via `lambdaHandler()` and exposes
 * several protected hooks that subclasses override to adapt the pipeline to a
 * specific event source (API Gateway, SQS, EventBridge, etc.).
 *
 * **Execution order inside `lambdaHandler()`:**
 * 1. Keep-warm ping check — returns early without executing business logic.
 * 2. `load()`             — cold-start config / secret loading (override hook).
 * 3. `localFn()`          — event parsing and normalisation (override hook).
 * 4. `addResourcesFn()`   — shared resource injection (override hook).
 * 5. `handlerFn()`        — business logic provided by the consumer.
 * 6. Response serialisation + optional gzip compression.
 *
 * **Extending for a new event source:**
 * ```typescript
 * export class EventBridgeHandler extends BaseHandler {
 *   protected async localFn(event: EventBridgeEvent<string, unknown>) {
 *     const detail = event.detail;
 *     return [detail, event];
 *   }
 * }
 * ```
 */
class BaseHandler {
  protected readonly handlerFn: HandlerFunction;
  protected readonly ajv: Ajv;
  protected readonly snsClient: SNSClient;

  constructor(handlerFn: HandlerFunction) {
    this.handlerFn = handlerFn;
    this.lambdaHandler = this.lambdaHandler.bind(this);

    this.snsClient = new SNSClient({});

    this.ajv = new Ajv({coerceTypes: true, allErrors: true});
    addFormats(this.ajv);
  }

  // ── Override hooks ─────────────────────────────────────────────────────────

  /**
   * Cold-start initialisation hook.  Called once at the start of every
   * invocation before event parsing begins.
   *
   * Override to load SSM parameters, secrets, feature flags, or any external
   * config that should be resolved at cold start and cached across invocations.
   *
   * @example
   * protected async load(): Promise<void> {
   *   this.config = await ssmLoader.loadByPath('/my-service/');
   * }
   */
  protected async load(): Promise<void> {
    // TODO: implement SSM Parameter Store loader (tracked in backlog)
  }

  /**
   * Event parsing hook.  Transforms the raw Lambda event into a tuple of
   * positional arguments that are spread into `handlerFn()`.
   *
   * Override in every subclass.  The base implementation is a passthrough
   * that returns `[event, context]` unchanged.
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  protected async localFn(event: unknown, context: unknown): Promise<unknown[]> {
    return [event, context];
  }

  /**
   * Resource injection hook.  Returns a `ResourceMap` that is appended as
   * the last argument to `handlerFn()`.
   *
   * Override in subclasses that declare `resourcesToLoad`.  The default
   * implementation returns an empty map.
   *
   * @see `buildResourceMap()` for the shared resource-building logic.
   */
  protected async addResourcesFn(): Promise<ResourceMap> {
    return {};
  }

  // ── Shared utilities ───────────────────────────────────────────────────────

  /**
   * Validates a request payload against a JSON Schema compiled by AJV.
   *
   * Throws a `HandlerError` (HTTP 409) on the first set of validation failures
   * so that the caller receives a structured, actionable error message.
   *
   * @param schemaValidator - AJV-compatible JSON Schema object.
   * @param requestPayload  - The data to validate (object or array).
   */
  protected async validateRequest(
    schemaValidator: object,
    requestPayload: unknown,
  ): Promise<void> {
    const validateFn: ValidateFunction = this.ajv.compile(schemaValidator);
    const isValid = validateFn(requestPayload);

    if (!isValid) {
      logger.error(
        '[BaseHandler.validateRequest] Schema validation failed',
        validateFn.errors,
      );
      throw new HandlerError(
        `Schema Validation Errors ${JSON.stringify(validateFn.errors)}`,
        StatusCodes.CONFLICT,
      );
    }
  }

  /**
   * Builds a `ResourceMap` from the supplied list of `Resources` enum values.
   *
   * Centralising this logic in the base class eliminates the need to duplicate
   * the `switch` block across every handler subclass.
   *
   * @param resourcesToLoad - Resources requested by the handler constructor.
   */
  protected buildResourceMap(resourcesToLoad: Resources[]): ResourceMap {
    const resourceMap: ResourceMap = {};

    for (const resource of resourcesToLoad) {
      switch (resource) {
        case Resources.LOGGER:
          resourceMap[Resources.LOGGER] = logger;
          break;

        case Resources.UUIDV4:
          resourceMap[Resources.UUIDV4] = uuidv4;
          break;

        case Resources.STATUS_CODES:
          resourceMap[Resources.STATUS_CODES] = StatusCodes;
          break;

        case Resources.DYNAMODB:
          // DynamoDB instance is created in its own module.
          // TODO: import and attach DynamoDB instance (tracked in backlog)
          break;
      }
    }

    return resourceMap;
  }

  /**
   * Publishes a structured message to an SNS topic.
   *
   * If the serialised payload exceeds the SNS 256 KB limit the method retries
   * once with an abbreviated fallback message rather than propagating the
   * size-limit error to the caller.
   *
   * @param subject  - SNS subject line (used for routing rules and display).
   * @param payload  - Serialisable key-value payload.
   * @param topicArn - Full ARN of the destination SNS topic.
   */
  protected async sendSNSMessage(
    subject: string,
    payload: Record<string, unknown>,
    topicArn: string,
  ) {
    logger.info('[BaseHandler.sendSNSMessage] Publishing SNS message', {subject, topicArn});

    const publishCommandParams = {
      ActionName: ['Publish'],
      TopicArn: topicArn,
      Label: uuidv4(),
      Subject: subject,
      Message: JSON.stringify(payload),
    };

    try {
      const publishCommand = new PublishCommand(publishCommandParams);
      const snsResponse = await this.snsClient.send(publishCommand);

      logger.debug('[BaseHandler.sendSNSMessage] SNS publish succeeded', snsResponse);
      return snsResponse;
    } catch (snsPublishError: unknown) {
      logger.error('[BaseHandler.sendSNSMessage] SNS publish failed', snsPublishError);

      const awsError = snsPublishError as {Message?: string; errorMessage?: string};
      if (awsError?.Message === 'Invalid parameter: Message too long') {
        publishCommandParams.Message =
          awsError?.errorMessage ??
          'SNS publish failed — payload too large, check CloudWatch logs for full details';

        const retryPublishCommand = new PublishCommand(publishCommandParams);
        return this.snsClient.send(retryPublishCommand);
      }
    }
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  /**
   * Returns `true` when the inbound event carries the keep-warm header value,
   * signalling that the invocation is a scheduled ping and should return early.
   */
  private isKeepLambdaWarmRequest(event: Record<string, unknown>): boolean {
    const incomingHeaders = event?.headers as Record<string, string> | undefined;
    return (
      incomingHeaders?.['X-KEEP-LAMBDA-WARN'] === KEEP_LAMBDA_WARM_HEADER_VALUE ||
      incomingHeaders?.['x-keep-lambda-warn'] === KEEP_LAMBDA_WARM_HEADER_VALUE
    );
  }

  /**
   * Publishes an SNS error alert for an unhandled `HandlerError`, including a
   * sanitised copy of the triggering event with sensitive fields redacted.
   */
  private async sendErrorAlert(
    error: HandlerError,
    rawEvent: Record<string, unknown>,
  ): Promise<void> {
    const sanitisedEvent = this.sanitiseEventForLogging(rawEvent);

    const errorAlertPayload: SnsErrorPayload = {
      stack: error.captureStackTraceFlag ? error.stack : undefined,
      message: error.message,
      name: error.name,
      statusCode: error.statusCode,
      projectName: process.env.SERVICE_NAME ?? 'SERVICE_NAME env variable not set',
      event: JSON.stringify(sanitisedEvent),
    };

    await this.sendSNSMessage(
      'HandlerError — unhandled exception alert',
      errorAlertPayload as unknown as Record<string, unknown>,
      process.env.SNS_TOPIC_ARN_API_ERROR!,
    );
  }

  /**
   * Returns a shallow copy of the Lambda event with sensitive fields replaced
   * by `'<redacted>'` so the event can be safely included in SNS alerts or logs.
   *
   * Redacted fields:
   * - `body.base64`            — may contain large binary payloads
   * - `headers.authorization`  — Bearer / Basic tokens must not leave the function
   */
  private sanitiseEventForLogging(
    rawEvent: Record<string, unknown>,
  ): Record<string, unknown> {
    const sanitisedEvent: Record<string, unknown> = {...rawEvent};

    if (sanitisedEvent.body) {
      const parsedBody: Record<string, unknown> =
        typeof sanitisedEvent.body === 'string'
          ? (JSON.parse(sanitisedEvent.body) as Record<string, unknown>)
          : (sanitisedEvent.body as Record<string, unknown>);

      if (parsedBody?.base64) {
        sanitisedEvent.body = {...parsedBody, base64: '<redacted>'};
      }
    }

    if (sanitisedEvent.headers && typeof sanitisedEvent.headers === 'object') {
      const existingHeaders = sanitisedEvent.headers as Record<string, unknown>;
      if (existingHeaders.authorization) {
        sanitisedEvent.headers = {...existingHeaders, authorization: '<redacted>'};
      }
    }

    return sanitisedEvent;
  }

  /**
   * Processes an error caught during the main execution pipeline and returns a
   * structured API Gateway-compatible error response for known error types.
   *
   * Known error names (`HandlerError`, `ValidationError`, `MongoServerError`)
   * are serialised and returned to the caller.  All other errors are re-thrown
   * so they surface as Lambda function errors in CloudWatch.
   */
  private async handleExecutionError(
    caughtError: unknown,
    rawEvent: Record<string, unknown>,
  ): Promise<{statusCode: number; body: string | null}> {
    const error = caughtError as {
      name?: string;
      message?: string;
      statusCode?: number;
      alertFlag?: boolean;
      captureStackTraceFlag?: boolean;
      stack?: string;
    };

    if (process.env.SNS_TOPIC_ARN_API_ERROR && error?.alertFlag) {
      await this.sendErrorAlert(error as HandlerError, rawEvent);
    }

    switch (error?.name) {
      case 'HandlerError':
      case 'ValidationError':
      case 'MongoServerError':
        return {
          statusCode: error?.statusCode ?? StatusCodes.INTERNAL_SERVER_ERROR,
          body: error?.message ? JSON.stringify(error.message) : null,
        };

      default:
        logger.error('[BaseHandler.lambdaHandler] Unhandled error — re-throwing', error);
        throw caughtError;
    }
  }

  /**
   * Serialises a `HandlerResponse` into a plain `LambdaResponse` object,
   * choosing the correct status code based on the presence of a body.
   */
  private serialiseHandlerResponse(handlerFnResponse: HandlerResponse): LambdaResponse {
    const serialisedResponse: LambdaResponse = {
      statusCode: StatusCodes.OK,
      body: null,
      options: handlerFnResponse.options as LambdaResponse['options'],
    };

    if (!handlerFnResponse.body) {
      serialisedResponse.statusCode = StatusCodes.NO_CONTENT;
    } else if (typeof handlerFnResponse.body === 'string') {
      serialisedResponse.body = handlerFnResponse.body;
      serialisedResponse.statusCode = handlerFnResponse.statusCode;
    } else {
      serialisedResponse.body = JSON.stringify(handlerFnResponse.body);
      serialisedResponse.statusCode = handlerFnResponse.statusCode;
    }

    return serialisedResponse;
  }

  /**
   * Converts a validated `HandlerResponse` into the final API Gateway-compatible
   * response object, applying gzip compression when the caller signals support
   * via the `Accept-Encoding: gzip` request header.
   */
  private async buildLambdaResponse(
    handlerFnResponse: HandlerResponse | null,
    rawEvent: Record<string, unknown>,
  ) {
    if (!(handlerFnResponse instanceof HandlerResponse)) {
      logger.error(
        '[BaseHandler.lambdaHandler] Handler function did not return a HandlerResponse instance',
      );
      throw new HandlerError(
        'The handler function must return a HandlerResponse instance',
      );
    }

    const serialisedResponse = this.serialiseHandlerResponse(handlerFnResponse);

    if (serialisedResponse.options?.logger === LambdaResponseLogger.Hide) {
      logger.info('[BaseHandler.lambdaHandler] Response ready (body hidden by logger option)');
    } else {
      logger.info('[BaseHandler.lambdaHandler] Response ready', {
        statusCode: serialisedResponse.statusCode,
      });
    }

    const acceptEncodingHeader =
      (rawEvent?.headers as Record<string, string> | undefined)?.['accept-encoding'] ?? '';
    let isBase64Encoded = Boolean(serialisedResponse.body && acceptEncodingHeader.includes('gzip'));

    logger.debug('[BaseHandler.lambdaHandler] Compression check', {
      isBase64Encoded,
      acceptEncoding: acceptEncodingHeader,
    });

    if (isBase64Encoded && serialisedResponse.body) {
      try {
        serialisedResponse.body = await compressAndEncodeGzip(serialisedResponse.body);
        logger.info('[BaseHandler.lambdaHandler] Response body compressed with gzip');
      } catch (compressionError: unknown) {
        logger.warn(
          '[BaseHandler.lambdaHandler] Gzip compression failed — sending uncompressed response',
          compressionError,
        );
        isBase64Encoded = false;
      }
    }

    return {
      headers: {
        'content-type': 'application/json',
        ...(isBase64Encoded ? {'content-encoding': 'gzip'} : {}),
        ...(serialisedResponse.options?.headers ?? {}),
      },
      statusCode: serialisedResponse.statusCode,
      body: serialisedResponse.body,
      isBase64Encoded,
    };
  }

  // ── Main Lambda entry point ────────────────────────────────────────────────

  /**
   * AWS Lambda entry-point method.  Bound to `this` in the constructor so it
   * can be exported directly as the Lambda handler:
   * ```typescript
   * export const handler = new APIHandler(myFn).lambdaHandler;
   * ```
   */
  async lambdaHandler(event: Record<string, unknown>, context: unknown) {
    logger.info('[BaseHandler.lambdaHandler] Invocation started');

    if (this.isKeepLambdaWarmRequest(event)) {
      logger.info('[BaseHandler.lambdaHandler] Keep-warm ping received — returning early');
      return {statusCode: StatusCodes.OK, body: ''};
    }

    let handlerFnResponse: HandlerResponse | null = null;

    try {
      await this.load();

      const parsedEventParameters = await this.localFn(event, context);
      const resourceMap = await this.addResourcesFn();

      handlerFnResponse = await this.handlerFn(...parsedEventParameters, resourceMap);
    } catch (caughtError: unknown) {
      return this.handleExecutionError(caughtError, event);
    }

    return this.buildLambdaResponse(handlerFnResponse, event);
  }
}

// ─── APIHandler ───────────────────────────────────────────────────────────────

/**
 * Handler for synchronous API Gateway proxy (REST API, payload format 1.0)
 * events.
 *
 * Parses path parameters, query-string parameters, and the request body into a
 * flat `NormalizedApiRequest` object.  Tracing headers are extracted from the
 * raw request and replaced with normalised / generated values.
 *
 * @example
 * export const handler = new APIHandler(myFn, {
 *   schemaValidator: myJsonSchema,
 *   resourcesToLoad: [Resources.LOGGER, Resources.UUIDV4],
 * }).lambdaHandler;
 */
export class APIHandler extends BaseHandler {
  protected readonly schemaValidator: object | null;
  protected readonly resourcesToLoad: Resources[] | null;

  constructor(handlerFn: HandlerFunction, options?: HandlerOptions) {
    super(handlerFn);
    this.schemaValidator = options?.schemaValidator ?? null;
    this.resourcesToLoad = options?.resourcesToLoad ?? null;
  }

  protected async addResourcesFn(): Promise<ResourceMap> {
    if (!this.resourcesToLoad?.length) return {};
    return this.buildResourceMap(this.resourcesToLoad);
  }

  /**
   * Parses the API Gateway proxy event into a `[NormalizedApiRequest, rawEvent]`
   * tuple.  The normalised request is optionally validated against the handler's
   * JSON Schema before being forwarded to the business-logic function.
   */
  // _context is accepted but unused in the synchronous handler; APIAsyncHandler
  // overrides this signature and uses context to disable the event loop wait.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  protected async localFn(event: APIGatewayProxyEvent, _context?: Context): Promise<unknown[]> {
    const normalisedRequest = this.parseApiGatewayEvent(event);

    logger.info('[APIHandler.localFn] Request parsed', {
      path: event.path,
      httpMethod: event.httpMethod,
      transactionId: normalisedRequest.headers['x-transaction-request-id'],
    });

    if (this.schemaValidator) {
      await this.validateRequest(this.schemaValidator, normalisedRequest);
    }

    return [normalisedRequest, event];
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  /**
   * Merges path parameters, parsed query-string parameters, and the parsed
   * request body into a single flat object and attaches the normalised headers.
   */
  private parseApiGatewayEvent(event: APIGatewayProxyEvent): NormalizedApiRequest {
    const parsedQueryStringParameters = this.parseQueryStringParameters(
      event.queryStringParameters,
    );
    const parsedBody: Record<string, unknown> = event.body
      ? (JSON.parse(event.body) as Record<string, unknown>)
      : {};
    // APIGatewayProxyEvent path parameters are typed as `string | undefined`;
    // undefined entries are filtered out before merging into the request object.
    const resolvedPathParameters: Record<string, string> = Object.fromEntries(
      Object.entries(event.pathParameters ?? {}).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    );
    const rawIncomingHeaders: Record<string, string | undefined> = event.headers ?? {};

    const normalisedTracingHeaders = this.extractNormalisedTracingHeaders(rawIncomingHeaders);
    const remainingPassthroughHeaders = this.stripTracingHeaders(rawIncomingHeaders);

    const mergedHeaders: NormalizedRequestHeaders = {
      ...remainingPassthroughHeaders,
      ...normalisedTracingHeaders,
    };

    return {
      ...parsedBody,
      ...resolvedPathParameters,
      ...parsedQueryStringParameters,
      headers: mergedHeaders,
    };
  }

  /**
   * Attempts to JSON-parse each query-string value.  Falls back to the raw
   * string if parsing fails (e.g. the value is a plain string, not JSON).
   */
  private parseQueryStringParameters(
    rawQueryStringParameters: APIGatewayProxyEvent['queryStringParameters'],
  ): Record<string, unknown> {
    const parsedParameters: Record<string, unknown> = {};

    for (const [paramKey, paramValue] of Object.entries(rawQueryStringParameters ?? {})) {
      if (paramValue === undefined) continue;
      try {
        parsedParameters[paramKey] = JSON.parse(paramValue);
      } catch {
        parsedParameters[paramKey] = paramValue;
      }
    }

    return parsedParameters;
  }

  /**
   * Builds the canonical set of tracing / identity headers.  Missing headers
   * are replaced with generated UUIDs or descriptive fallback strings rather
   * than `undefined`, so the handler always receives a complete set.
   */
  private extractNormalisedTracingHeaders(
    incomingHeaders: Record<string, string | undefined>,
  ): NormalizedRequestHeaders {
    return {
      'x-transaction-request-id':
        incomingHeaders['x-transaction-request-id'] ?? uuidv4(),
      'x-tracer-api-request-id': uuidv4(),
      'x-remote-application-name':
        incomingHeaders['x-remote-application-name'] ?? 'REMOTE_APP_NAME not provided',
      'x-app-name':
        incomingHeaders['x-app-name'] ?? 'APP_NAME not provided',
      'x-app-version':
        incomingHeaders['x-app-version'] ?? 'APP_VERSION not provided',
      'x-user-token':
        incomingHeaders['x-user-token'] ?? 'USER_TOKEN not provided',
    };
  }

  /**
   * Returns a copy of the headers map with all tracing header keys removed.
   * The caller will replace them with the normalised versions from
   * `extractNormalisedTracingHeaders()`.
   */
  private stripTracingHeaders(
    incomingHeaders: Record<string, string | undefined>,
  ): Record<string, string | undefined> {
    const strippedHeaders = {...incomingHeaders};
    for (const traceableHeaderKey of TRACEABLE_HEADER_KEYS) {
      delete strippedHeaders[traceableHeaderKey];
    }
    return strippedHeaders;
  }
}

// ─── EventSQSHandler ──────────────────────────────────────────────────────────

/**
 * Handler for SQS-triggered Lambda events.
 *
 * Iterates over `event.Records`, parses each record's JSON body, and merges
 * the `messageId` into the payload.  The resulting array is passed as the
 * first argument to the handler function.
 *
 * @example
 * export const handler = new EventSQSHandler(myFn, {
 *   schemaValidator: myJsonSchema,
 * }).lambdaHandler;
 */
export class EventSQSHandler extends BaseHandler {
  protected readonly schemaValidator: object | null;
  protected readonly resourcesToLoad: Resources[] | null;

  constructor(handlerFn: HandlerFunction, options?: HandlerOptions) {
    super(handlerFn);
    this.schemaValidator = options?.schemaValidator ?? null;
    this.resourcesToLoad = options?.resourcesToLoad ?? null;
  }

  protected async addResourcesFn(): Promise<ResourceMap> {
    if (!this.resourcesToLoad?.length) return {};
    return this.buildResourceMap(this.resourcesToLoad);
  }

  /**
   * Parses the SQS event into a `[parsedRecords[], rawEvent]` tuple.
   *
   * Each record body is parsed from JSON and enriched with the SQS `messageId`
   * so the handler function can correlate processing results back to the queue.
   * If any record body cannot be parsed the entire batch is rejected with a
   * `HandlerError` so the message is not silently discarded.
   */
  protected async localFn(event: SQSEvent): Promise<unknown[]> {
    logger.info('[EventSQSHandler.localFn] Processing SQS event');

    if (!event.Records || !Array.isArray(event.Records)) {
      logger.error('[EventSQSHandler.localFn] Event is missing a Records array');
      throw new HandlerError(
        'SQS event must contain a Records array',
        StatusCodes.BAD_REQUEST,
      );
    }

    logger.info('[EventSQSHandler.localFn] Parsing SQS records', {
      recordCount: event.Records.length,
    });

    const parsedRecords: Record<string, unknown>[] = [];

    for (const sqsRecord of event.Records) {
      try {
        const parsedRecordBody = JSON.parse(sqsRecord.body) as Record<string, unknown>;
        parsedRecords.push({...parsedRecordBody, messageId: sqsRecord.messageId});
      } catch (recordParseError: unknown) {
        logger.error('[EventSQSHandler.localFn] Failed to parse SQS record body', {
          messageId: sqsRecord.messageId,
          error: recordParseError,
        });
        throw new HandlerError(
          `Failed to parse SQS record body for message ${sqsRecord.messageId}`,
          StatusCodes.BAD_REQUEST,
        );
      }
    }

    logger.info('[EventSQSHandler.localFn] Records parsed successfully', {
      parsedCount: parsedRecords.length,
    });

    if (this.schemaValidator) {
      logger.info('[EventSQSHandler.localFn] Validating parsed records against schema');
      await this.validateRequest(this.schemaValidator, parsedRecords);
    }

    return [parsedRecords, event];
  }
}

// ─── APIAsyncHandler ──────────────────────────────────────────────────────────

/**
 * Handler for API Gateway proxy events where the Lambda function maintains
 * persistent connections (MongoDB, Redis, etc.) across invocations.
 *
 * Sets `context.callbackWaitsForEmptyEventLoop = false` before delegating to
 * `APIHandler.localFn()`, allowing the Lambda runtime to return a response
 * without waiting for the Node.js event loop to drain.
 *
 * In all other respects this handler is identical to `APIHandler`.
 *
 * @example
 * export const handler = new APIAsyncHandler(myFn, {
 *   resourcesToLoad: [Resources.LOGGER],
 * }).lambdaHandler;
 */
export class APIAsyncHandler extends APIHandler {
  /**
   * Sets `callbackWaitsForEmptyEventLoop` to `false` on the Lambda context
   * before handing off to the parent `APIHandler` parsing logic.
   */
  protected async localFn(
    event: APIGatewayProxyEvent,
    context: Context,
  ): Promise<unknown[]> {
    context.callbackWaitsForEmptyEventLoop = false;
    return super.localFn(event, context);
  }
}
