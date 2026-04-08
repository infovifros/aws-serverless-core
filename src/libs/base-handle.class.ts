import {StatusCodes} from 'http-status-codes';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import {v4 as uuidv4} from 'uuid';
import {PublishCommand, SNSClient} from '@aws-sdk/client-sns'; // Interfaces
import {ErrorMessage, LambdaResponse, LambdaResponseLogger, Resources} from '../interfaces/handler.interface'; // Class
import {Logger} from './logger.class';
import {SQSEvent} from 'aws-lambda';
import {compressAndEncodeGzip} from './compress';

const logger = new Logger();

// Global cache for environment variables - persists across warm Lambda invocations
const cachedEnvironmentVariables = new Map<string, {envs: Record<string, string>; createdAt: string}>();

export class HandlerResponse {
  public body: object | string | null;
  public statusCode: number;
  public options: object | undefined;

  constructor(body: object | string | null, statusCode = StatusCodes.OK, options?: object) {
    this.body = body;
    this.statusCode = statusCode;
    this.options = options;
  }
}

export class HandlerError extends Error {
  public statusCode: number;
  public message: string;
  public captureStackTraceFlag: boolean; // New property to store the flag
  public alertFlag: boolean;

  constructor(
    message: string | ErrorMessage,
    statusCode = StatusCodes.INTERNAL_SERVER_ERROR,
    captureStackTrace: boolean = true,
    alert: boolean = true,
  ) {
    if (typeof message === 'object') {
      message = JSON.stringify(message);
    }
    super(message);
    this.message = message;
    this.statusCode = statusCode;
    this.captureStackTraceFlag = captureStackTrace; // Set the flag based on the constructor argument
    this.alertFlag = alert;
    this.name = 'HandlerError';

    if (captureStackTrace) {
      Error.captureStackTrace(this, HandlerError);
    }
  }
}

class BaseHandler {
  handlerFn;
  ajv: Ajv;
  protected snsClient;

  constructor(handlerFn: any) {
    this.handlerFn = handlerFn;
    this.lambdaHandler = this.lambdaHandler.bind(this);
    this.snsClient = new SNSClient({});

    this.ajv = new Ajv({
      coerceTypes: true,
      allErrors: true,
    });
    addFormats(this.ajv);
  }

  async sendSNSMessage(subject: string, message: any, topicArn: string) {
    logger.info('BaseHandler - Starting the sendSNSMessage', {subject, topicArn});

    let snsClientResponse;
    const publishCommandParams = {
      ActionName: ['Publish'],
      TopicArn: topicArn,
      Label: uuidv4(),
      Subject: subject,
      Message: JSON.stringify(message),
    };

    try {
      const publishCommand = new PublishCommand(publishCommandParams);
      snsClientResponse = await this.snsClient.send(publishCommand);

      logger.debug('BaseHandler - snsClientResponse', snsClientResponse);
    } catch (error: any) {
      logger.error('Error Sending sendSNSMessage check the logs directly', error);

      if (error?.Message === 'Invalid parameter: Message too long') {
        publishCommandParams.Message = error?.errorMessage || 'Error Sending sendSNSMessage check the logs directly';
        const publishCommand = new PublishCommand(publishCommandParams);
        snsClientResponse = await this.snsClient.send(publishCommand);
      }
    }

    return snsClientResponse;
  }

  async load() {
    //TODO: Implement
    // - load ssm by path
    // - load
  }

  async localFn(event: any, context: any) {
    return [event, context];
  }

  async addResourcesFn() {
    return {};
  }

  async lambdaHandler(event: any, context: any) {
    logger.info('BaseHandler - Starting the lambdaHandler');

    let handlerFnResponse = null;
    const finalResponse: LambdaResponse = {
      statusCode: 200,
      body: '',
    };

    if (
      event?.headers?.['X-KEEP-LAMBDA-WARN'] === 'BBBBBBBBBBBPPPP000' ||
      event?.headers?.['x-keep-lambda-warn'] === 'BBBBBBBBBBBPPPP000'
    ) {
      logger.info('X-KEEP-LAMBDA-WARN header is present', event.headers);

      return finalResponse;
    }

    let lambdaParameters = [];
    try {
      const xAppName = event?.headers?.['x-app-name'];
      const projectName = process.env.SERVICE_NAME;
      await this.load();

      lambdaParameters = await this.localFn(event, context);

      const lambdaResources = await this.addResourcesFn();

      handlerFnResponse = await this.handlerFn.apply(null, [...lambdaParameters, lambdaResources]);
    } catch (error: any) {
      // TODO: JCRC Implement a better error handling or move into a new function
      if (process.env.SNS_TOPIC_ARN_API_ERROR && error?.alertFlag) {
        const responseEvent = event;
        const body = responseEvent.body ? JSON.parse(responseEvent.body) : {};

        if (body?.base64) {
          responseEvent.body = {...body, base64: '<truncated>'};
        }

        if (responseEvent?.headers?.authorization) {
          responseEvent.headers = {...responseEvent.headers, authorization: '<truncated>'};
        }

        const customError = {
          stack: error.captureStackTraceFlag ? error.stack : undefined, // Conditionally include the stack trace
          message: error?.message,
          name: error?.name,
          statusCode: error?.statusCode,
          projectName: process.env.SERVICE_NAME || 'NOT SERVICE NAME PROVIDED',
          event: JSON.stringify(responseEvent),
        };
        await this.sendSNSMessage('HandlerError Try Catch', customError, process.env.SNS_TOPIC_ARN_API_ERROR);
      }

      // Errors Here
      switch (error.name) {
        case 'HandlerError':
        case 'ValidationError':
        case 'MongoServerError':
          return {
            statusCode: error?.statusCode || StatusCodes.INTERNAL_SERVER_ERROR,
            body: error?.message ? JSON.stringify(error?.message) : null,
          };
        default: {
          logger.error('HandlerError Try Catch: ', error);
        }
      }
    }

    if (!(handlerFnResponse instanceof HandlerResponse)) {
      logger.error('The response from the handler need to be a ServiceResponse');
      throw new HandlerError('The response from the handler need to be a ServiceResponse');
    }

    if (!handlerFnResponse.body) {
      finalResponse.body = null;
      finalResponse.statusCode = StatusCodes.NO_CONTENT;
    } else if (typeof handlerFnResponse.body === 'string') {
      finalResponse.body = handlerFnResponse.body;
      finalResponse.statusCode = handlerFnResponse.statusCode;
    } else {
      finalResponse.body = JSON.stringify(handlerFnResponse.body);
      finalResponse.statusCode = handlerFnResponse.statusCode;
    }
    finalResponse.options = handlerFnResponse.options;

    if (finalResponse?.options?.logger === LambdaResponseLogger.Hide) {
      logger.info('BaseHandler - Response Hide Content');
    } else {
      logger.info('BaseHandler - Response ');
    }

    let isBase64Encoded = (finalResponse?.body && event?.headers?.['accept-encoding']?.includes('gzip')) || false;
    logger.debug('accept-encoding', {isBase64Encoded, acceptEncoding: event?.headers?.['accept-encoding']});

    // Accept-Encoding: gzip
    if (isBase64Encoded && finalResponse.body) {
      try {
        finalResponse.body = await compressAndEncodeGzip(finalResponse.body);
        logger.info('Compressed data');

        // You could send `compressedData` in your API response here,
        // making sure to set the `Content-Encoding: gzip` header.
      } catch (error) {
        logger.warn('Warning at compressing', error);
        isBase64Encoded = false;
      }
    }

    // TODO: JCRC Implement return headers
    return {
      headers: {
        'content-type': 'application/json',
        ...(isBase64Encoded ? {'Content-Encoding': 'gzip'} : {}),
        ...finalResponse?.options?.headers,
      },
      statusCode: finalResponse.statusCode,
      body: finalResponse.body,
      isBase64Encoded,
    };
  }
}

export class APIHandler extends BaseHandler {
  schemaValidator: string | null;
  resourcesToLoad: Resources[] | null;

  constructor(handlerFn: any, opts?: {schemaValidator?: any; resourcesToLoad?: Resources[]}) {
    super(handlerFn);
    this.schemaValidator = opts?.schemaValidator || null;
    this.resourcesToLoad = opts?.resourcesToLoad || null;
  }

  async addResourcesFn() {
    const resourcesResult = {};
    if (this.resourcesToLoad && this.resourcesToLoad.length > 0) {
      this.resourcesToLoad.forEach((resource: string) => {
        switch (resource) {
          case Resources.LOGGER: {
            // @ts-ignore
            resourcesResult[Resources.LOGGER] = logger;
            break;
          }
          case Resources.DYNAMODB: {
            // Create DynamoDB in a file separate, here we import and add just the instance
            //
            break;
          }
          case Resources.UUIDV4: {
            // @ts-ignore
            resourcesResult[Resources.UUIDV4] = uuidv4;
            break;
          }
          case Resources.STATUS_CODES: {
            // @ts-ignore
            resourcesResult[Resources.STATUS_CODES] = <StatusCodes>StatusCodes;
            break;
          }
        }
      });
    }

    return resourcesResult || {};
  }

  async validateRequest(schemaValidator: any, request: any) {
    const validate = this.ajv.compile(schemaValidator);
    const valid = validate(request);
    if (!valid) {
      logger.error('Schema validation errors ', validate.errors);
      throw new HandlerError(`Schema Validation Errors ${JSON.stringify(validate.errors)}`, StatusCodes.CONFLICT);
    }
  }

  async localFn(event: any) {
    const queryStringParameters: any = {};
    for (const param in event.queryStringParameters) {
      try {
        queryStringParameters[param] = JSON.parse(event.queryStringParameters[param]);
      } catch (error) {
        queryStringParameters[param] = event.queryStringParameters[param];
      }
    }
    const body = event.body ? JSON.parse(event.body) : {};
    const pathParameters = event.pathParameters || {};

    let request = {
      ...body,
      ...pathParameters,
      ...queryStringParameters,
    };

    const additionalHeaders = {
      'x-transaction-request-id': event.headers['x-transaction-request-id'] || uuidv4(),
      'x-tracer-api-request-id': uuidv4(),
      'x-remote-application-name': event.headers['x-remote-application-name'] || 'NOT APP NAME PROVIDED',
      'x-app-name': event.headers['x-app-name'] || 'NOT APP NAME PROVIDED',
      'x-app-version': event.headers['x-app-version'] || 'NOT APP VERSION PROVIDED',
      'x-user-token': event.headers['x-user-token'] || 'NOT USER TOKEN PROVIDED',
    };

    if (event.headers['x-transaction-request-id']) delete event.headers['x-transaction-request-id'];
    if (event.headers['x-remote-application-name']) delete event.headers['x-remote-application-name'];
    if (event.headers['x-app-name']) delete event.headers['x-app-nam'];
    if (event.headers['x-app-version']) delete event.headers['x-app-version'];
    if (event.headers['x-user-token']) delete event.headers['x-user-token'];

    const headers = {
      ...event.headers,
      ...additionalHeaders,
    };

    request = Object.assign(request, {headers});
    logger.info('Handler.localFn - Request: ', request);

    if (this.schemaValidator) {
      await this.validateRequest(this.schemaValidator, request);
    }

    const parametersForLocalFn = [request, event];

    return [...parametersForLocalFn];
  }
}

export class EventSQSHandler extends BaseHandler {
  schemaValidator: string | null;
  resourcesToLoad: Resources[] | null;

  constructor(handlerFn: any, opts?: {schemaValidator?: any; resourcesToLoad?: Resources[]}) {
    super(handlerFn);
    this.schemaValidator = opts?.schemaValidator || null;
    this.resourcesToLoad = opts?.resourcesToLoad || null;
  }

  async validateRequest(schemaValidator: any, request: any) {
    const validate = this.ajv.compile(schemaValidator);
    const valid = validate(request);
    if (!valid) {
      logger.error('Schema validation errors ', validate.errors);
      throw new HandlerError(`Schema Validation Errors ${JSON.stringify(validate.errors)}`, StatusCodes.CONFLICT);
    }
  }

  async localFn(event: SQSEvent) {
    logger.info('Handler.localFn - Start');

    const request: Array<object> = [];

    if (!event.Records || !Array.isArray(event.Records)) {
      logger.error('Event does not contain records array');
      throw new HandlerError('Event does not contain records array', StatusCodes.BAD_REQUEST);
    }

    logger.info('Handler.localFn - Processing records');
    for (const record of event.Records) {
      try {
        const recordBody = JSON.parse(record.body);
        request.push({...recordBody, messageId: record.messageId});
      } catch (error) {
        logger.error('Error processing record', error);
        throw new HandlerError('Error processing record', StatusCodes.BAD_REQUEST);
      }
    }

    logger.info('Handler.localFn - Request: ', request);

    if (this.schemaValidator) {
      logger.info('Handler.localFn - Validating request');
      await this.validateRequest(this.schemaValidator, request);
    }

    logger.info('Handler.localFn - End');

    return [request, event];
  }
}

export class APIAsyncHandler extends BaseHandler {
  schemaValidator: string | null;
  resourcesToLoad: Resources[] | null;

  constructor(handlerFn: any, opts?: {schemaValidator?: any; resourcesToLoad?: Resources[]}) {
    super(handlerFn);
    this.schemaValidator = opts?.schemaValidator || null;
    this.resourcesToLoad = opts?.resourcesToLoad || null;
  }

  async addResourcesFn() {
    const resourcesResult = {};
    if (this.resourcesToLoad && this.resourcesToLoad.length > 0) {
      this.resourcesToLoad.forEach((resource: string) => {
        switch (resource) {
          case Resources.LOGGER: {
            // @ts-ignore
            resourcesResult[Resources.LOGGER] = logger;
            break;
          }
          case Resources.DYNAMODB: {
            // Create DynamoDB in a file separate, here we import and add just the instance
            //
            break;
          }
          case Resources.UUIDV4: {
            // @ts-ignore
            resourcesResult[Resources.UUIDV4] = uuidv4;
            break;
          }
          case Resources.STATUS_CODES: {
            // @ts-ignore
            resourcesResult[Resources.STATUS_CODES] = <StatusCodes>StatusCodes;
            break;
          }
        }
      });
    }

    return resourcesResult || {};
  }

  async validateRequest(schemaValidator: any, request: any) {
    const validate = this.ajv.compile(schemaValidator);
    const valid = validate(request);
    if (!valid) {
      logger.error('Schema validation errors ', validate.errors);
      throw new HandlerError(`Schema Validation Errors ${JSON.stringify(validate.errors)}`, StatusCodes.CONFLICT);
    }
  }

  async localFn(event: any, context: any) {
    const queryStringParameters: any = {};
    for (const param in event.queryStringParameters) {
      try {
        queryStringParameters[param] = JSON.parse(event.queryStringParameters[param]);
      } catch (error) {
        queryStringParameters[param] = event.queryStringParameters[param];
      }
    }
    const body = event.body ? JSON.parse(event.body) : {};
    const pathParameters = event.pathParameters || {};

    let request = {
      ...body,
      ...pathParameters,
      ...queryStringParameters,
    };

    const additionalHeaders = {
      'x-transaction-request-id': event.headers['x-transaction-request-id'] || uuidv4(),
      'x-tracer-api-request-id': uuidv4(),
      'x-remote-application-name': event.headers['x-remote-application-name'] || 'NOT APP NAME PROVIDED',
      'x-app-name': event.headers['x-app-name'] || 'NOT APP NAME PROVIDED',
      'x-app-version': event.headers['x-app-version'] || 'NOT APP VERSION PROVIDED',
      'x-user-token': event.headers['x-user-token'] || 'NOT USER TOKEN PROVIDED',
    };

    if (event.headers['x-transaction-request-id']) delete event.headers['x-transaction-request-id'];
    if (event.headers['x-remote-application-name']) delete event.headers['x-remote-application-name'];
    if (event.headers['x-app-name']) delete event.headers['x-app-name'];
    if (event.headers['x-app-version']) delete event.headers['x-app-version'];
    if (event.headers['x-user-token']) delete event.headers['x-user-token'];

    const headers = {
      ...event.headers,
      ...additionalHeaders,
    };

    request = Object.assign(request, {headers});
    logger.info('Handler.localFn - Request: ', request);

    if (this.schemaValidator) {
      await this.validateRequest(this.schemaValidator, request);
    }

    const parametersForLocalFn = [request, event];

    context.callbackWaitsForEmptyEventLoop = false;

    return [...parametersForLocalFn];
  }
}
