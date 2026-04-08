export interface LogInterface {
  debug(primaryMessage: string, ...supportingData: any[]): void;

  warn(primaryMessage: string, ...supportingData: any[]): void;

  error(primaryMessage: string, ...supportingData: any[]): void;

  info(primaryMessage: string, ...supportingData: any[]): void;
}

export enum LogType {
  DEBUG = 'debug',
  INFO = 'info',
  WARN = 'warn',
  ERROR = 'error',
}
