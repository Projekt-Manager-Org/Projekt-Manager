# ADR-0004: Backend stack — Fastify, Drizzle ORM, node-postgres

- **Status:** Accepted
- **Date:** 2026-04-04
- **Confidence:** High

## Context

ADR-0002 locked the frontend stack and made TypeScript the project language. ADR-0003 established Docker Compose as the deployment layer with PostgreSQL as the database. Backend framework and DB access layer remain open.

Key forces:

- **TypeScript end-to-end.** First-class TS support required, not bolted-on types.
- **Lightweight for the scale.** 1–5 users, 10–30 concurrent projects. Enterprise scaffolding (DI, decorators, modules) adds ceremony without proportional benefit.
- **SQL-literate.** Spec requires versioned schema migrations and a repository-pattern storage layer. Queries should be inspectable — debugging opaque query generation is a poor use of time.
- **Validation at the boundary.** API layer validates all incoming requests (spec §API). Built-in schema validation keeps this co-located with route definitions.

## Decision

**Fastify** as the HTTP framework, **Drizzle ORM** for database access and migrations, **node-postgres (pg)** as the underlying PostgreSQL driver.

### Fastify

Built-in JSON Schema request/response validation, plugin architecture for organizing the responsibility layers, first-class TypeScript. Schemas live alongside routes — no separate validation layer.

### Drizzle ORM

Schema defined in TypeScript, types generated from it — the same schema drives migrations, queries, and type checking. Query API reads like SQL rather than abstracting it away. Migration files are plain SQL, versioned and reproducible as the spec requires.

### node-postgres

The most established PostgreSQL client for Node.js. Used by Drizzle as its driver, no additional abstraction.

## Alternatives Considered

### Express

Mature, widely used, extensive middleware. Rejected: TypeScript support via community `@types/express` rather than built-in, no built-in request validation (requires Joi/Zod/express-validator) — all of which Fastify handles natively.

### Hono

Ultra-lightweight (~14 kB), excellent TS support, multi-runtime (Node, Deno, Bun, edge). Strong candidate. Rejected in favor of Fastify's more established ecosystem, richer plugin architecture, and built-in JSON Schema validation. Multi-runtime portability is moot — ADR-0003 fixed Node.js in Docker.

### NestJS

Enterprise Angular-inspired architecture (decorators, DI, modules). Rejected: overhead disproportionate for 1–5 users. Large-team ceremony becomes solo-developer friction.

### tRPC

End-to-end type safety by sharing types client-server — no schema duplication. Rejected: couples the API to TypeScript clients. The API becomes untestable with curl/Postman and inaccessible to non-TS consumers. The spec describes a REST API with standard HTTP semantics.

### Prisma

Most popular TS ORM — schema-first, auto-generated client, polished migrations. Rejected: ships a ~15 MB query engine binary as a sidecar process (resource overhead, cold-start latency). Query abstraction is opaque — diagnosing generated SQL adds a debugging layer. Drizzle's SQL-literate API avoids this.

### Knex.js

Query builder with solid migration support. Rejected: requires manual TS types for query results — Drizzle generates them from the schema, eliminating a class of type drift bugs.

## Consequences

### Positive

- Type safety flows from DB schema through queries to API responses — schema changes surface as compile errors
- Fastify's JSON Schema validation keeps request validation next to route definitions
- Drizzle migrations are plain SQL — inspectable, portable, no ORM lock-in for the migration history
- Both libraries are actively maintained with growing adoption

### Negative

- Fastify's plugin system has a learning curve — lifecycle hooks and encapsulation contexts are not immediately intuitive
- Drizzle is younger than Prisma — less LLM training data, fewer community resources, which matters in AI-assisted workflows (same force that favored React over Svelte in ADR-0002). Mitigated by Drizzle's SQL-literate API: where LLM support falls short on niche Drizzle patterns, the developer can reason in SQL directly
- JSON Schema (Fastify's validation format) is more verbose than alternatives like Zod

## Dep lifecycle health (as of 2026-05-15)

| Dep                  | Last release        | License    | Maintainership                                    | Notes                                                                                                                                                                                                                                                                                                                                                  |
| -------------------- | ------------------- | ---------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `fastify`            | 5.8.5 (2026-04-14)  | MIT        | Fastify team (Matteo Collina et al.), very active | [deps.dev](https://deps.dev/npm/fastify) — OpenJS Foundation project                                                                                                                                                                                                                                                                                   |
| `drizzle-orm`        | 0.45.2 (2026-03-27) | Apache-2.0 | Drizzle team, very active                         | [deps.dev](https://deps.dev/npm/drizzle-orm) — pre-1.0; bumped lockstep with `drizzle-kit`. **`v1.0.0-rc.2` published 2026-05-05** — track the 1.0 release window and plan the major bump (changelog covers JIT mappers + reworked casing API); upgrade in a single focused PR with full Renovate group of `drizzle-orm` + `drizzle-kit` once GA lands |
| `pg` (node-postgres) | 8.20.0 (2026-03-04) | MIT        | Brian Carlson + maintainers, active               | [deps.dev](https://deps.dev/npm/pg) — most-established Postgres driver in the Node ecosystem                                                                                                                                                                                                                                                           |

## References

- [ADR-0002: Tech Stack — TypeScript, React 19, Vite, Zustand](0002-tech-stack-typescript-react-vite-zustand.md)
- [ADR-0003: Deployment infrastructure — VPS, Docker Compose, GitHub Actions](0003-deployment-infrastructure-vps-docker-compose-github-actions.md)
- [Architecture — Responsibility layers](../../ARCHITECTURE.md#architecture-overview)
- [Product Spec](../spec/index.md)
