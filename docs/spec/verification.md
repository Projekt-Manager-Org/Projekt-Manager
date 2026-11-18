# Verification

---

## 15. Acceptance Criteria

The system is accepted when all of the following are true. Each test cites the IDs of the criteria it verifies.

Every criterion carries exactly one tier marker:

- **`[crit]`** — **Critical**: a defect means data corruption, financial impact, authentication/authorization failure, data integrity violation, or misleading state that causes wrong user decisions. Verified by automated test. The method matches the contract's surface — unit, integration, E2E or a mix thereof.
- **`[vis]`** — **Visual / Design**: specifies expected behavior that does not guard a critical path. Verified by structural E2E as well as regular human review.
- **`[infra]`** — **Infrastructure / Structural**: a constraint on the deployed environment, the build pipeline, or the source-tree organization. Verified by deployment procedures, CI gates, lint, or code review — not by tests against the running system.

**IDs.** An ID's meaning never changes, and an ID is never reused.

- Split → the old ID retires; every part gets a new ID. A narrowed ID would keep stale citations resolving.
- Merge of duplicates → the survivor keeps its ID; the other retires.
- Delete → the ID retires.

**Shape.** One AC states one behavior, in one of these forms (EARS):

- `When <trigger>, the system <response>.`
- `If <unwanted condition>, the system <response>.`
- `While <state>, the system <response>.`
- `The system <property>.`

What an AC carries and where the rest goes: [index.md § Placement](index.md#placement).

### 15.1 Workflow Board

States, their order and per-state values: [index.md §3](index.md#3-workflow-states). What the screens show: [ui/workflow-views.md](ui/workflow-views.md).

- **AC-7** `[crit]`: When a user changes a planned date in the detail panel, the system stores it.
- **AC-11** `[vis]`: Action-state columns are visually distinct from buffer-state columns.
- **AC-12** `[vis]`: Each state has one color, the same on card dots, calendar bars and the detail panel badge.
- **AC-44** `[vis]`: When a user clicks a collapsed column, it expands; clicking its header again collapses it.
- **AC-452** `[vis]`: The board shows one column per workflow state, in [index.md §3](index.md#3-workflow-states) order.
- **AC-453** `[vis]`: Each project on the board sits in the column of its state.
- **AC-454** `[vis]`: The board orders each column's cards by entry date, oldest first.
- **AC-455** `[vis]`: The calendar shows a project with a planned start and end as a bar spanning those dates.
- **AC-456** `[vis]`: The calendar shows a project with a planned start and no end as a one-day block on its start date.
- **AC-457** `[crit]`: When a user clicks a card's forward or backward button, the system asks for confirmation, naming the current and the target state.
- **AC-458** `[crit]`: When a user confirms a transition, the system stores the target state as the project's state.
- **AC-459** `[crit]`: If a transition request breaks the transition rule of [index.md §3](index.md#3-workflow-states), the system refuses it as a validation error ([api.md §14.4.1](api.md#1441-error-categories)) and changes nothing.
- **AC-460** `[vis]`: A card offers the forward and backward buttons only where [index.md §3](index.md#3-workflow-states) allows the transition.
- **AC-461** `[vis]`: While a project has been in an action or buffer state for at least that state's aging threshold, counted in calendar days, its card shows the entry date in bold.
- **AC-462** `[vis]`: While a project has been in a buffer state for at least its aging threshold, its card shows "seit X Tagen", X being the days in that state.
- **AC-463** `[vis]`: While a buffer column holds projects at or past its aging threshold, its header signals them: with their count and the threshold when expanded, with a marker when collapsed.
- **AC-464** `[vis]`: While projects without planned dates exist, the calendar shows their count.
- **AC-465** `[vis]`: When a user clicks the calendar's no-dates counter, the system shows the board with only the projects that have no planned dates.
- **AC-466** `[vis]`: When a user clicks "Filter aufheben", the system removes the no-dates filter.
- **AC-467** `[vis]`: When a user switches views, the system removes the no-dates filter.
- **AC-468** `[vis]`: The system shows dates in the configured display format ([`[C]`](architecture.md#122-company-configurable-settings), default DD.MM.YYYY); a range within one year shortens its start to DD.MM.
- **AC-469** `[vis]`: Calendar weeks start on Monday.
- **AC-470** `[vis]`: When the board is too narrow for all its columns expanded, the system collapses columns by tier ([index.md §3](index.md#3-workflow-states)), highest tier first.
- **AC-471** `[vis]`: When a user clears the planned start in the detail panel while a planned end is set, the system clears both.
- **AC-472** `[vis]`: When a user opens the Project Detail Page from the detail panel and then navigates back, the system shows the view the panel was opened from.
- **AC-473** `[vis]`: While the viewport is wider than 768 px, when a user clicks a project on the board or in the calendar, the system opens its detail panel ([ui/workflow-views.md §8.4](ui/workflow-views.md#84-project-detail-panel)).
- **AC-474** `[vis]`: While the viewport is at most 768 px wide, when a user clicks a project on the board or in the calendar, the system opens its Project Detail Page ([ui/project-detail.md §8.15](ui/project-detail.md#815-project-detail-page)).

### 15.4 Authentication

What the login screen shows: [ui/index.md §8.1.1](ui/index.md#811-unauthenticated-state). Sessions: [data-model.md §5.4](data-model.md#54-session).

- **AC-573** `[crit]`: While a user is not signed in, the system shows only the login screen.
- **AC-574** `[crit]`: If a request for protected data carries no session, the system refuses it as an authentication error.
- **AC-23** `[crit]`: If a user submits invalid credentials, the system shows a generic error message in German.
- **AC-24** `[vis]`: While a user is signed in, the header shows their display name.
- **AC-25** `[crit]`: When a user clicks "Abmelden", the system signs them out and shows the login screen.
- **AC-26** `[crit]`: If a user presses the browser back button after signing out, the system shows no project data.
- **AC-27** `[crit]`: If a session expires while the app is open, the system shows the login screen with an expiry message.
- **AC-572** `[crit]`: If a request carries an expired session token, the system refuses it as an authentication error.
- **AC-28** `[crit]`: If a request carries a valid session token of a deactivated user, the system refuses it as an authentication error.
- **AC-395** `[vis]`: While a session is valid, reloading the app keeps the user signed in.
- **AC-396** `[crit]`: If a login attempt fails — unknown username, wrong password, or deactivated account — the system returns the same error.
- **AC-566** `[crit]`: When a user submits valid credentials, the system signs them in and shows the landing view of their role ([ui/index.md §8.7.1](ui/index.md#871-views)).
- **AC-547** `[crit]`: When a user submits their correct current password and a new one, the system stores the new password.
- **AC-548** `[crit]`: If the submitted current password is wrong, the system refuses the change and keeps the password.
- **AC-549** `[crit]`: When a user changes their own password, the system ends that user's other sessions and keeps the current one.
- **AC-550** `[crit]`: If a password set on create, change or reset violates the password policy ([data-model.md §5.3](data-model.md#53-user-entity)), the system refuses it as a validation error and stores nothing.
- **AC-568** `[crit]`: The system applies a self-update only to the caller's own record and only to `themePreference` and `pushMuted`.
- **AC-569** `[crit]`: If the first-run bootstrap password violates the password policy, the system refuses to start ([ADR-0010](../adr/0010-first-run-admin-bootstrap.md)).
- **AC-551** `[crit]`: When a user signs out, the system ends that session only.
- **AC-552** `[crit]`: The system delivers the session token only in a cookie that page scripts cannot read and the browser withholds from cross-site requests ([ADR-0005](../adr/0005-session-management-httponly-cookies.md)).

### 15.5 Multi-User

- **AC-29** `[crit]`: Two users logged in simultaneously see each other's changes after refreshing.

### 15.6 Deployment

- **AC-30** `[infra]`: The application is reachable by authorized clients over HTTPS. HTTPS is required by default; the only documented exception is the guarded evaluation mode (see AC-45). Network reachability is scoped by [ADR-0008](../adr/0008-vpn-first-network-access.md); see also AC-49.
- **AC-31** `[infra]`: A CI-built image can be promoted to the hosted environment via manual, pull-based deploy over VPN (see [ADR-0012](../adr/0012-manual-pull-based-deploy-over-wireguard.md)).
- **AC-45** `[crit]`: HTTPS is enforced by default. HTTP-only mode requires an explicit opt-in flag AND a non-production environment (neither alone is sufficient). When HTTP mode is active, the UI shows a non-dismissible warning banner on every page. Enabling the insecure flag in production causes the server to refuse to start. See [ADR-0013](../adr/0013-http-only-evaluation-mode.md).
- **AC-46** `[infra]`: A failed deployment leaves the previously running version running.
- **AC-47** `[infra]`: A previously deployed commit can be redeployed (rollback) by the operator over VPN, within the retention window its image survives in — see [ADR-0012](../adr/0012-manual-pull-based-deploy-over-wireguard.md) and [ADR-0011 § Retention](../adr/0011-build-images-in-ci-distribute-via-ghcr.md). Beyond it, rollback is forward-only (revert + redeploy).
- **AC-48** `[infra]`: After every deploy, an automated smoke test verifies the health endpoint. Failure aborts the deploy.
- **AC-49** `[infra]`: The hosted environment is reachable only via VPN. See [ADR-0008](../adr/0008-vpn-first-network-access.md).
- **AC-50** `[infra]`: Database and object storage data persist across container restarts and redeploys.
- **AC-51** `[infra]`: Deployments use a specific commit SHA, not a moving tag.

### 15.7 Engineering

- **AC-32** `[infra]`: Code structure and dependency direction follow [architecture.md §11.2](architecture.md#112-responsibility-boundaries). No reverse imports.
- **AC-33** `[infra]`: Mutation boundary per [architecture.md §11.1](architecture.md#111-mandatory-constraints) is enforced. UI components dispatch through the state layer, not directly to the API client.
- **AC-34** `[infra]`: State configuration (labels, colors, thresholds) is centralized, not scattered.
- **AC-35** `[infra]`: Dependency direction is enforced by linter import restriction zones.
- **AC-36** `[infra]`: Linting and formatting pass.
- **AC-37** `[infra]`: Tests defined in section 16 pass. The PR and merge-queue gate runs unit, component, and API integration tests (a push re-runs them only when its commit has no published image set). E2E tests run nightly against the protected branch and on demand, and a failed run raises a tracked issue (see [architecture.md §11.7](architecture.md#117-continuous-delivery-pipeline)).
- **AC-343** `[infra]`: The role-permission matrix published in [api.md §14.3](api.md#143-authorization-rules) matches the codebase's authorization configuration — a CI-enforced check fails the build when the published table and the configuration diverge, and fails rather than passing vacuously when the table's delimiters are absent. Every role in that configuration is exhaustively classified as production-facing or test-only; an unclassified role fails CI. Only production-facing roles appear in the published matrix, and any other consumer of the production-role set derives it from the same classification rather than maintaining an independent list.
- **AC-349** `[infra]`: The per-role navigation matrix published in [ui/index.md §8.7.1](ui/index.md#871-views), and the first-match landing order published with it, match the route table — a CI-enforced check fails the build when the published content and the route table diverge, and fails rather than passing vacuously when its delimiters are absent. Each route declares its access rule as data, so the published matrix carries the rule itself (the required permission, or the admitted roles) alongside the role set that rule resolves to over the production role set; a route whose gate is a permission is not published as a bare list of today's role holders. The check covers the matrix and the landing order; the per-view prose around them is hand-authored.
- **AC-347** `[infra]`: Every file and called function cited in tracked documentation exists — a CI-enforced check fails the build on a citation of a renamed or deleted one. Three citation forms are claims: a repository path; a file name whose extension some tracked file carries, which resolves when a tracked path ends with it at a path-segment boundary, so a partial path (`routes/auth.ts`) singles out a name several files share; and a call-form identifier (`name()`), which resolves when its final name segment occurs as a whole word in a tracked file other than documentation. Line-number and symbol suffixes are stripped before a path resolves; an extensionless module reference resolves as the module it names. Globs and host paths (absolute, or prefixed `~/` or `./`) are not claims. Citations that name a nonexistent file or function on purpose — an illustrative walkthrough, a decision record naming what it superseded, a declared coverage gap, or a name outside the tracked tree (on a host, in a dependency or external project, built, or created at run time) — are exempted per document with a stated reason, so an exemption earned by one document does not cover the same citation elsewhere.
- **AC-348** `[infra]`: Every relative file link and `#anchor` fragment in tracked documentation resolves — a CI-enforced check fails the build on a broken internal link. Fragment resolution follows GitHub's heading-slug algorithm and honours inline HTML anchors, so a document that anchors a non-heading element is not reported broken. Links to directories that exist are valid. External and mail targets are not resolved: the check performs no network requests, so a third-party host cannot fail the build.
- **AC-351** `[infra]`: The OpenAPI document at `docs/api/openapi.json` is generated from the route definitions' declared request schemas, not hand-authored — a CI-enforced check fails the build when the published artifact and the route definitions diverge, and a second check fails the build when the generated document is not valid against the API-description format it declares. The document publishes only what the route definitions support: where a route declares no response, the published operation is silent about responses rather than asserting a default one. Its endpoint surface is complete for the API, enforced from both ends: every route a client calls is registered by the application factory, and a route registered anywhere else fails the build; and a registered route the document does not publish fails the build too, so a description tool that drops a route by default cannot silently shrink the published surface. A route excluded from the document declares that exclusion at its registration site. Serving the compiled front-end's own static files is the one exception, registered outside the factory and deliberately absent from the document; it is declared at the registration site, so it cannot grow silently. It is a derived view, not the contract — [api.md §14.2](api.md#142-operations) remains normative, which is why the artifact lives outside the spec directory.
- **AC-352** `[infra]`: The endpoint table published in `docs/api/README.md` is generated from the routes the application factory registers, not hand-authored — a CI-enforced check fails the build when the published table and the registered routes diverge. Every published column is read off the route itself: each access gate declares its rule as data, so the table carries the rule (the required permission keys, or the admitted roles) rather than a restatement beside it, and a session gate applied to a whole route group marks the routes it protects, so an endpoint is published as public because no gate reaches it and not because a hand-kept list says so. Endpoint prose outside the generated block is hand-authored and is not overwritten.
- **AC-353** `[infra]`: The generated OpenAPI document states, per operation, whether a session is required — derived from the access gates the routes themselves carry, not from a hand-kept list of public endpoints. The authentication scheme is declared once, and every published operation carries either that requirement or an explicit empty one, so an operation publishes as unauthenticated because no gate reaches its route and not because an allowlist says so. The derivation is total: a published operation the generator cannot trace back to a registered route fails the build, rather than publishing silently with no requirement at all — the fail-open direction, which would understate the protection the server actually enforces. A route whose only gate rejects unauthenticated callers without a session gate ahead of it fails the build for the same reason: it would publish as unauthenticated while refusing every caller.
- **AC-354** `[infra]`: The catalogue of machine-readable error codes published in [api.md §14.4.1](api.md#1441-error-categories) matches the single definition the server raises errors from — a CI-enforced check fails the build when the two diverge in either direction, and fails rather than passing vacuously when the catalogue's delimiters are absent. That definition has one runtime form, and the type every error is constructed against is derived from it rather than restated beside it, so the set the server can raise and the set the contract declares cannot disagree. Every published code is minted by a named factory, so the contract cannot promise a code no factory produces. The check covers the set of codes; the per-code prose around it is hand-authored.
- **AC-380** `[infra]`: Every route the application factory registers under a method other than `GET` or `HEAD` is classified as versioned or exempt — a CI-enforced check fails the build on an unclassified route. Each exemption names its reason (e.g. no prior read, no shared editable row, own state check, a non-versioned case in [data-model.md §6.4](data-model.md#64-concurrency)). A self-test with a planted unclassified route goes red.
- **AC-383** `[infra]`: Every authenticated route the application factory registers whose access gates admit the worker role is either probed for worker data scoping ([ADR-0019](../adr/0019-worker-data-scoping-repository-layer-predicate.md)) or exempt with a named reason. A CI-enforced check fails the build on a route that is neither. Probes run as a worker against seeded data: a request whose entity ids all belong to a project the worker is not assigned to is refused; a request naming an assigned project and a child entity of an unassigned one is refused; a read naming no entity returns no entity of an unassigned project. "Refused" means `403` or `404`, or `422` where the route's own AC rejects a foreign id as invalid input ([AC-414](#1526-attachments)). A self-test goes red on a planted route that skips the scope check, one that skips the parent binding, one that leaks an out-of-scope entity from a read, and one left unclassified.
- **AC-247** `[crit]`: Transport-layer rejections from the API server preserve the 4xx HTTP statusCode native to the failure class and ship a stable machine-readable code, per [api.md §14.4.2](api.md#1442-error-principles): a malformed body declared as `Content-Type: application/json` returns `400 VALIDATION_ERROR`; a payload exceeding the configured maximum returns `413 VALIDATION_ERROR`; a request whose `Content-Type` falls outside the accepted set returns `415 VALIDATION_ERROR`; a request whose method and URL match no registered handler returns `404 ROUTE_NOT_FOUND`. Pre-existing branches are unchanged: schema-validation rejections remain `422 VALIDATION_ERROR` (with the field-level `details` array preserved), rate-limit rejections remain `429 RATE_LIMITED`, and any error whose statusCode is in the 5xx range — or carries no statusCode — maps to `500 SERVER_ERROR`. Every 5xx response logs at the operational `error` level — an application error carrying its own 5xx code included, since answering 500 silently hides a genuine server failure from triage; transport-layer 4xx rejections log below that level. Tiered `[crit]` because the contract guards operator triage: a transport-layer 4xx surfacing as 5xx (response or log) misroutes oncall attention away from genuine server failures.
- **AC-1** `[vis]`: The full stack (frontend, backend, database) starts locally with a documented command or minimal command sequence.

### 15.8 Configurability

- **AC-38** `[vis]`: App name (header) and footer text are driven by a branding config, not hardcoded in components. Changing the config changes all instances.
- **AC-39** `[crit]`: The system takes the session duration from configuration.

### 15.11 Customer Management

- **AC-518** `[crit]`: When a user creates a customer with a name, the system stores it.
- **AC-539** `[vis]`: When a user has created a customer, the customer list shows it, unless the active search excludes it.
- **AC-124** `[crit]`: When a customer create is retried after its response was lost, the system stores the customer once.
- **AC-519** `[crit]`: When a user saves the customer edit form, the system stores the entered values, an emptied phone, email, USt-IdNr. or notes as empty, and an address with all three fields emptied as no address.
- **AC-520** `[crit]`: If a save would leave a customer without a name, the system refuses it as a validation error ([api.md §14.4.1](api.md#1441-error-categories)) and changes nothing.
- **AC-537** `[crit]`: If a save would store a customer name of only whitespace, the system refuses it as a validation error ([api.md §14.4.1](api.md#1441-error-categories)) and changes nothing.
- **AC-538** `[crit]`: If a save would exceed a customer field limit ([§5.6](data-model.md#56-customer-entity)), the system refuses it as a validation error ([api.md §14.4.1](api.md#1441-error-categories)) with a German message and changes nothing.
- **AC-521** `[crit]`: If a save would store a customer address missing its street, zip or city, the system refuses it as a validation error ([api.md §14.4.1](api.md#1441-error-categories)) with a German message and changes nothing.
- **AC-522** `[vis]`: The customer create and edit forms offer USt-IdNr. and notes.
- **AC-523** `[crit]`: When a user creates an invoice draft for a project whose customer has a USt-IdNr., the draft's recipient carries it.
- **AC-524** `[vis]`: When a user types in the customer list search, the system shows only customers whose name contains the text, ignoring letter case.
- **AC-525** `[vis]`: When a user clicks a column header of the customer list, the system sorts the list by that column; clicking it again reverses the order.
- **AC-526** `[vis]`: When a user clicks a customer row, the system opens that customer's edit form.
- **AC-527** `[vis]`: While a user types a name in the customer create form, the system lists existing customers whose name contains the text, ignoring letter case.
- **AC-528** `[vis]`: When a user picks a customer listed in the create form, the system closes the form and opens that customer's edit form.
- **AC-529** `[vis]`: If the name search in the customer create form fails, the system lists nothing, shows no error, and the form keeps working.
- **AC-536** `[vis]`: When a user submits a name that a customer listed in the create form also has, ignoring letter case and surrounding whitespace, the system creates the customer only after the user confirms with "Trotzdem erstellen"; cancelling returns to the form and creates nothing.
- **AC-85** `[vis]`: When a user has created a customer, the system lets them create a project for it without a page reload.
- **AC-530** `[crit]`: When a user deletes a customer with no active project and no issued or cancelled invoice, the system removes it.
- **AC-531** `[crit]`: When the system removes a customer ([AC-530](#1511-customer-management)), it permanently deletes the customer's archived projects with it, with their worker assignments and draft invoices ([ADR-0017](../adr/0017-soft-delete-as-board-archive.md)).
- **AC-540** `[crit]`: When a customer delete removes archived projects, the system deletes their attachments and hides their stored objects ([ADR-0022](../adr/0022-binary-storage-b2-compliance-object-lock.md)).
- **AC-541** `[crit]`: If a customer delete fails part-way, the system changes nothing.
- **AC-92** `[crit]`: If a customer has an active project, the system refuses deleting the customer as a conflict ([api.md §14.4.1](api.md#1441-error-categories)) and changes nothing.
- **AC-532** `[crit]`: If a customer without an active project has an issued or cancelled invoice on an archived project, the system refuses deleting the customer as a conflict ([api.md §14.4.1](api.md#1441-error-categories)) with a German message saying why and changes nothing ([ADR-0026](../adr/0026-invoices-immutability-and-zugferd.md)).
- **AC-534** `[crit]`: When a user starts deleting a customer with archived projects, the confirmation warns that they will be permanently deleted with it and names their count.
- **AC-535** `[vis]`: When a user starts deleting a customer without archived projects, the confirmation names the customer.
- **AC-533** `[crit]`: If the archived-project count cannot be loaded when a user starts deleting a customer, the system shows the error and opens no confirmation.

### 15.12 Projects

Fields: [data-model.md §5.1](data-model.md#51-project-entity). What the screens show: [ui/management.md §8.8](ui/management.md#88-project-management-view), [ui/project-detail.md §8.15](ui/project-detail.md#815-project-detail-page). Who may do what: [api.md §14.3](api.md#143-authorization-rules).

- **AC-475** `[crit]`: When a user creates a project with a number, title and customer, the system stores it in the first workflow state.
- **AC-476** `[crit]`: If a user creates a project with a number another project already has, archived ones included, the system refuses it as a conflict ([api.md §14.4.1](api.md#1441-error-categories)) with a German message naming the number, and creates nothing.
- **AC-477** `[crit]`: When a project create is retried after its response was lost, the system stores the project once.
- **AC-478** `[vis]`: When a user leaves the number field of the create form, the system shows whether another project, archived ones included, already uses the number.
- **AC-479** `[vis]`: The free / taken verdict of the number field always refers to the number currently in the field.
- **AC-480** `[crit]`: When a user edits the title, a planned date, the estimated value or the notes on the Project Detail Page, the system stores the change.
- **AC-511** `[vis]`: When a user clears the planned start on the Project Detail Page while a planned end is set, the system clears both.
- **AC-482** `[crit]`: If a date change would leave a planned end without a planned start, or before it, the system refuses it as a validation error ([api.md §14.4.1](api.md#1441-error-categories)) with a German message and changes nothing.
- **AC-481** `[crit]`: When a user adds or removes an assigned worker on the Project Detail Page, the system stores the new assignment.
- **AC-515** `[crit]`: If a project create or edit would assign a user who is not an active worker, the system refuses it as a validation error ([api.md §14.4.1](api.md#1441-error-categories)) with a German message and changes nothing. A worker already assigned stays assigned after deactivation.
- **AC-483** `[crit]`: When a user saves the Baustelle group with "Identisch mit Kundenadresse" on, the system stores no site address for the project.
- **AC-484** `[crit]`: When a user saves the Baustelle group with the toggle off, the system stores the entered street, zip and city as the project's site address.
- **AC-485** `[crit]`: If a save would store a site address missing its street, zip or city, the system refuses it as a validation error ([api.md §14.4.1](api.md#1441-error-categories)) with a German message and changes nothing.
- **AC-486** `[vis]`: The create form's Baustelle toggle starts on.
- **AC-510** `[vis]`: When a user edits a project's Baustelle, the toggle starts off, with the address filled in, exactly when the project has its own site address.
- **AC-487** `[vis]`: While the Baustelle toggle is on, the address inputs are disabled and show the customer's address.
- **AC-488** `[vis]`: When a user switches the Baustelle toggle, the system changes nothing stored until the user saves.
- **AC-489** `[vis]`: While a project has its own site address, its Baustelle line shows it.
- **AC-490** `[vis]`: While a project has no site address and its customer has an address, the Baustelle line shows the customer's address followed by "(Kundenadresse)".
- **AC-491** `[vis]`: While neither the project nor its customer has an address, the Baustelle line reads "Keine Adresse".
- **AC-283** `[vis]`: The Baustelle line carries exactly one map link, to the address it shows; with no address shown, it carries none.
- **AC-492** `[vis]`: While "Archivierte einblenden" is on, the project list also shows archived projects.
- **AC-153** `[vis]`: While "Archivierte einblenden" is on, the project list marks each archived project with an `Archiviert` badge and muted text; active projects carry neither.
- **AC-493** `[vis]`: When a user types in the project list search, the system shows only projects whose number, title or customer name contains the text, ignoring letter case.
- **AC-494** `[vis]`: When a user clicks a sortable column header of the project list, the system sorts the list by that column; clicking it again reverses the order.
- **AC-495** `[vis]`: When a user selects workers or "Nicht zugewiesen" in the Mitarbeiter filter, the system shows only projects assigned to a selected worker, plus those without workers if "Nicht zugewiesen" is selected.
- **AC-496** `[vis]`: When a user clicks a project row in the project list, the system opens its Project Detail Page.
- **AC-497** `[crit]`: When a user archives a project, the system removes it from the board, the calendar and the default project list.
- **AC-498** `[crit]`: When a user restores an archived project, the system makes it active again, in the state it had.
- **AC-512** `[crit]`: If a user restores a project that is not archived, the system refuses it as a conflict ([api.md §14.4.1](api.md#1441-error-categories)) and changes nothing.
- **AC-499** `[crit]`: If a request would change an archived project — a transition, an edit, its dates, its workers, or archiving it again — the system refuses it as not found ([api.md §14.4.1](api.md#1441-error-categories)) and changes nothing.
- **AC-506** `[vis]`: When a user clicks `Archivieren` or `Wiederherstellen`, the system asks for confirmation naming the project.
- **AC-501** `[vis]`: The system offers `Endgültig löschen` only on archived projects.
- **AC-505** `[crit]`: When a user clicks `Endgültig löschen`, the system asks for confirmation naming the project and warning that its data is lost for good.
- **AC-502** `[crit]`: When a user permanently deletes an archived project, the system removes it with its worker assignments and draft invoices; its attachments go per [AC-428](#1526-attachments).
- **AC-503** `[crit]`: If a user permanently deletes a project that is not archived, the system refuses it as a conflict ([api.md §14.4.1](api.md#1441-error-categories)) and changes nothing.
- **AC-504** `[crit]`: If an archived project has an issued or cancelled invoice, the system refuses its permanent deletion as a conflict ([api.md §14.4.1](api.md#1441-error-categories)) with a German message giving that reason, and changes nothing.
- **AC-509** `[vis]`: When a user who may read a project ([api.md §14.3](api.md#143-authorization-rules), [AC-581](#1521-role-scoping)) opens its Project Detail Page, the system shows it.
- **AC-507** `[vis]`: If a worker opens the Project Detail Page of a project they are not assigned to, the system shows the not-permitted surface ([AC-149](#1521-role-scoping)).
- **AC-508** `[vis]`: If a user opens the Project Detail Page of a project that does not exist, the system shows a not-found message.
- **AC-500** `[vis]`: While a project is archived, its Project Detail Page shows an archived notice and offers no change other than `Wiederherstellen` and `Endgültig löschen`.
- **AC-207** `[vis]`: While the detail panel is open, it offers `Öffnen`, which opens the project's Project Detail Page.
- **AC-277** `[crit]`: When a project changes — its customer and assigned workers included — every open view showing the project shows the change within 2 seconds, without a reload.

### 15.13 User Management

Fields and password policy: [data-model.md §5.3](data-model.md#53-user-entity). What the view shows: [ui/management.md §8.10](ui/management.md#810-user-management-view).

- **AC-63** `[crit]`: When an owner creates a user with username, display name, password and roles, the system stores the account and the user can log in with those credentials.
- **AC-66** `[crit]`: When an owner reactivates a deactivated user, the system marks the account active and the user can log in again.
- **AC-68** `[crit]`: If a user tries to deactivate their own account, the system refuses it and changes nothing.
- **AC-575** `[crit]`: If a user's edit of their own roles would leave them without `user:manage`, the system refuses it as a validation error ([api.md §14.4.1](api.md#1441-error-categories)) and changes nothing.
- **AC-394** `[crit]`: The system never sends a password hash to a client, except inside an export archive ([data-model.md §5.8](data-model.md#58-export-archive)).
- **AC-553** `[crit]`: When an owner changes a user's display name, roles or email, the system stores them.
- **AC-554** `[vis]`: The user panel offers display name, roles and email for editing.
- **AC-555** `[crit]`: When an owner deactivates a user, the system marks the account inactive.
- **AC-570** `[crit]`: When an owner deactivates a user, the system ends all that user's sessions.
- **AC-556** `[crit]`: When an owner resets a user's password, the system stores the new password without asking for the current one.
- **AC-557** `[crit]`: When an owner resets a user's password, the system ends all that user's sessions.
- **AC-558** `[crit]`: If a user tries to delete their own account, the system refuses it and changes nothing.
- **AC-559** `[crit]`: When an owner deletes a user, the system removes the account with its sessions and worker assignments.
- **AC-567** `[crit]`: When an owner deletes a user, the system keeps the records that user created or last edited and clears those references, except on other user accounts ([data-model.md §6.6](data-model.md#66-referential-integrity)).
- **AC-560** `[crit]`: If an owner deletes a user whom an issued or cancelled invoice names as creator or last editor, the system refuses it with a German message pointing to deactivation and changes nothing.
- **AC-561** `[crit]`: When an owner deletes a user whom only draft invoices name, the system deletes the user and clears those references on the drafts.
- **AC-562** `[vis]`: The system admits only users with `user:manage` to the user management view; `user:read` alone is not enough.
- **AC-563** `[vis]`: The user management view lists all users, including deactivated ones.
- **AC-571** `[vis]`: The user management view shows deactivated users as visually distinct.
- **AC-564** `[crit]`: If an owner creates a user with a username already in use, the system refuses it and creates nothing.
- **AC-565** `[crit]`: If a user create or edit violates a blank, length or role-set constraint of [data-model.md §5.3](data-model.md#53-user-entity), the system refuses it as a validation error and changes nothing.

### 15.14 Data Exchange

Export and import of the whole deployment. Archive format: [data-model.md §5.8](data-model.md#58-export-archive); job states: [§5.18](data-model.md#518-data-exchange-job); screens: [ui/daten.md §8.11](ui/daten.md#811-daten-view).

- **AC-142** `[vis]`: The Daten navigation tab is hidden for users without `data:export`.
- **AC-583** `[crit]`: When a user starts an export, the system builds an archive of the deployment in the format of [data-model.md §5.8](data-model.md#58-export-archive).
- **AC-584** `[crit]`: The system puts into an export archive exactly the attachment files its data lists.
- **AC-585** `[crit]`: If an attachment's content cannot be read while an export is built, the system ends the export as failed, naming the attachment, and offers no archive.
- **AC-586** `[vis]`: When an export is ready, the Daten view offers its archive for download.
- **AC-608** `[vis]`: When an export's archive has been deleted, the Daten view no longer offers its download and offers to start a new export.
- **AC-587** `[vis]`: When an export or import fails, the Daten view shows the failure reason.
- **AC-588** `[crit]`: When the download of an export is interrupted, the system lets it resume where it stopped.
- **AC-589** `[crit]`: When the takeout staging TTL **[C]** has passed since an export or import ended, the system deletes the archive it holds for that job.
- **AC-590** `[crit]`: When an export or import starts, the system deletes the archives it holds for earlier jobs of the same kind.
- **AC-331** `[crit]`: While an export or import is in progress, the system refuses to start another of the same kind as a conflict ([api.md §14.4.1](api.md#1441-error-categories)); an ended one does not block a new start.
- **AC-601** `[vis]`: When a user starts an export or import while one of the same kind is in progress, the Daten view shows the one in progress.
- **AC-602** `[vis]`: While an export or import is in progress, the Daten view shows its progress as it advances.
- **AC-603** `[vis]`: When a user opens the Daten view while an export or import is in progress, the view shows its progress.
- **AC-600** `[crit]`: If the server restarts while an export or import is in progress, the system ends it as failed.
- **AC-332** `[crit]`: When an export or import ends, the system records exactly one audit entry for it.
- **AC-161** `[vis]`: The Import dialog shows an input for the confirmation phrase **[C]** and keeps its start action disabled until the typed text matches the phrase.
- **AC-591** `[crit]`: If an import would replace a deployment that holds customers, projects, invoices or attachments and does not confirm the replacement, the system refuses it as a conflict ([api.md §14.4.1](api.md#1441-error-categories)) before the archive is uploaded and changes nothing.
- **AC-592** `[crit]`: If the confirmation that [AC-591](#1514-data-exchange) requires does not match the confirmation phrase **[C]**, the system refuses it as a validation error ([api.md §14.4.1](api.md#1441-error-categories)) before the archive is uploaded and changes nothing.
- **AC-605** `[vis]`: While no import is in progress, when a user picks an archive to import, the Daten view shows the confirmation for it, never the result of an earlier import.
- **AC-606** `[vis]`: While the viewport is narrower than the mobile-warning breakpoint **[C]**, the Export and Import dialogs show the large-transfer warning and still let the user start.
- **AC-599** `[crit]`: If an import's upload makes no progress for the takeout staging TTL **[C]**, the system ends the import as failed and deletes the partial upload.
- **AC-609** `[crit]`: While an import's upload is in progress, when a user picks an archive whose size equals the upload's total size and confirms it ([AC-161](#1514-data-exchange)), the system continues the upload where the server stopped.
- **AC-610** `[vis]`: While an import's upload is in progress, when a user picks a file whose size differs from the upload's total size, the Import dialog says the file does not belong to the import in progress and uploads nothing.
- **AC-611** `[vis]`: While an import's upload is in progress and the open page is not uploading it, the Daten view says the upload is interrupted and how to continue it.
- **AC-593** `[crit]`: If an uploaded archive is not valid ([data-model.md §5.8](data-model.md#58-export-archive)), the system ends the import as failed, naming the reason, and changes nothing.
- **AC-367** `[crit]`: If an import would remove an issued or cancelled invoice, change its number, or put another document under its number, the system ends the import as failed and changes nothing ([data-model.md §6.14](data-model.md#614-immutability-of-issued-invoices)). A draft absent from the archive does not count.
- **AC-594** `[crit]`: When an import succeeds, the deployment holds exactly the business data and attachments of the archive, IDs included; its earlier business data, attachments and Papierkorb are gone. Invoice numbering follows [AC-369](#1514-data-exchange).
- **AC-369** `[crit]`: When an import restores invoice numbering, the system never lowers it: per year and kind, the next number is the higher of the deployment's and the archive's, and a year and kind the archive lacks keeps the deployment's ([data-model.md §6.13](data-model.md#613-gapless-sequence-allocation)).
- **AC-365** `[crit]`: When an import restores an invoice with a rendered PDF, the system restores the PDF byte-equal as that invoice's document — off the attachment surface ([AC-364](#1530-invoices)) and under the invoice lock ([AC-296](#1530-invoices)).
- **AC-595** `[crit]`: If an import cannot restore every attachment of the archive, the system ends it as failed.
- **AC-596** `[vis]`: When an import restores a photo, the system generates its thumbnail anew.
- **AC-597** `[crit]`: When an import replaces the users, the system ends every session.
- **AC-598** `[crit]`: When an import ends the importing user's session, the system continues the import.
- **AC-604** `[vis]`: When a user opens the Daten view after an import ended, the view shows the latest import's result until the user closes it; a page load shows it again.
- **AC-607** `[vis]`: When an import succeeds, the Daten view shows the number of files it restored.

### 15.15 Navigation

- **AC-74** `[vis]`: Navigation between all views (Meine Projekte, Kanban, Calendar, Projects, Customers, Users, Daten, Aktivität, Benachrichtigungen) works without page reload. Shared state is preserved across navigation.
- **AC-75** `[vis]`: Views that require specific permissions are hidden from navigation for unauthorized users. Per-role nav matrix (default role set — see [ui/index.md §8.7.1](ui/index.md#871-views) and [api.md §14.3](api.md#143-authorization-rules)): owner sees Kanban, Kalender, Projekte, Kunden, Rechnungen, Benutzer, Daten, Aktivität, Benachrichtigungen; office sees everything except Benutzer and Benachrichtigungen; worker sees Meine Projekte + Kanban + Kalender (all scoped — see [AC-579](#1521-role-scoping), [AC-580](#1521-role-scoping); Meine Projekte is worker-only by nav matrix); bookkeeper sees Projekte + Kunden + Rechnungen. A role-scoping visual-regression run must walk each role and confirm the nav set matches the matrix exactly.
- **AC-53** `[crit]`: A failed mutation displays a German error message and reverts the optimistic UI update.
- **AC-122** `[vis]`: Modals close on Escape (except while a mutation is in flight, see [AC-131](#1515-navigation)). Form modals submit the primary action on Enter when focus is within the form. Read-only modals accept Escape but do not submit on Enter.
- **AC-123** `[vis]`: Form modals and confirmation dialogs do not close on backdrop click — only via Escape or the explicit cancel action. Non-editing side panels close on backdrop click.
- **AC-131** `[crit]`: While a create, edit, or state-changing mutation is in flight, the form's submit action is disabled, every input in the form is disabled, and the enclosing modal cannot be closed (Escape, close button, backdrop). The lock covers any user-confirmation dialog that precedes request dispatch, so a submit initiated behind an open confirm does not fire a second time. The lock releases when the request resolves (success or failure). Rationale: silent double-dispatch or a close-during-flight produces state the user did not intend — a misleading-state class defect.

### 15.17 Data Integrity

- **AC-94** `[crit]`: A concurrent state transition on the same project is rejected as a conflict (per the conflict error category in [api.md §14.4.1](api.md#1441-error-categories)). The project remains in the state produced by the first transition.
- **AC-375** `[crit]`: A versioned edit — saving the customer edit form, Update draft, Delete draft, Upsert company profile ([api.md §14.2](api.md#142-operations)) — carrying a stale `expectedVersion` is rejected with `409` `VERSION_CONFLICT`. The row is unchanged; no audit row is written and no realtime event is emitted.
- **AC-376** `[crit]`: Issue invoice carrying a stale `expectedVersion` is rejected with `409` `VERSION_CONFLICT`. The invoice stays a draft without a number, the project keeps its status, no audit row, rendered artifact or realtime event is written, and the next successful issuance receives the number the rejected call would have received.
- **AC-377** `[crit]`: A versioned edit or Issue invoice without `expectedVersion` is rejected with `422 VALIDATION_ERROR`; the row is unchanged.
- **AC-378** `[crit]`: Every committed API write to a customer, draft invoice or the company profile changes its `version` — including the issuance of a draft — so a later versioned operation carrying the prior version is rejected per AC-375. Cancelling an issued invoice leaves its `version` unchanged.
- **AC-379** `[crit]`: An edit form whose entity is changed by another session and refreshed in the background after the form opened, then saved, receives `VERSION_CONFLICT`; the UI shows the stale-write message, displays the refetched values, and does not retry ([ui/behavior.md §9.5](ui/behavior.md#95-asynchronous-mutation-behavior)).
- **AC-381** `[crit]`: Two versioned writes to one entity carrying the same current `expectedVersion`, run concurrently — including Update draft concurrent with Issue invoice — result in exactly one commit; the other writes nothing and is rejected with `VERSION_CONFLICT`, or with the state error the check order puts first ([data-model.md §6.4](data-model.md#64-concurrency) — e.g. `INVOICE_FROZEN` for an Update draft that lost to Issue invoice).
- **AC-382** `[crit]`: The `Ausstellen` and `Verwerfen` confirmation dialogs on a draft row ([ui/project-detail.md §8.15.11](ui/project-detail.md#81511-invoice)) preview the draft's recipient, lines, `taxMode`, `performanceDate` and totals. If the draft changes after the dialog opened, confirming is rejected with `VERSION_CONFLICT` — a background refresh does not advance the version the dialog sends.
- **AC-96** `[crit]`: The database rejects a project row with a `status` value outside the valid workflow states (defense-in-depth CHECK constraint).
- **AC-97** `[crit]`: The database rejects a project row where `plannedEnd < plannedStart` (defense-in-depth CHECK constraint).
- **AC-99** `[crit]`: Project creation (insert + worker assignment) is atomic. If worker assignment fails, the project row is not persisted.
- **AC-127** `[crit]`: A create request carrying a client-supplied `id` that already identifies a row, but whose body differs from the stored row in any user-supplied field, is rejected with the `IDEMPOTENCY_CONFLICT` error code and the German message `"Diese Anfrage-ID wurde bereits mit abweichenden Daten verwendet."` The stored row is unchanged. Applies to both customer and project creation.
- **AC-516** `[crit]`: If a request body carries a field the operation does not define, at any depth, the system refuses it with `422 VALIDATION_ERROR` and changes nothing ([api.md §14.4.2](api.md#1442-error-principles)).
- **AC-390** `[crit]`: After `seed(db, { force: true })` completes, the database contains exactly the users enumerated in `SEED_USERS`, 21 customers, 19 projects, and 7 `project_workers` rows. Row counts are the seed's observable contract — drift breaks downstream tests and demo state. See [data-model.md §7](data-model.md#7-seed-data-specification).
- **AC-391** `[crit]`: After `seed(db, { force: true })` completes, the `users` table carries exactly the users enumerated in `SEED_USERS` — usernames and `active` flags match the constant, and `SEED_DEFAULT_PASSWORD` verifies against every stored `passwordHash`. (`SEED_USERS` and `SEED_DEFAULT_PASSWORD` are test-layer assumption constants pinning seed-produced values.) See [data-model.md §7](data-model.md#7-seed-data-specification).
- **AC-392** `[crit]`: After `seed(db, { force: true })` completes, every project `number` carries the year prefix matching the calendar year at seed time. See [data-model.md §7](data-model.md#7-seed-data-specification).
- **AC-164** `[crit]`: A malformed users fixture (missing required field, wrong type) causes the seed loader to throw a typed validation error before any row is inserted. No partial state lands in `users`. Rationale: silent partial seed corrupts dev and test state class-wide; fail-fast is the data-integrity posture.

### 15.18 Email Data Intake

- **AC-100** `[crit]`: An unauthenticated email extraction request is rejected with an authentication error.
- **AC-102** `[crit]`: Email text that is empty or exceeds 50,000 characters is rejected with a validation error.
- **AC-103** `[crit]`: A successful extraction returns a structured response with a `customer` section (name, phone, email, street, zip, city) and a `project` section (title, description). Fields not present in the input email are `null`.
- **AC-104** `[crit]`: An upstream extraction failure (missing configuration, unreachable service, unparseable response) is mapped to a server error. No internal details leak to the client.
- **AC-105** `[vis]`: The entry point to the email extraction modal is visible only to users with `customer:write` permission.
- **AC-106** `[vis]`: The extraction modal presents a paste textarea and an extract action. The action is disabled while the textarea is empty or an extraction is in flight.
- **AC-107** `[vis]`: After extraction, the modal presents editable customer and project fields for review and supports selecting an existing customer by name to avoid duplicates.

### 15.19 Theming

- **AC-108** `[infra]`: Palette and semantic color tokens are defined in a single source consumed by all components. No component or stylesheet references a palette color outside that source. State colors, applied from the state configuration array, are the single exception. A repository-wide check enforces this boundary.
- **AC-109** `[vis]`: Applying a non-default theme override on the document root replaces the semantic token layer. Components render with the overridden palette without code changes.
- **AC-110** `[vis]`: Dark mode renders via a dark theme override. Every semantic surface has a dark-appropriate value. All text/surface semantic pairs meet WCAG AA contrast — 4.5:1 for normal text and 3:1 for large text — in both light and dark.
- **AC-111** `[vis]`: The theme override is resolved and applied to the document root before the first paint of themed content. Reloading a session with a non-default preference shows no flash of the default theme.
- **AC-112** `[vis]`: When the user's theme preference is `'system'`, operating-system color-scheme changes propagate to the UI without a reload.
- **AC-113** `[infra]`: The brand accent is supplied by the branding configuration with explicit light and dark values. No component or stylesheet hardcodes the accent. A repository-wide check enforces this boundary.
- **AC-114** `[vis]`: Changing the configured accent value updates every accent-using surface — primary actions, links, focus rings, selection highlights, form input indicators — in both modes.

### 15.19a Brand Logo

- **AC-360** `[crit]`: `BRANDING.mark.logo` names an optional asset path, resolved against the static root the browser is served from. Resolution refuses, returning no asset, when the path is not an absolute same-origin one — the identical string is the browser's image source, so a relative or protocol-relative path would feed the two surfaces different bytes — when it does not name a file under that root's `brand/` directory (including a `..` traversal that resolves out of it), when the file's leading bytes are neither a PNG signature nor a JPEG SOI marker, when the file exceeds the 2 MB cap, or when it cannot be read. The format is sniffed from the bytes, never trusted from the extension. A file that is present but unusable is a refusal, not a reason to search a different root — embedding bytes other than the ones the browser loads would defeat the single-asset contract. Every refusal yields no asset rather than throwing: resolution runs inside the invoice-issuance transaction while it holds the gapless number-sequence row lock ([AC-286](#1530-invoices)), so a branding misconfiguration must never be able to abort an issuance.
- **AC-361** `[vis]`: With `BRANDING.mark.logo` unset, the header renders the generic mark painted from `BRANDING.mark.bg` / `.bars`, shown only at the narrow widths where the wordmark is hidden. With it set, the header renders the configured asset at every viewport width. The mark is decorative in both cases (`alt=""`, `aria-hidden`) — the accessible name comes from the enclosing navigation control. A configured asset that fails to load falls back to the generic mark, so a per-deployment path typo degrades rather than leaving a broken image on every page.
- **AC-362** `[crit]`: A rendered invoice embeds the configured logo as an image XObject in the issuer block, scaled to fit its box preserving aspect ratio and never enlarged past its natural size. With no logo configured, with one configured but unresolvable under AC-360, or with one whose bytes the document engine cannot decode, the invoice renders with no image and issuance completes normally — a branding asset is never able to fail an issuance, at either stage. The rules bracketing the line-item table are painted in `company_profile.accentColor` when set and `BRANDING.accent.light` otherwise; a malformed accent value falls back rather than throwing. The light variant is the correct default regardless of the reader's theme — the sheet is white.

### 15.19b App Shell Identity

- **AC-363** `[infra]`: The installation's name and its shell colors have one definition site each, in the branding configuration. `BRANDING.appName` is the served document's `<title>`, the PWA manifest's `name`, and the Service Worker's fallback notification title; `BRANDING.shortName` is the manifest's `short_name`; `BRANDING.shell.themeColor` is both the served document's `theme-color` meta and the manifest's `theme_color`; `BRANDING.shell.backgroundColor` is the manifest's `background_color`. The manifest is a build output, not a repository asset — the build and the development server serve one generated document, and no static copy of it ships alongside. It declares the installability fields and a maskable icon purpose, and every icon path it names resolves to a file that ships. The icon files are outside this boundary: they are square marks a deployment replaces wholesale, and they hold their own copies of the mark colors.

### 15.20 User Theme Preference

- **AC-115** `[crit]`: `themePreference` is stored on each user with a value from `'light' | 'dark' | 'system'`. New users default to `'system'`. The database enforces the allowed set via a CHECK constraint (defense in depth).
- **AC-116** `[crit]`: An authenticated user can update their own theme preference via the self-update API operation. Subsequent responses for the current user return the updated value.
- **AC-117** `[crit]`: A self-update request without a valid session is rejected with an authentication error.
- **AC-118** `[crit]`: A self-update request with an invalid theme value is rejected with a validation error.
- **AC-119** `[vis]`: The user menu exposes a 3-way theme selector ("Hell", "Dunkel", "Systemstandard"). Selecting an option updates the UI immediately and persists server-side; the selection survives a page reload.
- **AC-120** `[vis]`: On session hydration, the server-stored preference replaces any locally cached value. A client on a different device reflects the updated preference after the next session start.

### 15.21 Role Scoping

Who may do what: [api.md §14.3](api.md#143-authorization-rules). A worker, here, is a user whose only role is `worker`.

- **AC-576** `[crit]`: If a caller lacks what [api.md §14.3](api.md#143-authorization-rules) lists for an operation, the system refuses it as an authorization error ([api.md §14.4.1](api.md#1441-error-categories)) and changes nothing.
- **AC-577** `[crit]`: The system lets a user holding any role but `worker` reach every project and every customer, whatever other roles they hold.
- **AC-579** `[crit]`: When a worker lists projects, the system returns only those the worker is assigned to.
- **AC-580** `[crit]`: When a worker lists customers, the system returns only those referenced by a non-archived project the worker is assigned to.
- **AC-581** `[crit]`: If a worker reads a project they are not assigned to, the system refuses it as an authorization error, not as not-found.
- **AC-582** `[crit]`: If a worker reads a customer that no non-archived project assigned to them references, the system refuses it as an authorization error, not as not-found.
- **AC-578** `[crit]`: When a worker reads a customer, the system reveals nothing about the customer's projects or invoices beyond the worker's assigned projects.
- **AC-542** `[crit]`: When a worker reads an archived project, the system shows its customer's name and none of the customer's other details: phone, email, USt-IdNr., notes, and the address unless the project has no site address ([AC-490](#1512-projects)). Other roles see them all.
- **AC-121** `[crit]`: If a user lacks the permission a mutation needs, the system does not show the control that triggers it.
- **AC-149** `[vis]`: If a user opens by URL a view their roles may not access ([ui/index.md §8.7.1](ui/index.md#871-views)), the system shows the not-permitted surface in its place and keeps the URL.

### 15.22 Backup and Recovery

The database backup the [kickoff](../project/kickoff.md#done-when-final-product) requires; design in [ADR-0020](../adr/0020-layer-2-encrypted-r2-backups-with-operator-loaded-drills.md). A _backup_ is a database dump with its per-table manifest; a _drill_ restores the latest uploaded backup to prove it restores. Status record and mirror: [data-model.md §5.9](data-model.md#59-backup-status). Badge states: [ui/index.md §8.1.2](ui/index.md#812-authenticated-state).

- **AC-616** `[crit]`: While the system runs, it starts a backup at each scheduled backup time and a drill at each scheduled drill time **[C]** ([architecture.md §12.2](architecture.md#122-company-configurable-settings)).
- **AC-166** `[crit]`: When a backup's restored copy matches its source, the system uploads the backup and its manifest to the off-site store and records the run as succeeded at the run's time.
- **AC-165** `[crit]`: If a backup's restored copy differs from its source in any table, the system uploads nothing and records the run as failed, naming that table.
- **AC-344** `[crit]`: A backup and its manifest reflect one database state, so writes committed during the run do not fail its verification; a run that cannot read both from one state fails and uploads nothing ([ADR-0020](../adr/0020-layer-2-encrypted-r2-backups-with-operator-loaded-drills.md#snapshot)).
- **AC-174** `[crit]`: Two backups of the same database state carry equal manifests.
- **AC-366** `[crit]`: If the database runs without page checksums, a backup run fails before producing a backup and names the missing checksums.
- **AC-167** `[crit]`: The off-site store receives no backup or manifest readable without the operator's private identity ([ADR-0020](../adr/0020-layer-2-encrypted-r2-backups-with-operator-loaded-drills.md)); a run that cannot encrypt fails and uploads nothing.
- **AC-345** `[crit]`: Every step of a backup or drill run is bounded in time; a step exceeding its bound fails the run, and the status record names the step and why — the container log does, when that step is the status write itself. The status-mirror write is the exception: exceeding its bound fails only that write ([AC-618](#1522-backup-and-recovery)).
- **AC-346** `[crit]`: If a tool a backup or drill run drives exits before taking all its input, the run fails with the reason recorded, and later scheduled runs still start.
- **AC-619** `[crit]`: When a drill runs with the operator's private identity loaded, the system restores the latest uploaded backup from the off-site store and records in the drill fields whether it matches its manifest.
- **AC-168** `[crit]`: While the operator's private identity is not loaded, a drill is skipped and leaves the status record unchanged; a skip is not a failure.
- **AC-370** `[crit]`: A backup run changes only the backup fields of the status record and a drill only the drill fields, plus `mirrorError` and `updatedAt`.
- **AC-617** `[crit]`: When a backup or drill run records its outcome, the system then rewrites the status mirror to match.
- **AC-618** `[crit]`: If writing the status mirror fails, the system records that failure in `mirrorError` and leaves the run's outcome and error field unchanged.
- **AC-622** `[crit]`: When writing the status mirror succeeds, the system clears `mirrorError`.
- **AC-620** `[crit]`: The status record carries no credential.
- **AC-614** `[crit]`: The system discloses the status record to no caller except an owner.
- **AC-612** `[crit]`: While an owner is signed in, the system shows on every view the backup badge in the first state of the badge table ([ui/index.md §8.1.2](ui/index.md#812-authenticated-state)) whose condition holds.
- **AC-621** `[crit]`: If the last drill failed, the backup badge shows red.
- **AC-615** `[crit]`: While an owner's view is visible, the system refreshes the backup badge from the status record at least once a minute.
- **AC-613** `[vis]`: The system shows no backup badge on the sign-in screen or to a non-owner.
- **AC-173** `[infra]`: The off-site store keeps every backup for the retention window and protects it from deletion and overwrite for the lock window, and deletes it after the retention window ([ADR-0020 §Retention](../adr/0020-layer-2-encrypted-r2-backups-with-operator-loaded-drills.md#retention)).
- **AC-175** `[infra]`: The operator's private identity never reaches the server's disk; a loaded identity is gone after a restart ([ADR-0020](../adr/0020-layer-2-encrypted-r2-backups-with-operator-loaded-drills.md)).
- **AC-368** `[infra]`: When the operator restores a backup, then before the system serves again, every attachment the restored backup has no row for, or holds as pending, is recovered where readable ([AC-441](#1526-attachments)), and no invoice number issued since the backup can be issued again ([data-model.md §6.13](data-model.md#613-gapless-sequence-allocation)); an unreadable attachment is recorded and does not block serving.

### 15.23 Audit Log

The record of changes to audited entities; design in [ADR-0021](../adr/0021-audit-log-and-notifications-single-write-path.md). What an entry holds: [data-model.md §5.10](data-model.md#510-audit-log-entity). Surfaces: the project activity feed ([ui/workflow-views.md §8.4.1](ui/workflow-views.md#841-activity-feed)), the Aktivität view ([ui/management.md §8.13](ui/management.md#813-audit-view)) and the activity dock ([§15.32](#1532-activity-dock)).

- **AC-623** `[crit]`: When a change to an audited entity takes effect, the system records exactly one audit entry for it; a change that does not take effect records none. Not recorded per entity: sign-ins and sessions ([ADR-0021](../adr/0021-audit-log-and-notifications-single-write-path.md)), self-preference changes ([AC-659](#1524-notifications)), uploads that never complete ([AC-407](#1526-attachments)), entities removed with a purged project (its purge entry covers them), seed data ([data-model.md §7](data-model.md#7-seed-data-specification)) and a data import, which records one entry per job ([AC-332](#1514-data-exchange)).
- **AC-624** `[crit]`: Each audit entry names who made the change: the signed-in user who made it, or the system with a non-empty reason for a change no user made directly — including the end of an export or import job ([AC-332](#1514-data-exchange)).
- **AC-630** `[crit]`: When a change updates fields, its audit entry records each updated field's value before and after the change, except passwords and encryption keys ([AC-240](#1526-attachments)).
- **AC-188** `[crit]`: An audit entry keeps the entity label it was recorded with; a later rename, deletion or purge of the entity leaves it unchanged.
- **AC-642** `[crit]`: No caller can change or delete an audit entry, except that deleting a user removes the entry's link to that user ([AC-567](#1513-user-management)); entries leave only through retention ([AC-632](#1523-audit-log)).
- **AC-632** `[crit]`: When a retention run executes, the system removes every audit entry older than the retention window **[C]** ([architecture.md §12.2](architecture.md#122-company-configurable-settings)) and records no audit entry for the removal.
- **AC-633** `[crit]`: When a retention run completes, the system writes one `audit-retention-cleanup` line to the operational log with the window applied and the number of entries removed.
- **AC-183** `[crit]`: If notifying about a recorded change fails, the change and its audit entry stay recorded, and the system writes an `audit-publisher-handler-error` line naming the entry to the operational log.
- **AC-625** `[crit]`: The system discloses every audit entry to an owner, and every entry except those of [AC-182](#1523-audit-log) to any other caller holding `audit:read`.
- **AC-182** `[crit]`: The system discloses an audit entry for a project purge, a user deletion or a change to a user's roles to no caller except an owner.
- **AC-631** `[vis]`: The project activity feed shows the audit entries of the project and of its worker assignments, attachments and invoices.
- **AC-626** `[vis]`: Every activity surface lists audit entries newest first.
- **AC-627** `[vis]`: When an activity surface has no entry to show, the system shows `Keine Aktivität` — except the Aktivität view while `Alles anzeigen` is off and no filter is set ([AC-662](#1524-notifications)).
- **AC-628** `[vis]`: When a user chooses `Ältere anzeigen`, the system appends the next older page **[C]** ([architecture.md §12.2](architecture.md#122-company-configurable-settings)) below the entries shown.
- **AC-629** `[vis]`: When a user sets valid filters on the Aktivität view, the system shows only the entries matching all of them.
- **AC-186** `[vis]`: The system offers `Details anzeigen` on an entry of the project activity feed or the Aktivität view exactly when the entry carries details ([data-model.md §5.10](data-model.md#510-audit-log-entity) `payload`); it opens in place, without leaving the view.
- **AC-641** `[vis]`: The Aktivität view and the activity dock show, for each entry, the project it belongs to ([data-model.md §5.10](data-model.md#510-audit-log-entity)), or `—` for an entry without one.
- **AC-681** `[vis]`: While the Aktivität view or a project activity feed is open, when an audit entry it would list is recorded, the entry appears in it within 2 seconds, without a manual refresh.

### 15.24 Notifications

Pushes to users' devices, by the notification rules; design in [ADR-0023](../adr/0023-notification-rules-db-stored-closed-event-catalog.md). Rules and event classes: [data-model.md §5.11](data-model.md#511-notification-rule). Who may manage rules: [api.md §14.3](api.md#143-authorization-rules). Screens: [ui/management.md §8.14](ui/management.md#814-notification-rules-view), the user menu ([ui/index.md §8.7.2](ui/index.md#872-user-menu)).

Rules and recipients:

- **AC-190** `[crit]`: If a rule save breaks a rule constraint ([data-model.md §5.11](data-model.md#511-notification-rule)), the system refuses it as a validation error ([api.md §14.4.1](api.md#1441-error-categories)) and changes nothing.
- **AC-643** `[crit]`: When the change a project event class names ([data-model.md §5.11](data-model.md#511-notification-rule)) takes effect, the system fires one event of that class.
- **AC-192** `[crit]`: The recipients of an event are the active users named by an enabled rule for its class — a rule whose `Ziel-Status`, if set, is the project's new status — each user once.
- **AC-644** `[crit]`: When a rule change takes effect, the system applies it to every event fired afterwards.
- **AC-203** `[crit]`: If a rule names a user who is deactivated or deleted, the system still pushes to the rule's other recipients and leaves the rule unchanged.
- **AC-393** `[crit]`: When a rule is created, changed or deleted, the system records no audit entry ([ADR-0023](../adr/0023-notification-rules-db-stored-closed-event-catalog.md)).

Pushes:

- **AC-645** `[crit]`: When an event fires, the system pushes it to every device its recipients registered, except where [AC-195](#1524-notifications) or [AC-321](#1524-notifications) rules it out.
- **AC-646** `[crit]`: Under standard circumstances — every push service answering — the system sends an event's pushes within 5 seconds of the event firing ([kickoff](../project/kickoff.md): delivered instantaneously).
- **AC-195** `[crit]`: While a user has push muted, the system pushes nothing to their devices; the devices stay registered, and the user stays a recipient ([AC-192](#1524-notifications)).
- **AC-321** `[crit]`: The system pushes no event to the user who caused it; that user stays a recipient ([AC-192](#1524-notifications)).
- **AC-647** `[crit]`: If pushing to one device fails, the system still pushes to the other devices.
- **AC-648** `[crit]`: A push's title is the label of its event class ([data-model.md §5.11](data-model.md#511-notification-rule)).
- **AC-649** `[crit]`: A push about a project event names the project as it was named when the event fired; for a status move it adds the new status, for an upload that a file was added.
- **AC-650** `[crit]`: A `backup.failed` push says what the backup badge says for its reason ([ui/index.md §8.1.2](ui/index.md#812-authenticated-state)).
- **AC-651** `[crit]`: A `disk.threshold_reached` push reads `Speicher zu N% belegt.`, N being the fill percentage, rounded.
- **AC-652** `[crit]`: When a user opens a push, the system opens the project's page for a project event, the Daten view for `disk.threshold_reached`, and the Kanban view for `backup.failed` ([ui/index.md §8.7.1](ui/index.md#871-views); a view the user may not access: [AC-149](#1521-role-scoping)).
- **AC-371** `[crit]`: The system records no audit entry for a `backup.failed` or `disk.threshold_reached` event, so it shows on no activity surface ([ADR-0021](../adr/0021-audit-log-and-notifications-single-write-path.md)).

Devices:

- **AC-201** `[vis]`: The system asks the browser for push permission only when the user activates `Push-Benachrichtigungen aktivieren`.
- **AC-674** `[crit]`: When a user activates `Push-Benachrichtigungen aktivieren` and the browser grants permission, the system registers the device for the user.
- **AC-653** `[vis]`: If registering the device fails, the system shows a message naming the failure — e.g. `Anmeldung für Push-Benachrichtigungen fehlgeschlagen.` or `Push-Benachrichtigungen sind auf diesem Server nicht konfiguriert.` — and keeps offering `Push-Benachrichtigungen aktivieren`.
- **AC-675** `[crit]`: When a user activates `Gerät abmelden`, the system stops pushing to that device; the user's other devices stay registered.
- **AC-673** `[vis]`: If removing the device's registration fails, the system shows an error message and keeps offering `Gerät abmelden`.
- **AC-654** `[crit]`: No caller can register or remove a device's registration on another user's behalf; registering a device another user holds moves it to the caller ([AC-656](#1524-notifications)).
- **AC-655** `[crit]`: When a user signs out on a device, the system stops pushing to that device.
- **AC-677** `[crit]`: When a user's session expires, their devices stay registered.
- **AC-676** `[crit]`: When a user changes their own password, the system removes the registrations of that user's other devices ([AC-549](#154-authentication)).
- **AC-678** `[crit]`: When an owner resets a user's password, the system removes the registrations of all that user's devices ([AC-557](#1513-user-management)).
- **AC-656** `[crit]`: A device receives the pushes of only the user who registered it last.
- **AC-679** `[crit]`: When a user signs in on a device that is not registered for them, the system stops pushing to the device and offers `Push-Benachrichtigungen aktivieren`.
- **AC-657** `[crit]`: When a user is deleted, the system removes their devices' registrations.
- **AC-658** `[vis]`: The `Stummschalten` toggle shows and sets the user's push mute ([AC-195](#1524-notifications)), the same on every device they sign in on.
- **AC-659** `[crit]`: When a user changes their own theme or push mute, the system records no audit entry ([ADR-0021](../adr/0021-audit-log-and-notifications-single-write-path.md)).

Screens:

- **AC-199** `[vis]`: The rule form offers `Ziel-Status` only for a status-move class, and `Zugewiesene Mitarbeiter benachrichtigen` only for a project class ([data-model.md §5.11](data-model.md#511-notification-rule)).
- **AC-660** `[vis]`: While `Alles anzeigen` is off, the Aktivität view lists only the entries whose events, under the rules and assignments as they are now, have the user among their recipients ([AC-192](#1524-notifications)).
- **AC-672** `[vis]`: While `Alles anzeigen` is on, the Aktivität view lists every entry disclosed to the user ([AC-625](#1523-audit-log)).
- **AC-661** `[vis]`: When a user opens the Aktivität view, `Alles anzeigen` is off.
- **AC-662** `[vis]`: If the Aktivität view has no entry to show while `Alles anzeigen` is off and no filter is set, the system shows `Keine Benachrichtigungen für Sie. Alles anzeigen für den vollständigen Aktivitätsverlauf.`

### 15.26 Attachments

Per-project file attachments. Fields and their constraints: [data-model.md §5.13](data-model.md#513-attachment). Who may do what: [api.md §14.3](api.md#143-authorization-rules). `[C]` values: [architecture.md §12.2](architecture.md#122-company-configurable-settings). Screens: [ui/project-detail.md §8.15](ui/project-detail.md#815-project-detail-page).

Upload:

- **AC-397** `[crit]`: When a user uploads a file to a project, the system records one attachment with its file name, type, size, label, uploader and upload time.
- **AC-398** `[crit]`: If an upload violates an attachment field constraint ([data-model.md §5.13](data-model.md#513-attachment)), the system rejects it as a validation error and records nothing.
- **AC-399** `[crit]`: If an upload's stored object differs from what the system issued or the client declared — storage key, size, content digest or object metadata — object storage rejects it.
- **AC-400** `[crit]`: The system persists each of an attachment's encryption keys only wrapped for the active binary recipient, never for a retired one ([ADR-0024](../adr/0024-binary-attachment-e2e-encryption.md)).
- **AC-401** `[crit]`: Object storage receives attachment content only encrypted, each object with its own encryption key ([ADR-0024](../adr/0024-binary-attachment-e2e-encryption.md)).
- **AC-402** `[crit]`: If, at completion, a declared object is missing from storage or differs from its declared size, the system rejects the completion as a conflict and the upload stays incomplete.
- **AC-403** `[crit]`: If a completed upload is completed again, the system rejects it as a conflict and changes nothing.
- **AC-404** `[crit]`: When a user uploads a photo, the system stores it re-encoded within the photo encoding parameters **[C]**, with its EXIF metadata (including GPS) kept.
- **AC-405** `[vis]`: If a file exceeds the per-file size cap **[C]** — a photo after re-encoding — the system blocks the upload with `"Datei zu groß"` and offers no retry.
- **AC-406** `[vis]`: If a file's type is outside the whitelist ([data-model.md §5.13](data-model.md#513-attachment)), the system blocks the upload with a German message naming the supported types.
- **AC-407** `[crit]`: If an upload never completes, the system records no audit entry for it.
- **AC-408** `[crit]`: If an upload stays incomplete longer than the orphan-reaper TTL **[C]**, the system deletes it and its stored objects.
- **AC-225** `[vis]`: If an upload fails for a transient reason — network, storage, or a conflict at completion — the system shows a German error beside the file and an `Erneut versuchen` action that restarts the upload from the beginning; it never retries on its own.
- **AC-446** `[vis]`: The document upload's label control offers exactly the label set except `foto` ([data-model.md §5.13](data-model.md#513-attachment)), with German names **[C]**, and accepts no free text.

Access and download:

- **AC-409** `[crit]`: The attachment lists show the project's complete, non-hidden attachments, newest first.
- **AC-337** `[crit]`: When a project's attachments change, every open view showing its attachment lists or its Papierkorb shows the change within 2 seconds, without a reload.
- **AC-410** `[crit]`: If a worker requests an attachment operation on a project they are not assigned to, the system rejects it as an authorization error, as for the project itself ([AC-581](#1521-role-scoping)).
- **AC-411** `[crit]`: If a worker hides an attachment they did not upload, or after the self-delete grace window **[C]**, the system rejects it as an authorization error.
- **AC-412** `[crit]`: If a user uploads or hides an attachment on an archived project, the system rejects it as not found (as [AC-499](#1512-projects)).
- **AC-413** `[crit]`: If a download requests an attachment that is incomplete or hidden, the system rejects it as not found.
- **AC-414** `[crit]`: If a bulk download includes an attachment that is incomplete, hidden or of another project, the system rejects the whole request as a validation error.
- **AC-415** `[crit]`: If a bulk download exceeds a bulk-download cap **[C]** — file count or summed size — the system rejects the whole request as a validation error.
- **AC-416** `[crit]`: When a user views or downloads an attachment, the system delivers its content as uploaded.
- **AC-417** `[vis]`: When a user downloads an attachment, the system saves it under its file name.
- **AC-418** `[crit]`: If stored content was altered, the system refuses to deliver it ([ADR-0024](../adr/0024-binary-attachment-e2e-encryption.md)).
- **AC-433** `[vis]`: When a user downloads a selection as ZIP, the system delivers one archive of the selected files' content as uploaded.
- **AC-434** `[vis]`: If a ZIP selection holds files whose names differ at most in letter case, the archive keeps each file under a name distinct ignoring letter case.
- **AC-435** `[vis]`: If a ZIP selection exceeds a bulk-download cap **[C]**, the system blocks it before download and shows a German message naming both caps.
- **AC-436** `[vis]`: If an attachment's stored content is missing, the system shows it as `"Datei fehlt"` with a placeholder, disables download, ZIP selection and lightbox, and keeps the attachment.
- **AC-244** `[vis]`: If an attachment's encryption key cannot be unwrapped, the system shows it as `"Schlüssel nicht verfügbar"` with a placeholder, disables download, ZIP selection and lightbox, and keeps the attachment.
- **AC-437** `[vis]`: If loading an attachment fails for another reason, the system shows `"Datei konnte nicht geladen werden"` and keeps download and delete available.

Papierkorb:

- **AC-419** `[crit]`: When a user hides an attachment, the system moves it to the project's Papierkorb and hides its stored objects ([ADR-0022](../adr/0022-binary-storage-b2-compliance-object-lock.md)).
- **AC-420** `[crit]`: If hiding the stored objects fails, the system leaves the attachment in place, records nothing and reports a server error.
- **AC-421** `[crit]`: The Papierkorb lists the project's hidden attachments, most recently hidden first.
- **AC-422** `[crit]`: When a user restores an attachment, the system makes it and its stored content available again, unchanged.
- **AC-423** `[crit]`: If restoring the stored content fails, the system leaves the attachment in the Papierkorb, records nothing and reports a server error.
- **AC-424** `[crit]`: If the hidden content is no longer recoverable from storage, the system rejects the restore as gone and changes nothing.
- **AC-425** `[crit]`: While a project is archived, the system still lists and restores its Papierkorb.
- **AC-426** `[crit]`: If an attachment stays hidden longer than the hidden-reaper TTL **[C]**, the system deletes it permanently.

Audit, project lifecycle, export:

- **AC-427** `[crit]`: Each upload completion, hide, restore and hidden-reaper purge records exactly one audit entry with its action from the vocabulary ([data-model.md §5.10](data-model.md#510-audit-log-entity)), linked to the project.
- **AC-240** `[crit]`: The audit log never contains any of an attachment's wrapped encryption keys ([ADR-0024](../adr/0024-binary-attachment-e2e-encryption.md)).
- **AC-428** `[crit]`: When a project is purged, the system deletes its attachments and hides their stored objects ([ADR-0022](../adr/0022-binary-storage-b2-compliance-object-lock.md)).
- **AC-429** `[crit]`: If hiding a stored object fails during a project purge, the system completes the purge anyway.
- **AC-430** `[crit]`: When a project is archived, its attachments stay unchanged.
- **AC-431** `[crit]`: An export includes every complete, non-hidden attachment (fields per [data-model.md §5.8](data-model.md#58-export-archive)) and no incomplete or hidden one.
- **AC-432** `[crit]`: The export preflight ([ui/daten.md §8.11.1](ui/daten.md#8111-export)) states that the Papierkorb is not exported, and the restore confirmation ([§8.11.2](ui/daten.md#8112-import)) states that a full-account restore (import) deletes it.

Storage safety and recovery:

- **AC-236** `[crit]`: If the bucket is not exactly the [ADR-0022](../adr/0022-binary-storage-b2-compliance-object-lock.md) shape — versioning on; Compliance lock with default retention `R` ≥ 1 day **[C]**; exactly one lifecycle rule, bucket-wide, whose only action deletes hidden versions after `L` days **[C]**; `R ≤ L` — the system refuses to start.
- **AC-237** `[crit]`: If the storage credential can destroy object versions, or the provider's answer doesn't prove it can't, the system refuses to start ([ADR-0022](../adr/0022-binary-storage-b2-compliance-object-lock.md)).
- **AC-438** `[crit]`: If the binary keyring is absent, unreadable, malformed, or its identities don't match the configured recipients — the active one plus each listed retired one, none missing, none extra — the system refuses to start and logs which check failed ([ADR-0024](../adr/0024-binary-attachment-e2e-encryption.md)).
- **AC-439** `[crit]`: Every object the system writes outside the deploy-probe namespace ([data-model.md §5.13](data-model.md#513-attachment)) decrypts with the binary keyring alone, without its database row ([ADR-0024](../adr/0024-binary-attachment-e2e-encryption.md)).
- **AC-440** `[crit]`: Every rendered invoice PDF object names its invoice number, readable without the database ([ADR-0024](../adr/0024-binary-attachment-e2e-encryption.md)).
- **AC-441** `[crit]`: When the operator runs the recovery tool with only the binary keyring, storage credentials and a cutoff time — no database — it writes the plaintext of every object version written since the cutoff outside the deploy-probe namespace, hidden versions and objects no attachment refers to included, and reads no older version.
- **AC-442** `[crit]`: When given an object key, the recovery tool processes only that key's versions, still bounded by the cutoff.
- **AC-443** `[crit]`: The recovery tool's index lists every version it processed with its object key, version id, write time and outcome, plus the invoice number when the object names one.
- **AC-444** `[crit]`: If a version does not decrypt and authenticate with the binary keyring alone, the recovery tool lists it as failed, writes no plaintext for it, continues, and exits non-zero.
- **AC-445** `[infra]`: The binary keyring is never persisted to disk on the VPS; it is loaded only into tmpfs ([ADR-0024](../adr/0024-binary-attachment-e2e-encryption.md)).
- **AC-517** `[crit]`: After a key rotation, every attachment written under a listed retired key still opens and downloads, singly and in a ZIP selection, and is included in the full-account export; every invoice PDF written under one still downloads and is included in the invoice bulk export and the full-account export ([ADR-0024](../adr/0024-binary-attachment-e2e-encryption.md)).
- **AC-374** `[infra]`: The recovery tool runs with a dedicated read-only storage credential — list and read, no write or hide.

### 15.27 Configuration and Feature Manifest

- **AC-228** `[infra]`: Application code reads configuration values only through the configuration boundary's loader ([architecture.md §12.6](architecture.md#126-feature-manifest-and-operator-confidence)). Direct reads from the process environment outside the loader are rejected by a CI repo scan; each documented allowlist entry carries an inline reason.
- **AC-229** `[infra]`: The configuration schema's keyspace and the operator-facing example documentation are kept in sync. CI fails when a schema field is missing from the example documentation, or vice versa, naming every divergent key. Documented exclusions for infrastructure-only variables (consumed by container orchestration, not application code) are listed in the check itself.
- **AC-230** `[crit]`: Each application start emits exactly one structured log line at `info` level with `event = 'config-feature-manifest'` enumerating every feature in the declared catalog ([architecture.md §12.6](architecture.md#126-feature-manifest-and-operator-confidence)) with `state ∈ {enabled, disabled}` and a non-empty `reason` naming the missing required value(s) when `disabled`. Each feature's state is computed from the same catalog entry that gates its runtime activation — the manifest cannot report a state that contradicts the wiring.
- **AC-231** `[infra]`: The deploy script validates the loaded configuration against the schema before bringing containers up. A validation failure aborts with a non-zero exit code and a message naming every offending key; no containers are recreated.

### 15.28 Realtime Events

Live refresh, while a view's realtime event connection is up: [AC-277](#1512-projects), [AC-681](#1523-audit-log), [AC-337](#1526-attachments), [AC-450](#1529-storage-usage), [AC-317](#1532-activity-dock), [AC-602](#1514-data-exchange), [AC-608](#1514-data-exchange). After a lost connection: AC-682. Design: [ADR-0025](../adr/0025-realtime-ui-invalidation-via-sse.md).

- **AC-680** `[crit]`: Realtime events carry only the kind of data that changed, never the data itself ([ADR-0025](../adr/0025-realtime-ui-invalidation-via-sse.md)).
- **AC-682** `[crit]`: While an open view's session is valid, if the view lost its realtime event connection, it shows current data within 30 seconds of the server being reachable again, without a reload.
- **AC-275** `[crit]`: When a session ends ([data-model.md §5.4](data-model.md#54-session)), the system closes that session's realtime event connections within one heartbeat interval **[C]** ([architecture.md §12.2](architecture.md#122-company-configurable-settings)).

### 15.29 Storage Usage

Totals: [data-model.md §5.14](data-model.md#514-storage-usage). What the screens show: [ui/daten.md §8.11.3](ui/daten.md#8113-speichernutzung), [ui/index.md §8.1.2](ui/index.md#812-authenticated-state). Who may read them: [api.md §14.3](api.md#143-authorization-rules).

- **AC-447** `[crit]`: Each storage total equals, at every read, its [data-model.md §5.14](data-model.md#514-storage-usage) sum over the attachments of every project, archived ones included.
- **AC-448** `[vis]`: While a user holding `data:export` is signed in, the footer shows "Daten:" followed by the visible total; otherwise it shows no storage badge.
- **AC-449** `[vis]`: When the user hovers the footer storage badge, it shows the visible and Papierkorb totals with their [ui/daten.md §8.11.3](ui/daten.md#8113-speichernutzung) labels.
- **AC-450** `[crit]`: When a storage total changes, every open session showing it shows the new value within 2 seconds, without a reload.
- **AC-451** `[vis]`: The storage totals and the Export and Import progress byte counts are shown in powers of 1024: B and KB as whole numbers, MB and GB with two decimals after a decimal comma ("1,50 MB").

### 15.30 Invoices

Criteria for the invoice domain ([data-model.md §5.15](data-model.md#515-invoice-entity), [data-model.md §5.16](data-model.md#516-invoice-sequence-entity), [api.md §14.2.14](api.md#14214-invoice-operations), [architecture.md §11.14](architecture.md#1114-invoice-domain), [ADR-0026](../adr/0026-invoices-immutability-and-zugferd.md)).

- **AC-285** `[crit]`: `POST /api/invoices` creates exactly one `Invoice` row with `status = 'draft'`, `number` null, `issueDate` null, `renderedPdfBinaryDescriptorId` null. The row's `projectId` is FK-bound to the supplied project; `taxMode` defaults to the live `company_profile.defaultTaxMode` when not supplied; each `recipient` field not supplied is pre-filled from the project's current customer. The endpoint requires `invoice:write`; callers without it receive `403 NOT_PERMITTED`. A draft on an archived project is rejected with `404 NOT_FOUND` (mirrors [AC-499](#1512-projects)). The mutation produces one `audit_log` row via `mutate()` with `entityType = 'invoice'`, `action = 'create'`, belonging to the project ([AC-623](#1523-audit-log), [AC-631](#1523-audit-log)).
- **AC-286** `[crit]`: `PATCH /api/invoices/:id` on a `status = 'draft'` row updates the specified fields (PATCH semantics — omitted fields unchanged); `totals` is re-derived server-side on every successful PATCH from `lines` + `taxMode`. `PATCH` on a row whose `status` is `'issued'` or `'cancelled'` is rejected with `422 VALIDATION_ERROR` and `code = INVOICE_FROZEN`; no field is mutated, no audit row is written. `DELETE /api/invoices/:id` on a `status = 'draft'` row hard-deletes the row; on a non-draft row it is rejected with `INVOICE_FROZEN`. Both mutations require `invoice:write`.
- **AC-543** `[crit]`: After a customer edit changes `name`, `address` or `ustId`, each draft on the customer's projects, archived ones included, holds the new value of each such field where it held the customer's previous value, and keeps every other value ([data-model.md §5.15](data-model.md#515-invoice-entity)). Issuing such a draft freezes the values it holds. Issued and cancelled invoices are unchanged.
- **AC-544** `[crit]`: A customer edit and the draft writes it causes per [AC-543](#1530-invoices) commit in one transaction: if any of them fails, the customer and all its drafts stay unchanged and the edit is rejected. Each changed draft gets a new `version`, the editing user as `updatedBy`, and exactly one `audit_log` row (`entityType = 'invoice'`, `action = 'update'`, the editing user as actor, belonging to the project) carrying its previous and new recipient; an unchanged draft gets neither. Post-commit, exactly one `invoice_changed` SSE event is sent if any draft changed, none otherwise.
- **AC-545** `[crit]`: For a draft created while a customer edit is uncommitted, each `recipient` field not supplied holds the customer's committed value: the edited one if the edit commits, the prior one if it rolls back.
- **AC-546** `[crit]`: The draft write of [AC-543](#1530-invoices) serializes with Update, Delete and Issue on the same draft ([data-model.md §6.4](data-model.md#64-concurrency)). An override committed before it stays; a draft deleted or issued before it is untouched; an Update, Delete or Issue carrying the draft's pre-correction version is rejected with `VERSION_CONFLICT`.
- **AC-287** `[crit]`: `POST /api/invoices/:id/issue` runs the issuance transaction ([architecture.md §11.14](architecture.md#1114-invoice-domain)) inside one DB transaction: allocates `number` from `invoice_sequence` via an atomic `INSERT … ON CONFLICT … DO UPDATE … RETURNING next_value` on `(year, 'invoice')` (row-exclusive lock equivalent to `SELECT FOR UPDATE`), snapshots `issuer` / `recipient` / `lines` / `taxMode` / `profile` onto the row, computes `totals` server-side, renders the PDF/A-3 + factur-x.xml, writes the binary descriptor, flips the parent project's `status` to `abgerechnet`, writes exactly one `audit_log` row with `action = 'invoice:issue'` and exactly one `audit_log` row with `entityType = 'project'`, `action = 'transition:forward'` (`rechnung_faellig → abgerechnet`), and commits. A project no longer in `rechnung_faellig` at the flip — moved by a transition committed while the issuance runs — rejects it with `409 INVOICE_PROJECT_STATE`. A failure at any step rolls back the entire transaction — the sequence increment never persists (gapless property), no descriptor row persists, the issuance leaves the project status unchanged, and the draft remains editable. Post-commit, exactly one `invoice_changed` SSE event AND one `project_changed` SSE event reach subscribed `/api/events` connections (the project status changed, so both consumer surfaces must invalidate). Requires `invoice:write`.
- **AC-288** `[crit]`: Two concurrent issue calls on two distinct drafts within the same calendar year produce two invoices with sequential, gapless `number` values from the `(year, 'invoice')` sequence — never duplicates, never gaps. An issue call whose transaction rolls back after sequence allocation (render failure, binary write failure, project-status flip failure) returns the value to the sequence: a subsequent successful issue allocates the same value. Verified by an integration test driving the rollback path and asserting the next successful issue receives the rolled-back value.
- **AC-289** `[crit]`: `POST /api/invoices/:id/issue` rejects the call when the parent project's `status` is not `rechnung_faellig` with `409 CONFLICT` and `code = INVOICE_PROJECT_STATE`; no state change; no `audit_log` row; no SSE event. `POST /api/invoices/:id/issue` rejects with `422 VALIDATION_ERROR` when any of the following pre-issuance requirements is unmet: `performanceDate` is null, `lines` is empty, `recipient.name` is empty, `recipient.address.street` / `recipient.address.zip` / `recipient.address.city` (all three required per §14 UStG) is empty, or — when `taxMode = 'reverse_charge'` — `recipient.ustId` is empty. `POST /api/invoices/:id/issue` rejects when the `company_profile` singleton lacks a required field per [AC-305](#1531-company-profile). None of these failures persist a number allocation — the row-exclusive lock either is never acquired (pre-validation) or releases without an increment (validation inside the transaction).
- **AC-290** `[crit]`: `POST /api/invoices/:id/cancel` on a `status = 'issued'` row creates a new sibling row with `cancellationOf = <original.id>`, `number` allocated as `ST-YYYY-NNNN` from `invoice_sequence` `(year, 'storno')`, `lines` carrying sign-flipped `unitPrice` and `lineTotal`, `totals` the exact negation of the original's `totals`, `issuer` / `recipient` / `taxMode` / `profile` / `performanceDate` snapshotted from the original, optional `cancellationReason` from the request body. The original row's `status` flips to `'cancelled'`; all other fields on the original are unchanged (write-once at the persistence layer — [AC-294](#1530-invoices)). Both rows persist forever. Exactly two `audit_log` rows are written inside the same transaction (`invoice:cancel` on the original, `invoice:issue` on the Storno). The parent project's `status` is **not** modified. Post-commit, exactly one `invoice_changed` SSE event reaches subscribers. Requires `invoice:write`.
- **AC-291** `[crit]`: `POST /api/invoices/:id/cancel` on a `status = 'draft'` row is rejected with `409 CONFLICT` and `code = INVOICE_NOT_ISSUED`. `POST /api/invoices/:id/cancel` on a `status = 'cancelled'` row is rejected with `409 CONFLICT` and `code = INVOICE_ALREADY_CANCELLED`. Neither rejection persists a number allocation, an audit row, or an SSE event.
- **AC-292** `[crit]`: A rendered invoice carries the boilerplate of its snapshotted `taxMode` ([architecture.md §11.14](architecture.md#1114-invoice-domain)): `'standard'` renders per-line VAT columns plus the per-rate breakdown in totals; `'reverse_charge'` omits VAT on lines and includes the §13b boilerplate of [architecture.md §11.14](architecture.md#1114-invoice-domain). Verified by an integration test that issues one invoice under each mode against the same draft template: the rendered PDF/A-3's extractable text of the `reverse_charge` invoice contains the §13b boilerplate, the `standard` one does not.
- **AC-293** `[crit]`: An issued invoice's `profile` is `'zugferd-en16931'` (v1 — only valid value) and the rendered binary is a PDF/A-3 carrying an embedded `factur-x.xml` (EN 16931 Comfort profile). It validates against the EN 16931 schema (XSD) on every render; a failing check aborts the issue / cancel transaction ([architecture.md §11.14](architecture.md#1114-invoice-domain)). For the supported cases ([ADR-0026 § Compliance boundary](../adr/0026-invoices-immutability-and-zugferd.md#compliance-boundary)) it passes the EN 16931 CII business rules, verified in tests, not per render ([ADR-0026 §E-invoice format](../adr/0026-invoices-immutability-and-zugferd.md#e-invoice-format)). Amounts follow [data-model.md §5.15](data-model.md#515-invoice-entity) _Signed amounts_: a Storno's XML amounts equal its original's. `profile` is snapshotted at issuance from the company-wide profile selection (v1: always `'zugferd-en16931'`); a future profile addition (e.g. `'xrechnung'`) lands by extending the renderer dispatch without schema migration ([ADR-0026 §E-invoice format](../adr/0026-invoices-immutability-and-zugferd.md#e-invoice-format)).
- **AC-294** `[crit]`: A direct `UPDATE` against an `invoices` row whose `status` is `'issued'` (touching any column other than the cancellation-flip path on `status`) is rejected. The application API never reaches this rejection — the route layer returns `INVOICE_FROZEN` first ([AC-286](#1530-invoices)) — but the persistence layer is the defense-in-depth backstop on direct DB writes that bypass the route layer (seed scripts, migrations, manual SQL). Mechanism is implementation-defined (a trigger, a column-level constraint, or a service-layer invariant exercised by direct-DB integration tests). Mirrors the project-status integrity posture in [AC-96](#1517-data-integrity).
- **AC-295** `[crit]`: A direct INSERT into `invoices` with a `number` that violates the regex `^(RE|ST)-\d{4}-\d{4,}$` (e.g. `RE-2026-1`, `re-2026-0001`, `RE-26-0001`, `XX-2026-0001`) is rejected by the database CHECK constraint. The application API never produces such a number — the issuance service formats from `invoice_sequence` directly — but the CHECK is the defense-in-depth backstop. Mirrors [AC-96](#1517-data-integrity) for project status.
- **AC-296** `[crit]`: Every rendered invoice PDF/A-3 — written at issuance or cancellation, or restored by the full-account import job — is stored with a Compliance-mode Object Lock retaining it until at least write time + `INVOICE_OBJECT_LOCK_DAYS` ([architecture.md §11.14](architecture.md#1114-invoice-domain), [§12.2](architecture.md#122-company-configurable-settings)). `INVOICE_OBJECT_LOCK_DAYS = 0` writes no per-object lock. The bucket-safety probe ([AC-236](#1526-attachments)) places no invoice requirement on the bucket-default retention: a bucket with `R = 1`, `L = 2` passes with `INVOICE_OBJECT_LOCK_DAYS = 3650`.
- **AC-299** `[crit]`: `GET /api/invoices/:id/pdf` returns the rendered PDF/A-3 + factur-x.xml for `status ∈ {'issued', 'cancelled'}` (or, per the implementation-defined transport in [api.md §14.2.14](api.md#14214-invoice-operations), enough information for the client to fetch and decrypt the rendered bytes through the synthetic-origin Service Worker path). A call on a `status = 'draft'` row is rejected with `409 CONFLICT` and `code = INVOICE_NOT_ISSUED`. Callers without `invoice:read` are refused ([AC-576](#1521-role-scoping)).
- **AC-364** `[crit]`: A rendered invoice PDF is not addressable through the attachment surface ([§15.26](#1526-attachments)). It is absent from the project's attachment list and trash listing. Delete, Restore, Complete, and Get download URL on its descriptor id return `404 NOT_FOUND` and change nothing — the row keeps its `status`, no audit row is written, the object is not hidden. Bulk fetch including its id is rejected `422 VALIDATION_ERROR`. `GET /api/invoices/:id/pdf` still returns the bytes.
- **AC-384** `[crit]`: `POST /api/invoices` and `PATCH /api/invoices/:id` store every line with `lineTotal = quantity × unitPrice`, computed on the decimal values and rounded half away from zero to 2 decimals ([data-model.md §5.15](data-model.md#515-invoice-entity)); a client-supplied `lineTotal` is rejected per AC-516. A write whose derived `lineTotal` or `totals` amount is not a finite number, or with a line `unitPrice` of more than 4 decimals, or that leaves the draft with a line whose `taxRate` is not a §5.15 rate for the draft's `taxMode`, is rejected with `422 VALIDATION_ERROR`. The rendered PDF and `factur-x.xml` carry each line's `quantity` and `unitPrice` without rounding (XML sign per [data-model.md §5.15](data-model.md#515-invoice-entity)). Issue never freezes a line without a positive `quantity`, a finite `unitPrice` and a §5.15 `taxRate` for the draft's `taxMode`, a line that breaks the equality or the 4-decimal limit, nor totals that are not finite: `POST /api/invoices/:id/issue` on such a draft is rejected with `422 VALIDATION_ERROR`: no number is allocated, the draft is unchanged, no `audit_log` row and no SSE event.
- **AC-513** `[crit]`: If a user edits, deletes, issues or cancels an invoice of an archived project, the system refuses it as not found ([api.md §14.4.1](api.md#1441-error-categories)) and changes nothing.
- **AC-514** `[vis]`: While an invoice's project is archived, the invoice list and the invoice viewer ([ui/invoices.md §8.16](ui/invoices.md#816-invoices-view)) offer no change to that invoice.

### 15.31 Company Profile

Criteria for the singleton company-profile row ([data-model.md §5.17](data-model.md#517-company-profile-entity), [api.md §14.2.15](api.md#14215-company-profile-operations)).

- **AC-300** `[crit]`: The `company_profile` table carries exactly one row, enforced by a CHECK on a constant primary key. The row is pre-seeded by the baseline migration with empty mandatory fields. A direct INSERT of a second row is rejected by the CHECK constraint. A direct DELETE of the row is rejected. The application API exposes no path to create or delete — only `GET` + `PUT` (upsert) per [api.md §14.2.15](api.md#14215-company-profile-operations).
- **AC-302** `[crit]`: A successful `PUT /api/company-profile` produces exactly one `audit_log` row via the single-write-path helper ([AC-623](#1523-audit-log)) with `actorKind = 'user'`, `entityType = 'company_profile'`, `action = 'update'`, `entityId` matching the singleton row's id, belonging to no project. `payload.before` reflects the row state read inside the mutation's transaction before the write; `payload.after` carries the values that landed.
- **AC-303** `[crit]`: `PUT /api/company-profile` rejects a body with `companyName`, `address.street` / `address.zip` / `address.city`, `taxId` or `ustId` empty, null or missing with `422 VALIDATION_ERROR`. `details` names every offending field path. No partial mutation persists.
- **AC-304** `[crit]`: At invoice issuance, the snapshot of `Invoice.issuer` is **taken from the `company_profile` row at the moment the issue transaction reads it**. A subsequent `PUT /api/company-profile` modifying any snapshotted field does not change the issued invoice's `issuer` block — verified by issuing an invoice, mutating the profile (e.g. address change), re-fetching the issued invoice, and asserting `Invoice.issuer.address` equals the snapshot-time value, not the post-mutation value. The rendered binary descriptor on the row continues to point at the bytes produced at issuance; no re-render path is exposed by the spec.
- **AC-305** `[crit]`: Issuing an invoice when the singleton `company_profile` row lacks a required field ([data-model.md §5.17](data-model.md#517-company-profile-entity)) is rejected `422 VALIDATION_ERROR` with `code = COMPANY_PROFILE_REQUIRED` and `details.missingFields` enumerating the missing field paths. The check runs in the issuance transaction, after the sequence allocation lock is acquired but before the increment is committed — a rejection releases the lock without persisting the increment (gapless property is preserved). No `audit_log` row is written for the failed issue.

### 15.32 Activity Dock

The live audit feed in the app shell ([ui/index.md §8.1.2](ui/index.md#812-authenticated-state)).

- **AC-638** `[vis]`: The system shows the activity dock only to callers holding `audit:read`.
- **AC-637** `[vis]`: The activity dock lists the entries the Aktivität view lists while `Alles anzeigen` is on ([AC-672](#1524-notifications)).
- **AC-317** `[vis]`: While the activity dock is expanded, an audit entry recorded in another session appears in it within 2 seconds, without a manual refresh.
- **AC-634** `[vis]`: When a page loads, the system shows the activity dock collapsed.
- **AC-635** `[vis]`: When a user switches views, the activity dock stays expanded or collapsed as it was.
- **AC-636** `[vis]`: While the viewport is at most 768 px wide, the system shows no activity dock.
- **AC-341** `[vis]`: While the Aktivität view is shown, the system shows no activity dock and `Alt+A` does nothing; leaving the view restores the dock as it was.
- **AC-639** `[vis]`: The activity dock shows each entry on one line; a description that does not fit is cut off with an ellipsis.
- **AC-640** `[vis]`: While the activity dock is shown, when a user presses `Alt+A` (`Option+A` on macOS) while focus is not in an editable field, the system expands or collapses the activity dock, and the keystroke has no other effect.

### 15.33 Threshold Monitor

The periodic check that fires the two system events ([data-model.md §5.11](data-model.md#511-notification-rule)). A condition is the backup badge amber or red, with its reason, or storage over the warn band. Its `[C]` values: [architecture.md §12.2](architecture.md#122-company-configurable-settings) (threshold-monitor policy, storage capacity declaration).

- **AC-663** `[crit]`: When a monitor sweep **[C]** finds the backup badge ([AC-612](#1522-backup-and-recovery)) amber or red, the system fires `backup.failed` with the badge's reason, as [AC-665](#1533-threshold-monitor) allows.
- **AC-664** `[crit]`: If a sweep cannot read the backup status, the system fires no `backup.failed` and writes a `threshold_monitor_backup_status_unreachable` line to the operational log.
- **AC-665** `[crit]`: While a condition holds, the system fires its event again at most once per re-notify window **[C]**; a restart may add one more.
- **AC-666** `[crit]`: When a sweep finds the backup badge's reason changed, the system fires `backup.failed`, whatever the re-notify window.
- **AC-667** `[crit]`: When a sweep finds the stored total ([data-model.md §5.14](data-model.md#514-storage-usage)) at or above the warn band **[C]** of the declared capacity **[C]**, the system fires `disk.threshold_reached` with the fill percentage, as [AC-665](#1533-threshold-monitor) allows.
- **AC-668** `[crit]`: If the stored total falls below the warn band but not below the clear line **[C]**, the system treats the storage condition as still holding.
- **AC-669** `[crit]`: While no storage capacity is declared, the system fires no `disk.threshold_reached` and says so once in the operational log at startup.
- **AC-670** `[crit]`: The system refuses no upload for storage reaching the warn band ([kickoff](../project/kickoff.md): cleanup is up to the users).
- **AC-671** `[crit]`: If checking one condition fails, the system still checks the other in the same sweep.

---

## 17. Risks and Mitigations

| Risk                                               | Impact                             | Mitigation                                                                                                                                                    |
| -------------------------------------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 9 Kanban columns too tight on screen               | Usability                          | Horizontal scroll; responsive collapse tiers ([AC-470](#151-workflow-board)).                                                                                 |
| Over-styling action columns                        | Defeats Kanban principle           | Trust board structure; resist decorative urgency.                                                                                                             |
| API latency makes transitions feel sluggish        | Interaction feels unresponsive     | Optimistic UI updates + sub-300ms API target ([architecture.md §13.2](architecture.md#132-performance)).                                                      |
| Session management edge cases                      | User loses work or sees stale data | Sessions are checked on every API call. Expiry redirects to login cleanly. All mutations are immediate (no local drafts to lose).                             |
| Seed data dates become stale over time             | Demo loses impact                  | Dates are relative to deployment date ([data-model.md §7.5](data-model.md#75-date-range)). A re-seed operation refreshes them.                                |
| Soft-deleted projects consume storage indefinitely | Database growth                    | Archived projects are purged when their customer is deleted ([ADR-0017](../adr/0017-soft-delete-as-board-archive.md)). Customer deletion is the cleanup path. |
