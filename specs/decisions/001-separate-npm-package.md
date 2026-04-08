# ADR 001 — Extract core/ into @verbos/core npm package

**Date:** 2026-04-08
**Status:** Accepted

---

## Context

The `api-reader` service contained a `core/` folder that was designed from the start to be reusable across multiple VERBOS services (`api-verbos`, `api-lottonia`, future services). While it lived inside `api-reader`, any other service that wanted to use these utilities had to copy the files manually — leading to drift and duplication.

With multiple services now active in the VERBOS organization, the need for a shared, versioned package became clear.

## Decision

Extract `core/` into a standalone npm package named `@verbos/core`, living at `/VERBOS/core` as a sibling to all consumer services.

Use **npm workspaces** at the VERBOS root (`/VERBOS/package.json`) so that:
- Changes to `@verbos/core` are immediately available to all workspace consumers without publishing.
- Each service declares `"@verbos/core": "*"` as a dependency and resolves it via the workspace symlink.
- For npm publishing (production), a `build` script compiles TypeScript to `dist/` via `tsconfig.build.json`.

The package's `main` field points to `src/index.ts` so that `ts-node` (used by `serverless-offline`) resolves TypeScript source directly during local development, requiring no pre-build step.

## Consequences

**Good:**
- Single source of truth for shared Lambda utilities across all VERBOS services.
- Versioned releases allow services to pin to a stable version when needed.
- `specs/` folder inside the package gives `@verbos/core` its own backlog, roadmap, and ADRs.

**Trade-offs:**
- Services must run `npm install` from the workspace root (or their own directory) after `@verbos/core` changes that affect the `package.json`.
- For `sls deploy`, core must be built (`npm run build -w @verbos/core`) before packaging, since serverless won't transpile files in `node_modules/`.

## Alternatives considered

- **Copy-paste approach**: rejected — causes drift across services.
- **Git submodule**: rejected — complex workflow, poor DX.
- **Private npm registry**: valid for the future, but overkill while the codebase is monorepo-adjacent.
