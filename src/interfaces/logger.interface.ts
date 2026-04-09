/**
 * Contract that every logger implementation must satisfy.
 * `supportingData` accepts `unknown[]` so callers can pass any value — objects,
 * errors, primitives — without needing to cast, while implementations are
 * responsible for safe serialisation.
 */
export interface LogInterface {
  debug(primaryMessage: string, ...supportingData: unknown[]): void;
  info(primaryMessage: string, ...supportingData: unknown[]): void;
  warn(primaryMessage: string, ...supportingData: unknown[]): void;
  error(primaryMessage: string, ...supportingData: unknown[]): void;
}

/** Maps to the four standard `console` methods used for log emission. */
export enum LogType {
  DEBUG = 'debug',
  INFO = 'info',
  WARN = 'warn',
  ERROR = 'error',
}
