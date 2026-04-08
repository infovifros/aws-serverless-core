# Backlog

Items are grouped by category. Move to `roadmap.md` when scheduling for a release.

---

## Features

- [ ] SSM Parameter Store loader in `BaseHandler.load()` — load env vars by path prefix at cold start
- [ ] `APIHandler`: support JWT verification via `aws-jwt-verify` as an optional resource
- [ ] `DynamoDBBaseModel`: add `scan()` method with pagination support
- [ ] `DynamoDBBaseModel`: add `transactWrite()` helper for atomic multi-item operations
- [ ] `EventSQSHandler`: add dead-letter queue reporting on partial batch failures
- [ ] Add `APIGatewayV2Handler` class for HTTP API (payload format 2.0)

## Improvements

- [ ] Replace `// @ts-ignore` comments in `APIHandler.addResourcesFn()` with proper typing
- [ ] Extract `cachedEnvironmentVariables` map into a dedicated `EnvCache` utility
- [ ] Add structured log output (JSON format) as an option in `Logger`
- [ ] `DynamoDBBaseModel.update()`: support nested attribute updates

## Bugs

- [ ] `APIHandler.localFn`: typo `x-app-nam` (missing `e`) when deleting header — line 320 of original

## Tech Debt

- [ ] Add unit tests for `Logger` sensitive data masking
- [ ] Add unit tests for `DynamoDBBaseModel` helper methods
- [ ] Set up CI pipeline for the core package (lint + build on PR)
