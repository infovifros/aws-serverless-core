export interface LambdaResponse {
  body: string | null;
  statusCode: number;
  options?: {
    headers?: object;
    logger?: string;
  };
}

export enum LambdaResponseLogger {
  Hide = 'hide'
}

export enum Resources {
  DYNAMODB = 'dynamodb',
  LOGGER = 'logger',
  STATUS_CODES = 'statusCodes',
  UUIDV4 = 'uuidv4',
}

export interface ErrorMessage {
  errorKey: string | number;
  errorMessage: string;
}
