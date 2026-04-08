// interface

export interface Request {
  headers: {
    'x-transaction-request-id'?: string;
    'x-remote-application-name'?: string;
  };
}
