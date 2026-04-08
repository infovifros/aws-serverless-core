# Roadmap

---

## v1.0.0 — Initial extraction (current)

- [x] Extract `core/` from `api-reader` into standalone `@vifros/aws-serverless-core` npm package
- [x] Set up npm workspaces with `api-reader` at VERBOS root
- [x] `HandlerResponse`, `HandlerError`, `BaseHandler`, `APIHandler`, `EventSQSHandler`, `APIAsyncHandler`
- [x] `DynamoDBBaseModel` with CRUD, batch get, soft delete, pagination
- [x] `Logger` with sensitive data masking
- [x] `compressAndEncodeGzip` / `compressAndEncodeBrotli` utilities
- [x] Full TypeScript source with `tsconfig.build.json` for npm publishing

---

## v1.1.0 — Planned

- [ ] SSM Parameter Store loader in `BaseHandler.load()`
- [ ] Fix typo bug in `APIHandler.localFn` header deletion (`x-app-nam` → `x-app-name`)
- [ ] Replace `@ts-ignore` in resource injection with proper generics
- [ ] Unit test suite (Logger, DynamoDB helpers)

---

## v2.0.0 — Future

- [ ] `APIGatewayV2Handler` for HTTP API payload format 2.0
- [ ] JSON structured logging option in `Logger`
- [ ] `DynamoDBBaseModel.transactWrite()` for atomic operations
