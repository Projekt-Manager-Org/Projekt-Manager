# ADR-0025: Realtime UI invalidation via Server-Sent Events

- **Status:** Accepted
- **Date:** 2026-05-06
- **Confidence:** High

## Context

The deployment topology is single-tenant but multi-user ([ADR-0001](0001-generalized-system-with-configurable-customer-specifics.md)): the office user typically keeps the dashboard open all day while workers mutate data from mobile. UI surfaces that depend on shared state (the `project_storage_usage` counter from #171, attachment lists, project lists) drift stale on the always-open observer between client-initiated refreshes.

Forces:

- **Multi-user invalidation is not solvable from the consuming tab alone.** Mount + visibilitychange + post-mutation refetch close the single-user case but leave the always-open observer stale. Polling closes the gap at the cost of constant pressure to "tighten" the cadence — eventually reinventing a server-push channel behind a worse interface.
- **Iteration 7 added the trigger-maintained `project_storage_usage` counter** (#171) — the first surface whose UX correctness depends on cross-session freshness.
- **Future surfaces have the same shape.** Attachment lists, project lists, and any other multi-user view need the same primitive; per-domain solutions would compound.
- **No bidirectional need.** Server pushes invalidation hints; the client refetches via existing read endpoints.
- **Single Node process, single tenant.** No fan-out across workers required.

## Decision

We will introduce a single multiplexed Server-Sent Events channel at `GET /api/events`, with typed event names (`storage_usage_changed`, future `attachment_changed`, `project_changed`, …), as the project's standard primitive for cross-session UI invalidation.

Shape:

- **Transport: SSE.** Plain HTTP, browser-native `EventSource`, auto-reconnect, no protocol upgrade. Industry default for one-way server-push (GitHub PR streams, Vercel build status, Stripe Dashboard, Hotwire/Turbo Streams).
- **One channel, typed events.** `event: <name>` discriminator; payload is an invalidation ping, not data. The client refetches via existing read endpoints — single source of truth, no two-channel sync.
- **Authentication: existing session cookie.** `EventSource` sends cookies natively; the same session middleware admits or rejects the connection.
- **Authorization: at the consumer endpoint, not at the event.** Events are broadcast to all authenticated sessions. Event names carry no information beyond "a thing of kind X changed"; sensitive content lives behind the gated read endpoints the client refetches.
- **Emission: in-process, post-commit, from the mutation call sites.** Out-of-band SQL writes (admin shell, future migrations) are not covered in v1 — flagged as a known gap.
- **Heartbeat: configurable **[C]** SSE comment line (default 25 s; bounded 1 s … 600 s; env `SSE_HEARTBEAT_INTERVAL_MS`)** to defeat proxy and browser idle disconnects.
- **No `Last-Event-ID` replay.** Events are invalidation hints, not a log; on reconnect the client refetches state.
- **Reverse proxy: `flush_interval -1`** on the `/api/events` upstream. Caddy auto-flushes responses with `Content-Type: text/event-stream` already; the directive is explicit belt-and-suspenders so the buffering posture is obvious in the config.
- **Connection model: one EventSource per tab.** No server-side cap (single-tenant per ADR-0001); flag for monitor-and-revisit.

The PostgreSQL `LISTEN`/`NOTIFY` upgrade path is recorded as the natural successor when (a) direct-SQL writes need to participate, (b) the deployment moves beyond single-process Fastify, or (c) per-row trigger emission becomes the cleaner source of truth than per-handler emission.

## Alternatives Considered

### WebSocket

Bidirectional, lower per-message overhead. Ruled out: protocol upgrade complicates Caddy and middlewares, sticky-session story is a future ops concern, bidirectional is unused — solving a problem we don't have. SSE wins on simplicity for a one-way invalidation channel.

### Web Push (already wired per [ADR-0023](0023-notification-rules-db-stored-closed-event-catalog.md))

Reuse the existing VAPID infrastructure. Ruled out: wrong primitive. Web Push is for OS-level notifications when the app is closed — expensive per send, requires user permission, traverses third-party push services, payload-encrypted at the spec level. Using it as an in-tab UI hint inverts the design intent.

### Polling

Variants: fixed interval, ETag-conditional, visibilitychange-gated, exponential backoff. Ruled out: addresses the symptom (staleness) at the cost of constant tuning pressure ("5 min is too long" → 1 min → 30s) and steady idle traffic. Eventually reinvents SSE behind a worse interface.

### PostgreSQL `LISTEN`/`NOTIFY` from PL/pgSQL triggers

Triggers `NOTIFY` on a channel; the Node process holds one persistent `LISTEN` connection and fans out to SSE subscribers. Strongest source-of-truth coupling — even out-of-band SQL writes fire events. Ruled out for v1, not on principle but on cost: the in-process post-commit bus is sufficient at single-process scale, and the `LISTEN` connection introduces a long-lived DB session to shepherd. Recorded as the explicit upgrade path.

### Multiple per-domain channels (`/api/events/storage-usage`, `/api/events/attachments`)

Cleaner per-route auth at the cost of N TCP connections per tab and per-domain subscription bookkeeping. Ruled out: browser per-origin connection budgets are scarce (HTTP/1.1: 6 sockets per origin; SSE consumes one indefinitely); HTTP/2 lifts this but the multiplexed channel sidesteps the question entirely.

## Consequences

### Positive

- Industry-standard primitive; zero new client dependency (`EventSource` is built-in).
- One channel scales to future surfaces — new event types ship without new infra.
- Browser auto-reconnects after a transport drop, at the WHATWG-mandated implementation-defined reconnection time (overridable via the server's `retry:` field, not used here).
- Server-side cost is small: one held HTTP response per connected tab, no protocol upgrade.
- Aligns with the post-commit fan-out pattern established by [ADR-0021](0021-audit-log-and-notifications-single-write-path.md)'s in-process publisher — same architectural shape, distinct subscribers.

### Negative

- Each connected tab pins one socket on the Node process and one upstream socket on Caddy — eventual ceiling at scale, not at single-tenant scale.
- Caddy needs the `flush_interval -1` directive on the `/api/events` upstream as defensive config; misconfigure and SSE buffers until the connection closes.
- In-process bus is not durable. App restart drops all connections; clients reconnect and refetch (acceptable, same posture as ADR-0021's notification publisher).
- A non-200 answer to a reconnect — the proxy's 502 while the app restarts, a 401 after session revocation — closes `EventSource` for good. The client owns that recovery: it probes the session with backoff, then reopens or hands over to session-expired handling.
- v1 emission is tied to mutation call sites: out-of-band SQL writes do not fire events. `LISTEN`/`NOTIFY` upgrade closes this gap if it becomes load-bearing.
- Event-name broadcast to all authenticated sessions is a (deliberately) low-information signal but still a side channel — it leaks the existence of cross-domain mutations to roles that cannot read the affected entity. Acceptable under the project's threat model (single-tenant, role-trust within the customer organization, [ADR-0019](0019-worker-data-scoping-repository-layer-predicate.md)); recorded so the assumption is explicit.
- **Security audit required** under [CONTRIBUTING.md §Security audit](../../CONTRIBUTING.md#security-audit) — new long-lived authenticated network surface, broadcast semantics across role boundaries.

## References

- [ADR-0001](0001-generalized-system-with-configurable-customer-specifics.md) — single-tenant deployment shape
- [ADR-0004](0004-backend-stack-fastify-drizzle-node-postgres.md) — Fastify host for the SSE route
- [ADR-0019](0019-worker-data-scoping-repository-layer-predicate.md) — role scoping at the consumer endpoint
- [ADR-0021](0021-audit-log-and-notifications-single-write-path.md) — in-process post-commit publisher, reused architectural shape
- [Issue #171](https://github.com/Projekt-Manager-Org/Projekt-Manager/issues/171) — first consumer (storage usage UI)
- [WHATWG HTML §Server-sent events](https://html.spec.whatwg.org/multipage/server-sent-events.html) — protocol reference
- [Caddy v2 `reverse_proxy` — `flush_interval`](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy#flush_interval) — buffering directive
- [CONTRIBUTING.md §Security audit](../../CONTRIBUTING.md#security-audit) — trigger satisfied
