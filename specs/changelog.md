# Changelog

All notable changes to `@vifros/aws-serverless-core` will be documented here.

Format: [Keep a Changelog](https://keepachangelog.com/en/1.0.0/)
Versioning: [Semantic Versioning](https://semver.org/spec/v2.0.0.html)

---

## [1.0.0] — 2026-04-08

### Added
- Initial release extracted from `api-reader/core/`
- `HandlerResponse` — Lambda response wrapper
- `HandlerError` — Custom error with statusCode, alertFlag, and optional stack trace
- `BaseHandler` — Core Lambda handler with SNS error alerting and gzip support
- `APIHandler` — HTTP API handler with body/query/path parsing, header extraction, AJV schema validation
- `EventSQSHandler` — SQS event handler with record parsing and schema validation
- `APIAsyncHandler` — Async Lambda handler with `callbackWaitsForEmptyEventLoop = false`
- `DynamoDBBaseModel` — DynamoDB abstraction with create, read, update, delete (soft/force), query (paginated), batchGet (auto-chunked with retry)
- `Logger` — Structured logger with automatic masking of `password`, `email`, and `phoneNumber` fields
- `compressAndEncodeGzip` / `compressAndEncodeBrotli` — Compression utilities
- Full TypeScript interfaces: `BaseDynamoDbModel`, `GSI1–5Key`, `DynamoDBQuery`, `LambdaResponse`, `LogInterface`, `Request`, etc.
- npm workspace setup at VERBOS root — `api-reader` consumes `@vifros/aws-serverless-core` via workspace symlink
