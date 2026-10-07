# API

The HTTP surface as implemented. The normative contract is [api.md §14.2](../spec/api.md#142-operations); both artifacts here are generated from the routes `buildApp()` registers and lose to it on any disagreement.

| Artifact                                                  | Generator                         | Check                       |
| --------------------------------------------------------- | --------------------------------- | --------------------------- |
| [`openapi.json`](openapi.json) — requests + session (3.1) | `scripts/generate-openapi.ts`     | `npm run check:openapi`     |
| [§ Endpoints](#endpoints) — access and rate limits        | `scripts/generate-api-surface.ts` | `npm run check:api-surface` |

Both read the routes through `scripts/lib/route-introspection.ts`. An access gate that no session gate reaches first fails both generators — such a route answers 401 to everyone, yet would publish as reachable.

## Endpoints

<!-- GENERATED:api-surface:START — generated from the routes buildApp() registers (src/server/app.ts); do not hand-edit (AC-352). -->

| Method  | Path                                                | Auth    | Access                 | Rate limit    |
| ------- | --------------------------------------------------- | ------- | ---------------------- | ------------- |
| OPTIONS | `*`                                                 | none    | —                      | none          |
| GET     | `/api/health`                                       | none    | —                      | none          |
| POST    | `/api/auth/login`                                   | none    | —                      | 5 / 1 minute  |
| POST    | `/api/auth/logout`                                  | session | —                      | none          |
| GET     | `/api/auth/me`                                      | session | —                      | none          |
| PATCH   | `/api/auth/me`                                      | session | —                      | none          |
| POST    | `/api/auth/change-password`                         | session | `auth:change-password` | 5 / 1 minute  |
| GET     | `/api/projects`                                     | session | `project:read`         | none          |
| POST    | `/api/projects`                                     | session | `project:create`       | none          |
| GET     | `/api/projects/:id`                                 | session | `project:read`         | none          |
| POST    | `/api/projects/:id/transition/forward`              | session | `project:transition`   | none          |
| POST    | `/api/projects/:id/transition/backward`             | session | `project:transition`   | none          |
| PATCH   | `/api/projects/:id/dates`                           | session | `project:dates`        | none          |
| PATCH   | `/api/projects/:id`                                 | session | `project:update`       | none          |
| DELETE  | `/api/projects/:id`                                 | session | `project:delete`       | none          |
| DELETE  | `/api/projects/:id/purge`                           | session | `project:purge`        | none          |
| POST    | `/api/projects/:id/restore`                         | session | `project:delete`       | none          |
| GET     | `/api/customers`                                    | session | `customer:read`        | none          |
| GET     | `/api/customers/:id`                                | session | `customer:read`        | none          |
| POST    | `/api/customers`                                    | session | `customer:write`       | none          |
| PATCH   | `/api/customers/:id`                                | session | `customer:write`       | none          |
| DELETE  | `/api/customers/:id`                                | session | `customer:delete`      | none          |
| GET     | `/api/users`                                        | session | `user:read`            | none          |
| GET     | `/api/users/:id`                                    | session | `user:read`            | none          |
| POST    | `/api/users`                                        | session | `user:manage`          | none          |
| PATCH   | `/api/users/:id`                                    | session | `user:manage`          | none          |
| DELETE  | `/api/users/:id`                                    | session | `user:delete`          | none          |
| POST    | `/api/users/:id/deactivate`                         | session | `user:manage`          | none          |
| POST    | `/api/users/:id/reactivate`                         | session | `user:manage`          | none          |
| POST    | `/api/users/:id/reset-password`                     | session | `user:manage`          | none          |
| GET     | `/api/workers`                                      | session | `project:read`         | none          |
| POST    | `/api/export-jobs`                                  | session | `data:export`          | none          |
| GET     | `/api/export-jobs`                                  | session | `data:export`          | none          |
| GET     | `/api/export-jobs/:id`                              | session | `data:export`          | none          |
| GET     | `/api/export-jobs/:id/download`                     | session | `data:export`          | none          |
| POST    | `/api/import-jobs`                                  | session | `data:restore`         | none          |
| GET     | `/api/import-jobs`                                  | session | `data:restore`         | none          |
| GET     | `/api/import-jobs/:id`                              | session | `data:restore`         | none          |
| HEAD    | `/api/import-jobs/:id/archive`                      | session | `data:restore`         | none          |
| PATCH   | `/api/import-jobs/:id/archive`                      | session | `data:restore`         | none          |
| POST    | `/api/extract`                                      | session | `customer:write`       | none          |
| GET     | `/api/audit`                                        | session | `audit:read`           | none          |
| GET     | `/api/audit/:id`                                    | session | `audit:read`           | none          |
| GET     | `/api/notification-rules`                           | session | `notifications:manage` | none          |
| GET     | `/api/notification-rules/:id`                       | session | `notifications:manage` | none          |
| POST    | `/api/notification-rules`                           | session | `notifications:manage` | none          |
| PATCH   | `/api/notification-rules/:id`                       | session | `notifications:manage` | none          |
| DELETE  | `/api/notification-rules/:id`                       | session | `notifications:manage` | none          |
| POST    | `/api/push-subscriptions`                           | session | —                      | 20 / 1 minute |
| DELETE  | `/api/push-subscriptions`                           | session | —                      | 20 / 1 minute |
| DELETE  | `/api/push-subscriptions/:id`                       | session | —                      | 20 / 1 minute |
| GET     | `/api/projects/:id/attachments`                     | session | `attachment:read`      | none          |
| POST    | `/api/projects/:id/attachments/init`                | session | `attachment:write`     | none          |
| POST    | `/api/projects/:id/attachments/:attId/complete`     | session | `attachment:write`     | none          |
| DELETE  | `/api/projects/:id/attachments/:attId`              | session | `attachment:hide`      | none          |
| GET     | `/api/projects/:id/attachments/trash`               | session | `attachment:trash`     | none          |
| POST    | `/api/projects/:id/attachments/:attId/restore`      | session | `attachment:trash`     | none          |
| GET     | `/api/projects/:id/attachments/:attId/download-url` | session | `attachment:read`      | none          |
| POST    | `/api/projects/:id/attachments/bulk-fetch`          | session | `attachment:read`      | none          |
| GET     | `/api/projects/:id/storage-usage`                   | session | `project:read`         | none          |
| GET     | `/api/storage-usage`                                | session | `data:export`          | none          |
| GET     | `/api/invoices`                                     | session | —                      | none          |
| GET     | `/api/invoices/years`                               | session | —                      | none          |
| GET     | `/api/invoices/:id`                                 | session | —                      | none          |
| POST    | `/api/invoices`                                     | session | `invoice:write`        | none          |
| PATCH   | `/api/invoices/:id`                                 | session | `invoice:write`        | none          |
| DELETE  | `/api/invoices/:id`                                 | session | `invoice:write`        | none          |
| POST    | `/api/invoices/:id/issue`                           | session | `invoice:write`        | none          |
| POST    | `/api/invoices/:id/cancel`                          | session | `invoice:write`        | none          |
| GET     | `/api/invoices/:id/pdf`                             | session | `invoice:read`         | none          |
| POST    | `/api/invoices/export`                              | session | `invoice:read`         | none          |
| GET     | `/api/company-profile`                              | session | —                      | none          |
| PUT     | `/api/company-profile`                              | session | Role: owner            | none          |
| GET     | `/api/events`                                       | session | —                      | none          |
| GET     | `/api/push/vapid-public-key`                        | none    | —                      | none          |

<!-- GENERATED:api-surface:END -->

- **Auth** `session` without a valid session → `401 UNAUTHENTICATED`; a failed **Access** rule → `403 NOT_PERMITTED`. Gates: `src/server/middleware/auth.ts`; keys resolve against `src/config/permissions.ts`.
- **Access** `—` means no gate at the route boundary, not "open to every role": some reads narrow rows by scope instead (ADR-0019) — a worker's `GET /api/invoices` answers `200` with an empty set (AC-298).
- **Rate limit** shows production values. Login is 5/min in production, 30/min in dev/test; `LOGIN_RATE_LIMIT_MAX` overrides both.
- What each endpoint does: [api.md §14.2](../spec/api.md#142-operations). `OPTIONS *` is the CORS preflight. Static SPA assets (`registerStaticAssets`, production only) are not API surface and appear in neither artifact.

## OpenAPI Document

- **Requests only.** No route declares a `response:` schema, so the generator strips `@fastify/swagger`'s synthetic `200 Default Response` — silent beats wrong. Adding one is not doc-only: Fastify then serializes through it and drops unlisted fields.
- **3.1, not 3.0** — the route schemas use `type: [..., 'null']`, and 3.1 makes `responses` optional.
- **Two gates:** `--check` catches drift; a schema validator catches an invalid document, which drift alone would pass.
- **Session requirement is derived** from the gates (AC-353). Permission keys are not in it — scopes mean nothing on a cookie scheme; § Endpoints carries them.
- `@fastify/swagger` is a devDependency, loaded lazily in `src/server/app.ts` and only by the generator.
