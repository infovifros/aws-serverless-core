# @vifros/aws-serverless-core — Specs

This folder is the single source of truth for planning, tracking, and documenting the evolution of `@vifros/aws-serverless-core`.

## Structure

| File / Folder | Purpose |
|---|---|
| `backlog.md` | Items queued for development — features, improvements, bugs |
| `roadmap.md` | High-level goals per version milestone |
| `changelog.md` | History of released changes |
| `decisions/` | Architecture Decision Records (ADRs) — one file per decision |

## How to use

- **New feature / bug**: add an entry to `backlog.md` under the appropriate section.
- **Starting a version**: move backlog items into `roadmap.md` under the target version.
- **Releasing**: move completed items from `roadmap.md` into `changelog.md`.
- **Architecture decision**: create a new file in `decisions/` using the next sequential number (e.g. `002-my-decision.md`).
